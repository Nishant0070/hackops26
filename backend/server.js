require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { Groq } = require('groq-sdk');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sharp = require('sharp');
const Tesseract = require('tesseract.js');
const { PDFParse } = require('pdf-parse');
const { extractCitations } = require('./lib/citations');
const { applyDeterministicFallbacks } = require('./lib/metadata_fallback');
const { pipeline } = require('@xenova/transformers');
const db = require('./lib/db');

const app = express();

// Configurable CORS with FRONTEND_URL support
const localOrigins = [
    'http://localhost:5173',
    'http://localhost:3000',
    'http://127.0.0.1:5173'
];

const allowedOrigins = [...localOrigins];
if (process.env.FRONTEND_URL) {
    try {
        const parsed = new URL(process.env.FRONTEND_URL);
        allowedOrigins.push(parsed.origin);
    } catch {
        allowedOrigins.push(process.env.FRONTEND_URL.replace(/\/+$/, ''));
    }
}

function isOriginAllowed(origin) {
    if (!origin) return true; // Allow non-browser requests (e.g. curl, health checks)
    return allowedOrigins.includes(origin);
}

app.use(cors({
    origin: (origin, callback) => {
        if (isOriginAllowed(origin)) {
            return callback(null, true);
        }
        return callback(new Error(`CORS origin not allowed: ${origin}`));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Upload-ID']
}));


// Body parsing with safe limits
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Health check endpoints for Railway / monitoring
app.get('/health', (req, res) => res.status(200).send('OK'));
app.get('/', (req, res) => res.status(200).json({ status: 'online', service: 'clawde-backend' }));


// Initialize Groq safely (prevents boot crash if env var is missing or injected after startup)
let groq;
try {
    groq = new Groq({ apiKey: process.env.GROQ_API_KEY || 'placeholder_key' });
} catch (e) {
    console.error("[Init Warning] Groq client failed to initialize:", e.message);
    groq = { chat: { completions: { create: async () => { throw new Error("GROQ_API_KEY is not configured on the server."); } } } };
}
const textModel = 'qwen/qwen3.8-27b';

// Helper: strip <think>...</think> blocks from thinking models and extract JSON
function parseThinkingModelJSON(rawText) {
    // Strip <think>...</think> block (may span many lines)
    let cleaned = rawText.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
    // Try to extract JSON from a markdown code block if present
    const codeBlock = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (codeBlock) cleaned = codeBlock[1].trim();
    // Try to extract the first {...} JSON object
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (jsonMatch) cleaned = jsonMatch[0];
    return JSON.parse(cleaned);
}

// Persistence
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
const DOCS_FILE = path.join(DATA_DIR, 'documents.json');
const DEMO_CACHE_FILE = path.join(DATA_DIR, 'demo_cache.json');
const BNS_MAP_FILE = path.join(DATA_DIR, 'ipc_bns_map.json');

let bnsMap = [];
try {
    if (fs.existsSync(BNS_MAP_FILE)) {
        bnsMap = JSON.parse(fs.readFileSync(BNS_MAP_FILE, 'utf-8'));
        console.log(`Loaded 230+ legal reference entries`);
    }
} catch (e) {
    console.error("Failed to load BNS map:", e);
}

let embedder = null;
async function getEmbedder() {
    if (!embedder) {
        embedder = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
    }
    return embedder;
}

async function getEmbedding(text) {
    const extractor = await getEmbedder();
    const output = await extractor(text, { pooling: 'mean', normalize: true });
    return Array.from(output.data);
}

function cosineSim(a, b) {
    if (!a || !b || a.length !== b.length) return 0;
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }
    return dot / (Math.sqrt(normA) * Math.sqrt(normB) || 1);
}

// Extract candidate exact-match tokens from the question (Part 3)
function extractQuestionTokens(q) {
    const tokens = new Set();
    // Case number patterns: "123/2024", "W.P. 456 of 2023"
    (q.match(/\b\d{1,6}\s*[\/\-]\s*\d{2,4}\b/g) || []).forEach(t => tokens.add(t.replace(/\s+/g, '')));
    // Section citations: "Section 302", "s. 420", "302"
    (q.match(/\b(?:section|sec|s|u\/s)\s*\.?\s*\d{1,3}[A-Za-z]?\b/gi) || []).forEach(t => {
        const n = t.match(/\d{1,3}[A-Za-z]?/);
        if (n) tokens.add(n[0].toUpperCase());
    });
    // Standalone 3-digit numbers that look like sections
    (q.match(/\b\d{2,3}[A-Za-z]?\b/g) || []).forEach(t => tokens.add(t.toUpperCase()));
    return Array.from(tokens);
}

