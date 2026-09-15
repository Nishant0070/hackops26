const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

/**
 * Clawde v2 PostgreSQL Persistence Layer
 *
 * Implements authoritative persistence for documents, chunks, and citations when
 * DATABASE_URL is configured (Railway PostgreSQL / production / local Docker).
 * Provides a clean, isolated JSON development fallback when DATABASE_URL is unset
 * to ensure local development safety.
 */

let pool = null;
let isPgActive = false;
let initPromise = null;

const DATA_DIR = path.join(__dirname, '..', 'data');
const DOCS_FILE = path.join(DATA_DIR, 'documents.json');

// Initialize Pool if DATABASE_URL is present
if (process.env.DATABASE_URL) {
    try {
        const isProduction = process.env.NODE_ENV === 'production' || process.env.RAILWAY_ENVIRONMENT;
        pool = new Pool({
            connectionString: process.env.DATABASE_URL,
            ssl: isProduction ? { rejectUnauthorized: false } : (
                process.env.DATABASE_URL.includes('sslmode=require') || process.env.DATABASE_URL.includes('neon.tech') || process.env.DATABASE_URL.includes('rlwy.net')
                    ? { rejectUnauthorized: false }
                    : false
            ),
            max: 10,
            idleTimeoutMillis: 30000,
            connectionTimeoutMillis: 5000,
        });

        pool.on('error', (err) => {
            console.error('[PostgreSQL Pool Error]', err.message);
        });
    } catch (e) {
        console.error('[PostgreSQL Init Error] Failed to create connection pool:', e.message);
        pool = null;
    }
}

/**
 * Initialize Schema and seed if necessary
 */
async function initDB() {
    if (initPromise) return initPromise;

    initPromise = (async () => {
        if (!pool) {
            console.log('[PostgreSQL] DATABASE_URL is not configured. Running in local JSON fallback mode.');
            return false;
        }

        try {
            const client = await pool.connect();
            try {
                // Ensure required tables exist
                await client.query(`
                    CREATE TABLE IF NOT EXISTS documents (
                        id VARCHAR(64) PRIMARY KEY,
                        hash VARCHAR(128) NOT NULL,
                        file_name VARCHAR(512) NOT NULL,
                        case_number VARCHAR(512),
                        status VARCHAR(32) NOT NULL,
                        structured_data JSONB,
                        upload_date TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
                        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
                    );

                    CREATE INDEX IF NOT EXISTS idx_documents_case_number ON documents (case_number);
                    CREATE INDEX IF NOT EXISTS idx_documents_hash ON documents (hash);

                    CREATE TABLE IF NOT EXISTS document_chunks (
                        id VARCHAR(128) PRIMARY KEY,
                        document_id VARCHAR(64) REFERENCES documents(id) ON DELETE CASCADE,
                        case_number VARCHAR(512),
                        chunk_index INTEGER NOT NULL,
                        text TEXT NOT NULL,
                        embedding JSONB,
                        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
                    );

                    CREATE INDEX IF NOT EXISTS idx_chunks_doc_id ON document_chunks (document_id);
                    CREATE INDEX IF NOT EXISTS idx_chunks_case_number ON document_chunks (case_number);

                    CREATE TABLE IF NOT EXISTS document_citations (
                        id SERIAL PRIMARY KEY,
                        document_id VARCHAR(64) REFERENCES documents(id) ON DELETE CASCADE,
                        citation TEXT NOT NULL,
                        section VARCHAR(64),
                        act VARCHAR(128),
                        is_mapped BOOLEAN DEFAULT FALSE,
                        bns_target TEXT,
                        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
                    );

                    CREATE INDEX IF NOT EXISTS idx_citations_doc_id ON document_citations (document_id);
                `);

                isPgActive = true;
                console.log('[PostgreSQL] Database connection verified and schema initialized successfully.');

                // Check if seeding is needed
                const countRes = await client.query('SELECT COUNT(*) AS count FROM documents');
                if (parseInt(countRes.rows[0].count, 10) === 0 && fs.existsSync(DOCS_FILE)) {
                    console.log('[PostgreSQL] Empty database detected. Seeding initial documents from documents.json...');
                    await seedFromJSON(client);
                }

                return true;
            } finally {
                client.release();
            }
        } catch (err) {
            console.error('[PostgreSQL] Connection failed. Gracefully falling back to local JSON storage mode. Error:', err.message);
            isPgActive = false;
            return false;
        }
    })();

    return initPromise;
}

/**
 * Seed existing documents.json into PostgreSQL
 */
async function seedFromJSON(client) {
    try {
        const raw = fs.readFileSync(DOCS_FILE, 'utf-8');
        const docs = JSON.parse(raw);
        for (const doc of docs) {
            if (doc.status === 'completed') {
                await insertOrUpdateDocumentInClient(client, doc);
            }
        }
        console.log(`[PostgreSQL] Successfully seeded ${docs.length} documents from JSON into PostgreSQL.`);
    } catch (e) {
        console.warn('[PostgreSQL Seed Warning] Failed to seed from JSON:', e.message);
    }
}