async function ensureDocumentChunks(doc) {
    if (doc.chunks && doc.chunks.length > 0) return doc.chunks;
    const paras = doc.paragraphs || (doc.structuredData?.raw_text ? doc.structuredData.raw_text.split(/\n\s*\n/).map((t, i) => ({ i, text: t.trim() })).filter(p => p.text.length > 10) : []);
    const chunks = [];
    for (let idx = 0; idx < paras.length; idx++) {
        const p = paras[idx];
        if (!p.text || p.text.length < 10) continue;
        try {
            const emb = await getEmbedding(p.text.substring(0, 1000));
            chunks.push({
                id: `${doc.id}_chunk_${idx}`,
                text: p.text,
                embedding: emb,
                source_doc_id: doc.id,
                source_filename: doc.fileName
            });
        } catch (e) {
            console.warn(`Error generating chunk embedding for doc ${doc.id}:`, e.message);
        }
    }
    doc.chunks = chunks;
    return chunks;
}

let documents = [];
try {
    if (fs.existsSync(DOCS_FILE)) {
        documents = JSON.parse(fs.readFileSync(DOCS_FILE, 'utf-8'));
        // Clean up stuck processing docs
        documents.forEach(d => {
            if (d.status === 'processing') d.status = 'failed';
        });
        saveDocuments();
    }
} catch (e) {
    console.error("Failed to load documents:", e);
}

function saveDocuments() {
    const tmpFile = DOCS_FILE + '.tmp';
    fs.writeFileSync(tmpFile, JSON.stringify(documents, null, 2));
    fs.renameSync(tmpFile, DOCS_FILE);
}

// Multer with safe file size limits
const storage = multer.memoryStorage();
const upload = multer({
    storage: storage,
    limits: {
        fileSize: 25 * 1024 * 1024, // 25 MB max per file
        files: 20
    }
});

// Groq Rate Limiter Class
class GroqRateLimiter {
    constructor() {
        this.tokenBudget = 8000;
        this.tokensUsed = []; 
    }