/**
 * Helper to write a full document, chunks, and citations into PostgreSQL in a transaction
 */
async function insertOrUpdateDocumentInClient(client, doc) {
    await client.query('BEGIN');
    try {
        const caseNumber = doc.structuredData?.case_number || null;
        const uploadDate = doc.uploadDate ? new Date(doc.uploadDate) : new Date();

        await client.query(`
            INSERT INTO documents (id, hash, file_name, case_number, status, structured_data, upload_date)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            ON CONFLICT (id) DO UPDATE SET
                hash = EXCLUDED.hash,
                file_name = EXCLUDED.file_name,
                case_number = EXCLUDED.case_number,
                status = EXCLUDED.status,
                structured_data = EXCLUDED.structured_data,
                upload_date = EXCLUDED.upload_date;
        `, [
            doc.id,
            doc.hash,
            doc.fileName || 'document',
            caseNumber,
            doc.status,
            JSON.stringify(doc.structuredData || {}),
            uploadDate
        ]);

        // Insert chunks
        if (doc.chunks && Array.isArray(doc.chunks) && doc.chunks.length > 0) {
            await client.query('DELETE FROM document_chunks WHERE document_id = $1', [doc.id]);
            for (let i = 0; i < doc.chunks.length; i++) {
                const chunk = doc.chunks[i];
                const chunkId = chunk.id || `${doc.id}_chunk_${i}`;
                await client.query(`
                    INSERT INTO document_chunks (id, document_id, case_number, chunk_index, text, embedding)
                    VALUES ($1, $2, $3, $4, $5, $6)
                    ON CONFLICT (id) DO UPDATE SET
                        text = EXCLUDED.text,
                        embedding = EXCLUDED.embedding,
                        case_number = EXCLUDED.case_number;
                `, [
                    chunkId,
                    doc.id,
                    caseNumber,
                    i,
                    chunk.text,
                    JSON.stringify(chunk.embedding || [])
                ]);
            }
        }

        // Insert citations
        const citations = doc.structuredData?.old_law_citations || [];
        if (citations.length > 0) {
            await client.query('DELETE FROM document_citations WHERE document_id = $1', [doc.id]);
            for (const cit of citations) {
                await client.query(`
                    INSERT INTO document_citations (document_id, citation, section, act, is_mapped, bns_target)
                    VALUES ($1, $2, $3, $4, $5, $6)
                `, [
                    doc.id,
                    cit.raw_citation || cit.citation || cit.section || '',
                    cit.section || '',
                    cit.act || '',
                    Boolean(cit.bns_equivalent || cit.is_mapped),
                    cit.bns_equivalent || cit.bns_target || null
                ]);
            }
        }

        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    }
}

// ---------------------------------------------------------------------------
// Fallback JSON in-memory storage manager
// ---------------------------------------------------------------------------
let fallbackDocs = [];

function loadFallbackDocs() {
    try {
        if (fs.existsSync(DOCS_FILE)) {
            fallbackDocs = JSON.parse(fs.readFileSync(DOCS_FILE, 'utf-8'));
            fallbackDocs.forEach(d => {
                if (d.status === 'processing') d.status = 'failed';
            });
        }
    } catch (e) {
        console.error('[Fallback Storage] Failed to load documents.json:', e.message);
        fallbackDocs = [];
    }
    return fallbackDocs;
}

function saveFallbackDocs() {
    try {
        if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
        const tmpFile = DOCS_FILE + '.tmp';
        fs.writeFileSync(tmpFile, JSON.stringify(fallbackDocs, null, 2));
        fs.renameSync(tmpFile, DOCS_FILE);
    } catch (e) {
        console.error('[Fallback Storage] Failed to write documents.json:', e.message);
    }
}

// ---------------------------------------------------------------------------
// Unified Repository Interface (PG Authoritative with Fallback)
// ---------------------------------------------------------------------------

/**
 * Check if PostgreSQL persistence is active
 */
function isPostgresActive() {
    return isPgActive && pool !== null;
}

/**
 * Retrieve all completed documents (metadata & structured data)
 */
async function getCompletedDocuments() {
    if (isPostgresActive()) {
        try {
            const res = await pool.query(`
                SELECT id, hash, file_name AS "fileName", case_number AS "caseNumber",
                       status, structured_data AS "structuredData", upload_date AS "uploadDate"
                FROM documents
                WHERE status = 'completed'
                ORDER BY upload_date DESC
            `);
            return res.rows;
        } catch (e) {
            console.error('[PostgreSQL Error] getCompletedDocuments failed, using fallback:', e.message);
        }
    }
    return fallbackDocs.filter(d => d.status === 'completed').map(d => {
        const doc = { ...d };
        delete doc.paragraphs;
        return doc;
    });
}

/**
 * Find completed document by file SHA-256 hash (instant cache check)
 */
async function findDocumentByHash(hash) {
    if (isPostgresActive()) {
        try {
            const res = await pool.query(`
                SELECT id, hash, file_name AS "fileName", case_number AS "caseNumber",
                       status, structured_data AS "structuredData", upload_date AS "uploadDate"
                FROM documents
                WHERE hash = $1 AND status = 'completed'
                LIMIT 1
            `, [hash]);
            if (res.rows.length > 0) {
                return res.rows[0];
            }
            return null;
        } catch (e) {
            console.error('[PostgreSQL Error] findDocumentByHash failed, using fallback:', e.message);
        }
    }
    return fallbackDocs.find(d => d.hash === hash && d.status === 'completed') || null;
}

/**
 * Get document by ID including structured data and chunks
 */
async function getDocumentById(id) {
    if (isPostgresActive()) {
        try {
            const docRes = await pool.query(`
                SELECT id, hash, file_name AS "fileName", case_number AS "caseNumber",
                       status, structured_data AS "structuredData", upload_date AS "uploadDate"
                FROM documents
                WHERE id = $1
            `, [id]);

            if (docRes.rows.length === 0) return null;
            const doc = docRes.rows[0];

            // Attach chunks
            const chunksRes = await pool.query(`
                SELECT id, chunk_index, text, embedding, document_id AS source_doc_id
                FROM document_chunks
                WHERE document_id = $1
                ORDER BY chunk_index ASC
            `, [id]);

            doc.chunks = chunksRes.rows.map(c => ({
                id: c.id,
                text: c.text,
                embedding: typeof c.embedding === 'string' ? JSON.parse(c.embedding) : c.embedding,
                source_doc_id: c.source_doc_id,
                source_filename: doc.fileName
            }));

            return doc;
        } catch (e) {
            console.error('[PostgreSQL Error] getDocumentById failed, using fallback:', e.message);
        }
    }
    return fallbackDocs.find(d => d.id === id) || null;
}

/**
 * Save or update document (with chunks and citations)
 */
async function saveDocument(doc) {
    // Keep local JSON in sync as well for fallback / offline continuity
    const existingIdx = fallbackDocs.findIndex(d => d.id === doc.id);
    if (existingIdx >= 0) {
        fallbackDocs[existingIdx] = doc;
    } else {
        fallbackDocs.push(doc);
    }
    saveFallbackDocs();

    if (isPostgresActive()) {
        try {
            const client = await pool.connect();
            try {
                await insertOrUpdateDocumentInClient(client, doc);
                return true;
            } finally {
                client.release();
            }
        } catch (e) {
            console.error('[PostgreSQL Error] saveDocument failed to persist in Postgres:', e.message);
            return false;
        }
    }
    return true;
}

/**
 * Get chunks for all documents sharing a given case_number (Cross-Document retrieval)
 */
async function getChunksForCase(caseNumber) {
    if (!caseNumber || caseNumber === 'N/A') return [];

    if (isPostgresActive()) {
        try {
            const res = await pool.query(`
                SELECT c.id, c.text, c.embedding, c.document_id AS source_doc_id, d.file_name AS source_filename
                FROM document_chunks c
                JOIN documents d ON c.document_id = d.id
                WHERE d.status = 'completed' AND d.case_number = $1
                ORDER BY d.upload_date ASC, c.chunk_index ASC
            `, [caseNumber]);

            return res.rows.map(r => ({
                id: r.id,
                text: r.text,
                embedding: typeof r.embedding === 'string' ? JSON.parse(r.embedding) : r.embedding,
                source_doc_id: r.source_doc_id,
                source_filename: r.source_filename
            }));
        } catch (e) {
            console.error('[PostgreSQL Error] getChunksForCase failed, using fallback:', e.message);
        }
    }

    const sameCase = fallbackDocs.filter(d =>
        d.status === 'completed' &&
        d.structuredData?.case_number === caseNumber
    );

    return sameCase.flatMap(d =>
        (d.chunks || []).map(c => ({
            ...c,
            source_doc_id: d.id,
            source_filename: d.fileName
        }))
    );
}

/**
 * Close pool cleanly on shutdown
 */
async function closeDB() {
    if (pool) {
        await pool.end().catch(() => {});
        pool = null;
        isPgActive = false;
    }
}

// Initialize fallback docs cache immediately
loadFallbackDocs();

module.exports = {
    initDB,
    isPostgresActive,
    getCompletedDocuments,
    findDocumentByHash,
    getDocumentById,
    saveDocument,
    getChunksForCase,
    closeDB,
    // Exported for testing
    loadFallbackDocs,
    getFallbackDocs: () => fallbackDocs,
    _pool: pool
};