    async wait(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    async acquire(estimatedTokens) {
        const now = Date.now();
        this.tokensUsed = this.tokensUsed.filter(t => now - t.time < 60000);
        const currentUsage = this.tokensUsed.reduce((sum, t) => sum + t.tokens, 0);
        
        const maxAllowed = this.tokenBudget * 0.85;
        
        if (currentUsage + estimatedTokens > maxAllowed) {
            console.log(`[RateLimiter] Sleeping... Budget tight (${currentUsage}/${this.tokenBudget})`);
            await this.wait(5000);
            return this.acquire(estimatedTokens); 
        }
        
        this.tokensUsed.push({ time: Date.now(), tokens: estimatedTokens });
    }

    updateBudget(headers) {
        if (headers && headers.get('x-ratelimit-limit-tokens')) {
            this.tokenBudget = parseInt(headers.get('x-ratelimit-limit-tokens'), 10);
        }
    }

    async fetchWithBackoff(apiCallFn, estimatedTokens = 1500) {
        let attempts = 0;
        const maxAttempts = 5;

        while (attempts < maxAttempts) {
            await this.acquire(estimatedTokens);
            try {
                const response = await apiCallFn();
                if (response?.headers) this.updateBudget(response.headers);
                return response;
            } catch (error) {
                attempts++;
                if (error.response && error.response.headers) {
                    this.updateBudget(error.response.headers);
                }

                if (error.status === 429) {
                    let waitTime = 60000;
                    if (error.response?.headers?.get('retry-after')) {
                        waitTime = parseFloat(error.response.headers.get('retry-after')) * 1000;
                    }
                    console.log(`[RateLimiter] 429 Hit. Waiting ${waitTime}ms...`);
                    await this.wait(Math.min(waitTime, 300000)); 
                } else if (error.status >= 500) {
                    const waitTime = Math.pow(2, attempts) * 1000;
                    console.log(`[RateLimiter] 5xx Error. Backing off ${waitTime}ms...`);
                    await this.wait(waitTime);
                } else if (error.status === 400 || error.status === 401 || error.status === 413) {
                    console.error(`[RateLimiter] Terminal Error ${error.status}:`, error.message);
                    throw error;
                } else {
                    throw error;
                }
            }
        }
        throw new Error("Max retries exceeded");
    }
}
const rateLimiter = new GroqRateLimiter();

// Endpoints (supporting both /api/* and /* paths so env var mismatches don't break routing)
app.get(['/api/documents', '/documents'], async (req, res) => {
    try {
        const completedDocs = await db.getCompletedDocuments();
        res.json(completedDocs.map(d => {
            const doc = { ...d };
            delete doc.paragraphs;
            return doc;
        }));
    } catch (e) {
        console.error("Failed to fetch documents:", e.message);
        res.status(500).json({ error: "Failed to fetch documents" });
    }
});

app.get(['/api/bns-map', '/bns-map'], (req, res) => {
    try {
        if (!bnsMap || bnsMap.length === 0) {
            bnsMap = JSON.parse(fs.readFileSync(BNS_MAP_FILE, 'utf-8'));
        }
        res.json(bnsMap);
    } catch (e) {
        res.status(500).json({ error: "Failed to load BNS map" });
    }
});

// Demo Safety Net Bypass
app.post(['/api/demo', '/demo'], (req, res) => {
    try {
        if (fs.existsSync(DEMO_CACHE_FILE)) {
            const demoDoc = JSON.parse(fs.readFileSync(DEMO_CACHE_FILE, 'utf-8'));
            res.json(demoDoc);
        } else {
            res.status(404).json({ error: "Demo cache not found. Please process a document first." });
        }
    } catch (e) {
        res.status(500).json({ error: "Failed to load demo" });
    }
});

// SSE Active Clients Map: uploadId -> Set of response streams
const progressClients = new Map();

function sendProgress(uploadId, stage, percent, message, detail = {}) {
    if (!uploadId) return;
    const clients = progressClients.get(uploadId);
    if (clients && clients.size > 0) {
        const payload = `data: ${JSON.stringify({ uploadId, stage, percent, message, detail, timestamp: Date.now() })}\n\n`;
        clients.forEach(res => {
            try {
                res.write(payload);
            } catch (err) {
                console.error(`[SSE] Write error for ${uploadId}:`, err.message);
            }
        });
    }
}

// SSE Pipeline Progress Endpoint
app.get(['/api/progress/:uploadId', '/progress/:uploadId'], (req, res) => {
    const { uploadId } = req.params;
    const reqOrigin = req.headers.origin;

    if (reqOrigin && isOriginAllowed(reqOrigin)) {
        res.setHeader('Access-Control-Allow-Origin', reqOrigin);
        res.setHeader('Access-Control-Allow-Credentials', 'true');
    } else if (!reqOrigin) {
        res.setHeader('Access-Control-Allow-Origin', '*');
    } else {
        return res.status(403).json({ error: 'Origin not allowed' });
    }
    res.setHeader('Vary', 'Origin');
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    if (res.flushHeaders) res.flushHeaders();

    if (!progressClients.has(uploadId)) {
        progressClients.set(uploadId, new Set());
    }
    progressClients.get(uploadId).add(res);

    // Initial ping
    res.write(`data: ${JSON.stringify({ uploadId, stage: 'connected', percent: 5, message: 'Connected to pipeline monitor' })}\n\n`);

    req.on('close', () => {
        const clients = progressClients.get(uploadId);
        if (clients) {
            clients.delete(res);
            if (clients.size === 0) progressClients.delete(uploadId);
        }
    });
});

const CONCURRENCY = 3; // Tesseract workers are memory-hungry; three is a safe cap for local hardware
async function ocrPagesParallel(processedImages, uploadId) {
    const results = new Array(processedImages.length);
    const uncertainSpans = [];
    let completed = 0;
    const workers = await Promise.all(
        Array.from({ length: CONCURRENCY }, () => Tesseract.createWorker(['eng', 'hin']))
    );
    try {
        const queue = processedImages.map((buf, idx) => ({ buf, idx }));
        async function runWorker(worker) {
            while (queue.length > 0) {
                const task = queue.shift();
                if (!task) return;
                try {
                    const { data } = await worker.recognize(task.buf);
                    results[task.idx] = { index: task.idx, text: data.text };
                    if (data.blocks) {
                        data.blocks.forEach(b => (b.paragraphs || []).forEach(p =>
                            (p.lines || []).forEach(l => (l.words || []).forEach(w => {
                                if (w.confidence < 60 && w.text.length > 3) uncertainSpans.push(w.text);
                            }))
                        ));
                    }
                } catch (err) {
                    console.error(`Page ${task.idx + 1} OCR failed:`, err);
                    results[task.idx] = { index: task.idx, text: '\n[OCR FAILED FOR THIS PAGE]\n' };
                }
                completed++;
                sendProgress(uploadId, 'ocr_extraction',
                    35 + Math.round((completed / processedImages.length) * 25),
                    `Reading page ${completed} of ${processedImages.length}...`);
            }
        }
        await Promise.all(workers.map(runWorker));
    } finally {
        await Promise.all(workers.map(w => w.terminate().catch(() => {})));
    }
    results.sort((a, b) => a.index - b.index);
    return { results, uncertainSpans };
}

// The Pipeline
app.post(['/api/upload', '/upload'], upload.array('pages'), async (req, res) => {
    const uploadId = req.body.uploadId || req.headers['x-upload-id'] || Date.now().toString();

    try {
        if (!req.files || req.files.length === 0) {
            sendProgress(uploadId, 'error', 0, 'No files uploaded');
            return res.status(400).json({ error: 'No files uploaded' });
        }

        const fileName = req.body.fileName || 'document';
        sendProgress(uploadId, 'upload_received', 15, 'File received and verified');

        // Stage 0: Validate & Hash
        const hash = crypto.createHash('sha256');
        req.files.forEach(f => hash.update(f.buffer));
        const fileHash = hash.digest('hex');

        const cachedDoc = await db.findDocumentByHash(fileHash);
        if (cachedDoc) {
            console.log(`[Stage 0] Cache hit for ${fileHash}`);
            sendProgress(uploadId, 'completed', 100, 'Loaded from instant cache', { documentId: cachedDoc.id });
            const clientDoc = { ...cachedDoc };
            delete clientDoc.paragraphs;
            return res.json(clientDoc);
        }

        const docId = Date.now().toString();
        const newDoc = {
            id: docId,
            hash: fileHash,
            fileName: fileName,
            uploadDate: new Date().toISOString(),
            status: 'processing'
        };
        documents.push(newDoc);
        await db.saveDocument(newDoc);

        let combinedRawText = '';
        let uncertainSpans = [];

        // Check if a raw PDF was uploaded
        const firstFile = req.files[0];
        const isPdf = req.files.length === 1 && (
            firstFile.mimetype === 'application/pdf' ||
            (firstFile.originalname && firstFile.originalname.toLowerCase().endsWith('.pdf')) ||
            (firstFile.buffer && firstFile.buffer.slice(0, 4).toString() === '%PDF')
        );

        let usedDigitalPdf = false;
        if (isPdf) {
            sendProgress(uploadId, 'pdf_analysis', 25, 'Analyzing document format and embedded text layer...');
            const parser = new PDFParse({ data: firstFile.buffer });
            try {
                const textResult = await parser.getText();
                const extractedText = (typeof textResult === 'string' ? textResult : (textResult?.text || '')).trim();
                const printableChars = extractedText.replace(/\s+/g, '').length;

                if (printableChars > 50) {
                    console.log(`[PDF] Digital PDF confirmed: extracted ${printableChars} characters directly via PDFParse.`);
                    sendProgress(uploadId, 'ocr_extraction', 45, 'Digital PDF text layer extracted without OCR');
                    combinedRawText = extractedText;
                    usedDigitalPdf = true;
                } else {
                    console.log(`[PDF] Scanned PDF detected (only ${printableChars} chars). Proceeding with OCR.`);
                    sendProgress(uploadId, 'ocr_extraction', 30, 'Scanned PDF detected — initiating OCR engine...');
                }
            } catch (pdfErr) {
                console.warn('[PDF] PDFParse text extraction failed, falling back to OCR:', pdfErr.message);
            } finally {
                await parser.destroy().catch(() => {});
            }
        }

        // If not a digital PDF with extracted text, process pages with Sharp + Tesseract
        if (!usedDigitalPdf) {
            sendProgress(uploadId, 'ocr_extraction', 35, `Preprocessing and preparing page images for OCR...`);

            // Stage 1: Normalize images (rasterize scanned PDF or normalize uploaded image buffers)
            const processedImages = [];

            if (isPdf) {
                console.log(`[Stage 1] Rendering scanned PDF into image pages...`);
                sendProgress(uploadId, 'ocr_extraction', 35, 'Rasterizing scanned PDF pages into image buffers...');
                const pdfParser = new PDFParse({ data: firstFile.buffer });
                try {
                    const screenshotResult = await pdfParser.getScreenshot();
                    const pages = screenshotResult?.pages || [];
                    console.log(`[Stage 1] Rendered ${pages.length} image page(s) from scanned PDF`);

                    if (pages.length === 0) {
                        throw new Error('No pages were rendered from the scanned PDF.');
                    }

                    for (let i = 0; i < pages.length; i++) {
                        const imageBuf = Buffer.from(pages[i].data);
                        const buf = await sharp(imageBuf)
                            .resize({ width: 1200, height: 1200, fit: 'inside', withoutEnlargement: true })
                            .jpeg({ quality: 80 })
                            .toBuffer();
                        processedImages.push(buf);
                    }
                } catch (renderErr) {
                    console.error('[Stage 1] Failed to rasterize scanned PDF with PDFParse getScreenshot:', renderErr.message);
                    throw new Error(`Failed to render scanned PDF pages: ${renderErr.message}`);
                } finally {
                    await pdfParser.destroy().catch(() => {});
                }
            } else {
                console.log(`[Stage 1] Normalizing ${req.files.length} uploaded image page(s)...`);
                for (let idx = 0; idx < req.files.length; idx++) {
                    const buf = await sharp(req.files[idx].buffer)
                        .resize({ width: 1200, height: 1200, fit: 'inside', withoutEnlargement: true })
                        .jpeg({ quality: 80 })
                        .toBuffer();
                    processedImages.push(buf);
                }
            }

            // Stage 2: Parallel OCR (Tesseract local)
            console.log(`[Stage 2] OCR starting (parallel worker pool)...`);
            const { results: pagesOcr, uncertainSpans: newUncertain } = await ocrPagesParallel(processedImages, uploadId);
            uncertainSpans.push(...newUncertain);

            // Stage 3: Assemble
            console.log(`[Stage 3] Assembling text...`);
            pagesOcr.sort((a, b) => a.index - b.index);
            combinedRawText = pagesOcr.map(p => `--- Page ${p.index + 1} ---\n${p.text}`).join('\n\n');
        }

        const paragraphs = combinedRawText.split(/\n\s*\n/).map((text, i) => ({ i, text: text.trim() })).filter(p => p.text.length > 0);

        // Stage 4: Structure & Explain (Groq)
        console.log(`[Stage 4] Groq Text structuring...`);
        sendProgress(uploadId, 'structuring', 65, 'Analyzing legal entities and structure (Groq)...');

        
        const structPrompt = `Analyze the following OCR text of an Indian legal document.
        Return exactly in this JSON schema:
        - "is_legal_document": boolean
        - "doc_type": string (e.g. Affidavit, Judgment, Order)
        - "case_number": string (or "N/A")
        - "court_name": string
        - "parties": array of { "name", "role" }
        - "key_dates": array of { "date", "event" }
        - "old_law_citations": array of { "citation", "section" }
        
        TEXT:
        ${combinedRawText.substring(0, 30000)}
        
        Respond ONLY with a valid JSON object matching the schema above. Do not include markdown formatting or explanations.`;

        const explainPrompt = `Analyze the following OCR text of an Indian legal document. Correct obvious OCR errors in your mind before summarizing.
        Return exactly in this JSON schema:
        - "summary_en": array of 3-5 bullet points in English
        - "summary_hi": array of 3-5 bullet points translated to Hindi
        - "action_required": one line of urgent action required in plain language
        - "suggested_questions": exactly 3 suggested questions a user could ask about this document
        
        TEXT:
        ${combinedRawText.substring(0, 30000)}
        
        Respond ONLY with a valid JSON object matching the schema above. Do not include markdown formatting or explanations.`;

        const callGroq = async (prompt, maxTokens, temp, label) => {
            try {
                // NOTE: Do NOT use response_format: json_object with qwen thinking models.
                // The <think> block output causes Groq's JSON validator to reject immediately.
                // Instead call in plain text mode and extract JSON manually.
                const response = await rateLimiter.fetchWithBackoff(() => groq.chat.completions.create({
                    model: textModel,
                    messages: [{ role: 'user', content: prompt }],
                    temperature: temp,
                    max_tokens: maxTokens
                }), maxTokens);
                
                const rawText = response.choices[0]?.message?.content || "";
                console.log(`[Stage 4 - ${label}] Raw (first 300 chars): ${rawText.substring(0, 300)}`);
                return { status: 'fulfilled', value: rawText };
            } catch (error) {
                console.error(`[Stage 4 - ${label}] GROQ API ERROR:`, error.status, error.message);
                return { status: 'rejected', reason: error };
            }
        };

        const [structResult, explainResult] = await Promise.allSettled([
            callGroq(structPrompt, 1024, 0, "STRUCTURE (4a)"),
            callGroq(explainPrompt, 2048, 0.3, "EXPLAIN (4b)")
        ]);

        let structData = {};
        let explainData = {};

        if (structResult.status === 'fulfilled' && structResult.value.status === 'fulfilled') {
            try { 
                structData = parseThinkingModelJSON(structResult.value.value || "{}");
                console.log('[Stage 4a] Parsed structData keys:', Object.keys(structData));
            } catch(e) {
                console.error("[Stage 4a] JSON Parse failed for STRUCTURE:", e.message, '\nRaw:', structResult.value.value?.substring(0, 500));
            }
        } else {
            console.error("[Stage 4a] STRUCTURE call rejected:", structResult.reason?.message);
        }

        if (explainResult.status === 'fulfilled' && explainResult.value.status === 'fulfilled') {
            try { 
                explainData = parseThinkingModelJSON(explainResult.value.value || "{}");
                console.log('[Stage 4b] Parsed explainData keys:', Object.keys(explainData));
            } catch(e) {
                console.error("[Stage 4b] JSON Parse failed for EXPLAIN:", e.message, '\nRaw:', explainResult.value.value?.substring(0, 500));
            }
        } else {
            console.error("[Stage 4b] EXPLAIN call rejected:", explainResult.reason?.message);
        }

        sendProgress(uploadId, 'summarizing', 85, 'Generating multilingual summaries & action items...');

        if (structData.is_legal_document === false) {
            newDoc.status = 'failed';
            saveDocuments();
            sendProgress(uploadId, 'error', 0, 'Uploaded file does not appear to be a legal document.');
            return res.status(400).json({ error: 'Uploaded file does not appear to be a legal document.' });
        }

        // Part 2: Extract citations deterministically with tightened extractor
        const extractedCitations = extractCitations(combinedRawText, bnsMap);

        // Deterministic Fallback: Apply text-grounded fallback extraction if Groq failed or omitted fields
        const fallbackResults = applyDeterministicFallbacks(combinedRawText, structData, explainData, extractedCitations);
        structData = fallbackResults.structData;
        explainData = fallbackResults.explainData;
        structData.old_law_citations = extractedCitations;

        const finalStructuredData = {
            ...structData,
            ...explainData,
            old_law_citations: extractedCitations,
            raw_text: combinedRawText,
            uncertain_spans: uncertainSpans
        };

        // Stage 5: Compute chunks and local embeddings for hybrid retrieval (Part 3)
        const chunks = [];
        for (let idx = 0; idx < paragraphs.length; idx++) {
            const p = paragraphs[idx];
            if (!p.text || p.text.length < 10) continue;
            try {
                const emb = await getEmbedding(p.text.substring(0, 1000));
                chunks.push({
                    id: `${docId}_chunk_${idx}`,
                    text: p.text,
                    embedding: emb,
                    source_doc_id: docId,
                    source_filename: fileName
                });
            } catch (e) {
                console.warn(`[Embeddings] Chunk ${idx} failed:`, e.message);
            }
        }

        // Stage 6: Persist
        newDoc.status = 'completed';
        newDoc.structuredData = finalStructuredData;
        newDoc.caseNumber = finalStructuredData.case_number || null;
        newDoc.case_number = finalStructuredData.case_number || null;
        newDoc.paragraphs = paragraphs;
        newDoc.chunks = chunks;
        await db.saveDocument(newDoc);
        
        // Cache as demo if it's the first successful one
        if (!fs.existsSync(DEMO_CACHE_FILE)) {
            fs.writeFileSync(DEMO_CACHE_FILE, JSON.stringify(newDoc, null, 2));
        }

        sendProgress(uploadId, 'completed', 100, 'Analysis complete', { documentId: newDoc.id });

        const clientDoc = { ...newDoc };
        delete clientDoc.paragraphs;
        res.json(clientDoc);

    } catch (error) {
        console.error("Error processing document:", error);
        sendProgress(uploadId, 'error', 0, error.message || 'Failed to process document');
        res.status(500).json({ error: 'Failed to process document' });
    }
});

// Chat Endpoint (4-Tier Context: 3 grounded + 1 general)
app.post(['/api/chat', '/chat'], async (req, res) => {
    try {
        const { documentId, question } = req.body;
        const doc = await db.getDocumentById(documentId);
        if (!doc) return res.status(404).json({ error: 'Document not found' });

        // Helper to call Groq in plain text mode (works with thinking models)
        const callGroqChat = async (messages, maxTokens, temp) => {
            const response = await rateLimiter.fetchWithBackoff(() => groq.chat.completions.create({
                model: textModel,
                messages,
                temperature: temp,
                max_tokens: maxTokens
            }), maxTokens);
            const raw = response.choices[0]?.message?.content || '';
            // Strip <think> blocks from thinking models
            return raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
        };

        // Tier 0: Answer from structured JSON metadata only
        const metadata = JSON.stringify({
            doc_type: doc.structuredData?.doc_type,
            case_number: doc.structuredData?.case_number,
            court_name: doc.structuredData?.court_name,
            parties: doc.structuredData?.parties,
            key_dates: doc.structuredData?.key_dates
        });

        console.log(`[Chat] Trying Tier 0...`);
        const tier0Answer = await callGroqChat([{
            role: 'user',
            content: `You are a helpful legal assistant. Answer the user's question using ONLY the provided JSON metadata about a legal case. Detect the language of the question and answer in the SAME language (English, Hindi, or Marathi). If the metadata does not contain enough information to answer, reply ONLY with the exact string: INSUFFICIENT_DATA

Metadata: ${metadata}
Question: ${question}`
        }], 512, 0.1);

        if (tier0Answer && !tier0Answer.includes('INSUFFICIENT_DATA')) {
            return res.json({ answer: tier0Answer, supporting_quote: '', source: 'document', unverifiedFigure: false });
        }

        // Cross-document pool assembly (Part 6)
        await ensureDocumentChunks(doc);
        const currentCase = doc.structuredData?.case_number;
        let searchPool = [];

        if (currentCase && currentCase !== 'N/A') {
            searchPool = await db.getChunksForCase(currentCase);
        }

        if (!searchPool || searchPool.length === 0) {
            searchPool = (doc.chunks || []).map(c => ({
                ...c,
                source_doc_id: doc.id,
                source_filename: doc.fileName
            }));
        }

        // Tier 1: Hybrid retrieval (Part 3 & Part 6)
        console.log(`[Chat] Trying Tier 1 (Hybrid Retrieval)...`);
        let scored = [];
        try {
            const questionEmbedding = await getEmbedding(question);
            const qTokens = extractQuestionTokens(question);
            scored = searchPool
                .map(c => {
                    const vectorScore = cosineSim(questionEmbedding, c.embedding);
                    let keywordBoost = 0;
                    if (qTokens.length > 0) {
                        const chunkUpper = c.text.toUpperCase();
                        for (const tok of qTokens) {
                            if (chunkUpper.includes(tok)) keywordBoost += 0.15;
                        }
                    }
                    return { ...c, score: vectorScore + Math.min(keywordBoost, 0.3) };
                })
                .sort((a, b) => b.score - a.score)
                .slice(0, 5);
        } catch (embedErr) {
            console.warn('[Chat] Embedding calculation failed, falling back to keyword filter:', embedErr.message);
            const keywords = question.toLowerCase().split(/\W+/).filter(w => w.length > 3);
            scored = searchPool.filter(c => keywords.some(k => c.text.toLowerCase().includes(k))).slice(0, 5);
        }

        if (scored.length > 0) {
            const contextText = scored.map(c => c.text).join('\n\n').substring(0, 10000);
            const tier1Answer = await callGroqChat([{
                role: 'user',
                content: `You are a helpful legal assistant. Answer the user's question using ONLY the provided text snippets from a legal document. Detect the language of the question and answer in the SAME language (English, Hindi, or Marathi). After your answer, on a new line write QUOTE: followed by a short verbatim phrase from the text that supports your answer. If the text does not contain the answer, reply ONLY with: INSUFFICIENT_DATA

Text snippets:
${contextText}

Question: ${question}`
            }], 768, 0.1);

            if (tier1Answer && !tier1Answer.includes('INSUFFICIENT_DATA')) {
                // Extract the quote line if present
                const quoteMatch = tier1Answer.match(/QUOTE:\s*(.+)/i);
                const cleanAnswer = tier1Answer.replace(/QUOTE:.*/i, '').trim();
                const topChunk = scored[0];
                const isCrossDoc = Boolean(topChunk && topChunk.source_doc_id && topChunk.source_doc_id !== doc.id);
                return res.json({
                    answer: cleanAnswer,
                    supporting_quote: quoteMatch ? quoteMatch[1].trim() : '',
                    source: 'document',
                    unverifiedFigure: false,
                    cross_document: isCrossDoc,
                    source_filename: isCrossDoc ? topChunk.source_filename : undefined
                });
            }
        }

        // Tier 2: Full text fallback
        console.log(`[Chat] Trying Tier 2 (Full Text)...`);
        const tier2Answer = await callGroqChat([{
            role: 'user',
            content: `You are a helpful legal assistant. Answer the user's question based on the full document text below. Detect the language of the question and answer in the SAME language (English, Hindi, or Marathi). After your answer, on a new line write QUOTE: followed by a short verbatim phrase from the text that supports your answer. If you cannot find a clear answer in the document, reply ONLY with: NOT_IN_DOCUMENT

Document:
${(doc.structuredData?.raw_text || '').substring(0, 20000)}

Question: ${question}`
        }], 768, 0.2);

        if (tier2Answer && !tier2Answer.includes('NOT_IN_DOCUMENT') && tier2Answer.length > 20) {
            const quoteMatch = tier2Answer.match(/QUOTE:\s*(.+)/i);
            const cleanAnswer = tier2Answer.replace(/QUOTE:.*/i, '').trim();
            return res.json({
                answer: cleanAnswer,
                supporting_quote: quoteMatch ? quoteMatch[1].trim() : '',
                source: 'document',
                unverifiedFigure: false
            });
        }

        // Tier 3: General legal assistant fallback (not grounded in the document)
        console.log(`[Chat] Falling back to Tier 3 (General Assistant)...`);
        const tier3Answer = await callGroqChat([
            {
                role: 'system',
                content: `You are a friendly assistant helping someone understand the Indian legal system. Many users are anxious litigants who may not be fluent in English.

STRICT RULES:
- Keep answers SHORT — 2 to 4 plain sentences by default. No markdown headers, no numbered lists, no bold text unless the user explicitly asks for steps or a detailed explanation (e.g. "explain in detail", "what are all the steps").
- If you need to ask a clarifying question, ask ONLY ONE — the single most important one. Never ask multiple questions at once.
- End with ONE brief line: "For advice specific to your situation, consult a qualified advocate."
- Do NOT repeat disclaimers or caveats more than once.
- Detect the language of the user's question (English, Hindi, or Marathi) and respond in the SAME language.
- If the question seems to be about their specific uploaded document, gently suggest they use the document chat instead.`
            },
            {
                role: 'user',
                content: question
            }
        ], 400, 0.4);

        // Limitation / statutory timeline detection (e.g. 30 days, 90 days, 3 years)
        const limitationRegex = /\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten|fifteen|twenty|thirty|forty-five|sixty|ninety|180|365)\s+(days?|weeks?|months?|years?)\b/i;
        const hasUnverifiedFigure = limitationRegex.test(tier3Answer);

        return res.json({
            answer: tier3Answer,
            supporting_quote: '',
            source: 'general',
            unverifiedFigure: hasUnverifiedFigure
        });

    } catch (error) {
        console.error("Chat Error:", error);
        res.status(500).json({ error: "Chat failed" });
    }
});

// Global Express Error Handler
app.use((err, req, res, next) => {
    console.error("[Server Error]", err);
    if (!res.headersSent) {
        res.status(err.status || 500).json({ error: err.message || "An internal error occurred" });
    }
});

const PORT = process.env.PORT || 5001;

// Initialize database schema and start listening
(async () => {
    try {
        await db.initDB();
    } catch (e) {
        console.error('[Startup] DB initialization error:', e.message);
    }
    app.listen(PORT, '0.0.0.0', () => console.log(`Backend listening on 0.0.0.0:${PORT}`));
})();
