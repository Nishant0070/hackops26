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
        allowedOrigins.push(
            process.env.FRONTEND_URL.replace(/\/+$/, '')
        );
    }
}

function isOriginAllowed(origin) {
    if (!origin) return true;
    return allowedOrigins.includes(origin);
}

app.use(cors({
    origin: (origin, callback) => {
        if (isOriginAllowed(origin)) {
            return callback(null, true);
        }

        return callback(
            new Error(`CORS origin not allowed: ${origin}`)
        );
    },
    credentials: true,
    methods: [
        'GET',
        'POST',
        'PUT',
        'DELETE',
        'OPTIONS'
    ],
    allowedHeaders: [
        'Content-Type',
        'Authorization',
        'X-Upload-ID'
    ]
}));

// Body parsing with safe limits
app.use(express.json({
    limit: '50mb'
}));

app.use(express.urlencoded({
    extended: true,
    limit: '50mb'
}));

// Health check endpoints
app.get(
    '/health',
    (req, res) => res
        .status(200)
        .send('OK')
);

app.get(
    '/',
    (req, res) => res
        .status(200)
        .json({
            status: 'online',
            service: 'clawde-backend'
        })
);

// Initialize Groq safely
let groq;

try {
    groq = new Groq({
        apiKey:
            process.env.GROQ_API_KEY ||
            'placeholder_key'
    });
} catch (e) {
    console.error(
        '[Init Warning] Groq client failed to initialize:',
        e.message
    );

    groq = {
        chat: {
            completions: {
                create: async () => {
                    throw new Error(
                        'GROQ_API_KEY is not configured on the server.'
                    );
                }
            }
        }
    };
}

const textModel = 'qwen/qwen3.8-27b';

// Helper: strip <think> blocks and extract JSON
function parseThinkingModelJSON(rawText) {
    let cleaned = rawText
        .replace(
            /<think>[\s\S]*?<\/think>/gi,
            ''
        )
        .trim();

    const codeBlock =
        cleaned.match(
            /```(?:json)?\s*([\s\S]*?)```/
        );

    if (codeBlock) {
        cleaned = codeBlock[1].trim();
    }

    const jsonMatch =
        cleaned.match(
            /\{[\s\S]*\}/
        );

    if (jsonMatch) {
        cleaned = jsonMatch[0];
    }

    return JSON.parse(cleaned);
}

// Persistence
const DATA_DIR =
    path.join(
        __dirname,
        'data'
    );

if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR);
}

const DOCS_FILE =
    path.join(
        DATA_DIR,
        'documents.json'
    );

const DEMO_CACHE_FILE =
    path.join(
        DATA_DIR,
        'demo_cache.json'
    );

const BNS_MAP_FILE =
    path.join(
        DATA_DIR,
        'ipc_bns_map.json'
    );

const PIPELINE_VERSION = '2.1';

let bnsMap = [];

try {
    if (
        fs.existsSync(
            BNS_MAP_FILE
        )
    ) {
        bnsMap =
            JSON.parse(
                fs.readFileSync(
                    BNS_MAP_FILE,
                    'utf-8'
                )
            );

        console.log(
            `Loaded ${bnsMap.length} legal reference entries`
        );
    }
} catch (e) {
    console.error(
        'Failed to load BNS map:',
        e
    );
}

let embedder = null;

async function getEmbedder() {
    if (!embedder) {
        embedder =
            await pipeline(
                'feature-extraction',
                'Xenova/all-MiniLM-L6-v2'
            );
    }

    return embedder;
}

async function getEmbedding(text) {
    const extractor =
        await getEmbedder();

    const output =
        await extractor(
            text,
            {
                pooling: 'mean',
                normalize: true
            }
        );

    return Array.from(
        output.data
    );
}

function cosineSim(a, b) {
    if (
        !a ||
        !b ||
        a.length !== b.length
    ) {
        return 0;
    }

    let dot = 0;
    let normA = 0;
    let normB = 0;

    for (
        let i = 0;
        i < a.length;
        i++
    ) {
        dot +=
            a[i] * b[i];

        normA +=
            a[i] * a[i];

        normB +=
            b[i] * b[i];
    }

    return (
        dot /
        (
            Math.sqrt(normA) *
            Math.sqrt(normB) ||
            1
        )
    );
}

function extractQuestionTokens(q) {
    const tokens =
        new Set();

    (
        q.match(
            /\b\d{1,6}\s*[\/\-]\s*\d{2,4}\b/g
        ) || []
    ).forEach(
        t =>
            tokens.add(
                t.replace(
                    /\s+/g,
                    ''
                )
            )
    );

    (
        q.match(
            /\b(?:section|sec|s|u\/s)\s*\.?\s*\d{1,3}[A-Za-z]?\b/gi
        ) || []
    ).forEach(
        t => {
            const n =
                t.match(
                    /\d{1,3}[A-Za-z]?/
                );

            if (n) {
                tokens.add(
                    n[0].toUpperCase()
                );
            }
        }
    );

    (
        q.match(
            /\b\d{2,3}[A-Za-z]?\b/g
        ) || []
    ).forEach(
        t =>
            tokens.add(
                t.toUpperCase()
            )
    );

    return Array.from(
        tokens
    );
}

async function ensureDocumentChunks(doc) {
    if (
        doc.chunks &&
        doc.chunks.length > 0
    ) {
        return doc.chunks;
    }

    const paras =
        doc.paragraphs ||
        (
            doc.structuredData?.raw_text
                ? doc
                    .structuredData
                    .raw_text
                    .split(
                        /\n\s*\n/
                    )
                    .map(
                        (t, i) => ({
                            i,
                            text:
                                t.trim()
                        })
                    )
                    .filter(
                        p =>
                            p.text.length >
                            10
                    )
                : []
        );

    const chunks = [];

    for (
        let idx = 0;
        idx < paras.length;
        idx++
    ) {
        const p =
            paras[idx];

        if (
            !p.text ||
            p.text.length < 10
        ) {
            continue;
        }

        try {
            const emb =
                await getEmbedding(
                    p.text.substring(
                        0,
                        1000
                    )
                );

            chunks.push({
                id:
                    `${doc.id}_chunk_${idx}`,
                text:
                    p.text,
                embedding:
                    emb,
                source_doc_id:
                    doc.id,
                source_filename:
                    doc.fileName
            });
        } catch (e) {
            console.warn(
                `Error generating chunk embedding for doc ${doc.id}:`,
                e.message
            );
        }
    }

    doc.chunks =
        chunks;

    return chunks;
}

let documents = [];

try {
    if (
        fs.existsSync(
            DOCS_FILE
        )
    ) {
        documents =
            JSON.parse(
                fs.readFileSync(
                    DOCS_FILE,
                    'utf-8'
                )
            );

        documents.forEach(
            d => {
                if (
                    d.status ===
                    'processing'
                ) {
                    d.status =
                        'failed';
                }
            }
        );

        saveDocuments();
    }
} catch (e) {
    console.error(
        'Failed to load documents:',
        e
    );
}

function saveDocuments() {
    const tmpFile =
        DOCS_FILE + '.tmp';

    fs.writeFileSync(
        tmpFile,
        JSON.stringify(
            documents,
            null,
            2
        )
    );

    fs.renameSync(
        tmpFile,
        DOCS_FILE
    );
}

// Multer
const storage =
    multer.memoryStorage();

const upload =
    multer({
        storage,
        limits: {
            fileSize:
                25 * 1024 * 1024,
            files: 20
        }
    });

// Groq Rate Limiter
class GroqRateLimiter {
    constructor() {
        this.tokenBudget =
            8000;

        this.tokensUsed =
            [];
    }

    async wait(ms) {
        return new Promise(
            resolve =>
                setTimeout(
                    resolve,
                    ms
                )
        );
    }

    async acquire(
        estimatedTokens
    ) {
        const now =
            Date.now();

        this.tokensUsed =
            this.tokensUsed.filter(
                t =>
                    now -
                    t.time <
                    60000
            );

        const currentUsage =
            this.tokensUsed.reduce(
                (
                    sum,
                    t
                ) =>
                    sum +
                    t.tokens,
                0
            );

        const maxAllowed =
            this.tokenBudget *
            0.85;

        if (
            currentUsage +
            estimatedTokens >
            maxAllowed
        ) {
            const oldest = this.tokensUsed[0];

            if (oldest) {
                const waitTime = Math.max(
                    250,
                    60000 - (now - oldest.time) + 100
                );

                console.log(
                    `[RateLimiter] Budget tight (${currentUsage}/${this.tokenBudget}). Waiting ${Math.ceil(waitTime / 1000)}s for token window to clear...`
                );

                await this.wait(waitTime);
            } else {
                await this.wait(1000);
            }

            return this.acquire(
                estimatedTokens
            );
        }

        this.tokensUsed.push({
            time:
                Date.now(),
            tokens:
                estimatedTokens
        });
    }

    updateBudget(headers) {
        if (
            headers &&
            headers.get &&
            headers.get(
                'x-ratelimit-limit-tokens'
            )
        ) {
            this.tokenBudget =
                parseInt(
                    headers.get(
                        'x-ratelimit-limit-tokens'
                    ),
                    10
                );
        }
    }

    async fetchWithBackoff(
        apiCallFn,
        estimatedTokens = 1500
    ) {
        let attempts = 0;
        const maxRetries = 2;

        while (true) {
            await this.acquire(
                estimatedTokens
            );

            try {
                const response =
                    await apiCallFn();

                if (
                    response?.headers
                ) {
                    this.updateBudget(
                        response.headers
                    );
                }

                return response;

            } catch (
            error
            ) {
                const status =
                    error?.status ||
                    error?.statusCode;

                const isRetriable =
                    status === 429 ||
                    (
                        status >= 500 &&
                        status < 600
                    );

                if (!isRetriable) {
                    console.error(
                        `[RateLimiter] Non-retriable error ${status}:`,
                        error.message
                    );

                    throw error;
                }

                if (
                    attempts >=
                    maxRetries
                ) {
                    console.error(
                        `[RateLimiter] Max retries (${maxRetries}) reached for status ${status}:`,
                        error.message
                    );

                    throw error;
                }

                attempts++;

                let waitTime =
                    1000 *
                    Math.pow(
                        2,
                        attempts
                    );

                const rawHeaders =
                    error?.headers ||
                    error?.response
                        ?.headers;

                let retryAfterSec =
                    null;

                if (
                    rawHeaders
                ) {
                    if (
                        typeof rawHeaders.get ===
                        'function'
                    ) {
                        retryAfterSec =
                            rawHeaders.get(
                                'retry-after'
                            );
                    } else if (
                        rawHeaders[
                        'retry-after'
                        ]
                    ) {
                        retryAfterSec =
                            rawHeaders[
                            'retry-after'
                            ];
                    }
                }

                if (
                    retryAfterSec
                ) {
                    const parsed =
                        parseFloat(
                            retryAfterSec
                        );

                    if (
                        !isNaN(parsed) &&
                        parsed > 0
                    ) {
                        waitTime =
                            Math.max(
                                parsed *
                                1000,
                                1000
                            );
                    }
                }

                waitTime =
                    Math.min(
                        waitTime,
                        30000
                    );

                console.log(
                    `[RateLimiter] Retryable error ${status} (attempt ${attempts}/${maxRetries}). Waiting ${waitTime}ms before retry...`
                );

                await this.wait(
                    waitTime
                );
            }
        }
    }
}

const rateLimiter =
    new GroqRateLimiter();

// Documents endpoint
app.get(
    [
        '/api/documents',
        '/documents'
    ],
    async (
        req,
        res
    ) => {
        try {
            const completedDocs =
                await db.getCompletedDocuments();

            res.json(
                completedDocs.map(
                    d => {
                        const doc =
                        {
                            ...d
                        };

                        delete doc.paragraphs;

                        return doc;
                    }
                )
            );
        } catch (e) {
            console.error(
                'Failed to fetch documents:',
                e.message
            );

            res.status(
                500
            ).json({
                error:
                    'Failed to fetch documents'
            });
        }
    }
);

// BNS map
app.get(
    [
        '/api/bns-map',
        '/bns-map'
    ],
    (
        req,
        res
    ) => {
        try {
            if (
                !bnsMap ||
                bnsMap.length ===
                0
            ) {
                bnsMap =
                    JSON.parse(
                        fs.readFileSync(
                            BNS_MAP_FILE,
                            'utf-8'
                        )
                    );
            }

            res.json(
                bnsMap
            );
        } catch (e) {
            res.status(
                500
            ).json({
                error:
                    'Failed to load BNS map'
            });
        }
    }
);

// Demo safety net
app.post(
    [
        '/api/demo',
        '/demo'
    ],
    (
        req,
        res
    ) => {
        try {
            if (
                fs.existsSync(
                    DEMO_CACHE_FILE
                )
            ) {
                const demoDoc =
                    JSON.parse(
                        fs.readFileSync(
                            DEMO_CACHE_FILE,
                            'utf-8'
                        )
                    );

                res.json(
                    demoDoc
                );
            } else {
                res.status(
                    404
                ).json({
                    error:
                        'Demo cache not found. Please process a document first.'
                });
            }
        } catch (e) {
            res.status(
                500
            ).json({
                error:
                    'Failed to load demo'
            });
        }
    }
);

// SSE
const progressClients =
    new Map();

function sendProgress(
    uploadId,
    stage,
    percent,
    message,
    detail = {}
) {
    if (!uploadId) {
        return;
    }

    const clients =
        progressClients.get(
            uploadId
        );

    if (
        clients &&
        clients.size > 0
    ) {
        const payload =
            `data: ${JSON.stringify({
                uploadId,
                stage,
                percent,
                message,
                detail,
                timestamp:
                    Date.now()
            })}\n\n`;

        clients.forEach(
            res => {
                try {
                    res.write(
                        payload
                    );
                } catch (
                err
                ) {
                    console.error(
                        `[SSE] Write error for ${uploadId}:`,
                        err.message
                    );
                }
            }
        );
    }
}

app.get(
    [
        '/api/progress/:uploadId',
        '/progress/:uploadId'
    ],
    (
        req,
        res
    ) => {
        const {
            uploadId
        } = req.params;

        const reqOrigin =
            req.headers.origin;

        if (
            reqOrigin &&
            isOriginAllowed(
                reqOrigin
            )
        ) {
            res.setHeader(
                'Access-Control-Allow-Origin',
                reqOrigin
            );

            res.setHeader(
                'Access-Control-Allow-Credentials',
                'true'
            );

        } else if (
            !reqOrigin
        ) {
            res.setHeader(
                'Access-Control-Allow-Origin',
                '*'
            );

        } else {
            return res
                .status(403)
                .json({
                    error:
                        'Origin not allowed'
                });
        }

        res.setHeader(
            'Vary',
            'Origin'
        );

        res.setHeader(
            'Content-Type',
            'text/event-stream'
        );

        res.setHeader(
            'Cache-Control',
            'no-cache, no-transform'
        );

        res.setHeader(
            'Connection',
            'keep-alive'
        );

        if (
            res.flushHeaders
        ) {
            res.flushHeaders();
        }

        if (
            !progressClients.has(
                uploadId
            )
        ) {
            progressClients.set(
                uploadId,
                new Set()
            );
        }

        progressClients
            .get(uploadId)
            .add(res);

        res.write(
            `data: ${JSON.stringify({
                uploadId,
                stage: 'connected',
                percent: 5,
                message:
                    'Connected to pipeline monitor'
            })}\n\n`
        );

        req.on(
            'close',
            () => {
                const clients =
                    progressClients.get(
                        uploadId
                    );

                if (clients) {
                    clients.delete(
                        res
                    );

                    if (
                        clients.size ===
                        0
                    ) {
                        progressClients.delete(
                            uploadId
                        );
                    }
                }
            }
        );
    }
);

const CONCURRENCY = 3;

async function ocrPagesParallel(
    processedImages,
    uploadId
) {
    const results =
        new Array(
            processedImages.length
        );

    const uncertainSpans =
        [];

    let completed = 0;

    const workers =
        await Promise.all(
            Array.from(
                {
                    length:
                        CONCURRENCY
                },
                () =>
                    Tesseract.createWorker(
                        [
                            'eng',
                            'hin'
                        ]
                    )
            )
        );

    try {
        const queue =
            processedImages.map(
                (buf, idx) => ({
                    buf,
                    idx
                })
            );

        async function runWorker(
            worker
        ) {
            while (
                queue.length >
                0
            ) {
                const task =
                    queue.shift();

                if (!task) {
                    return;
                }

                try {
                    const {
                        data
                    } =
                        await worker.recognize(
                            task.buf
                        );

                    results[
                        task.idx
                    ] = {
                        index:
                            task.idx,
                        text:
                            data.text
                    };

                    if (
                        data.blocks
                    ) {
                        data.blocks.forEach(
                            b =>
                                (
                                    b.paragraphs ||
                                    []
                                ).forEach(
                                    p =>
                                        (
                                            p.lines ||
                                            []
                                        ).forEach(
                                            l =>
                                                (
                                                    l.words ||
                                                    []
                                                ).forEach(
                                                    w => {
                                                        if (
                                                            w.confidence <
                                                            60 &&
                                                            w.text.length >
                                                            3
                                                        ) {
                                                            uncertainSpans.push(
                                                                w.text
                                                            );
                                                        }
                                                    }
                                                )
                                        )
                                )
                        );
                    }

                } catch (
                err
                ) {
                    console.error(
                        `Page ${task.idx + 1} OCR failed:`,
                        err
                    );

                    results[
                        task.idx
                    ] = {
                        index:
                            task.idx,
                        text:
                            '\n[OCR FAILED FOR THIS PAGE]\n'
                    };
                }

                completed++;

                sendProgress(
                    uploadId,
                    'ocr_extraction',
                    35 +
                    Math.round(
                        (
                            completed /
                            processedImages.length
                        ) * 25
                    ),
                    `Reading page ${completed} of ${processedImages.length}...`
                );
            }
        }

        await Promise.all(
            workers.map(
                runWorker
            )
        );

    } finally {
        await Promise.all(
            workers.map(
                w =>
                    w.terminate()
                        .catch(
                            () => { }
                        )
            )
        );
    }

    results.sort(
        (a, b) =>
            a.index -
            b.index
    );

    return {
        results,
        uncertainSpans
    };
}

// Upload pipeline
app.post(
    [
        '/api/upload',
        '/upload'
    ],
    upload.array(
        'pages'
    ),
    async (
        req,
        res
    ) => {
        const uploadId =
            req.body.uploadId ||
            req.headers[
            'x-upload-id'
            ] ||
            Date.now().toString();

        try {
            if (
                !req.files ||
                req.files.length ===
                0
            ) {
                sendProgress(
                    uploadId,
                    'error',
                    0,
                    'No files uploaded'
                );

                return res
                    .status(400)
                    .json({
                        error:
                            'No files uploaded'
                    });
            }

            const fileName =
                req.body.fileName ||
                'document';

            sendProgress(
                uploadId,
                'upload_received',
                15,
                'File received and verified'
            );

            // Stage 0: Validate & Hash
            const hash =
                crypto.createHash(
                    'sha256'
                );

            req.files.forEach(
                f =>
                    hash.update(
                        f.buffer
                    )
            );

            const fileHash =
                hash.digest(
                    'hex'
                );

            const cachedDoc =
                await db.findDocumentByHash(
                    fileHash
                );

            if (
                cachedDoc &&
                cachedDoc.hash ===
                fileHash &&
                cachedDoc.status ===
                'completed' &&
                cachedDoc.pipelineVersion ===
                PIPELINE_VERSION
            ) {
                console.log(
                    `[Stage 0] Cache hit for ${fileHash}`
                );

                sendProgress(
                    uploadId,
                    'completed',
                    100,
                    'Loaded from instant cache',
                    {
                        documentId:
                            cachedDoc.id
                    }
                );

                const clientDoc =
                {
                    ...cachedDoc
                };

                delete clientDoc.paragraphs;

                return res.json(
                    clientDoc
                );
            }

            const docId =
                Date.now().toString();

            const newDoc = {
                id:
                    docId,
                hash:
                    fileHash,
                fileName:
                    fileName,
                uploadDate:
                    new Date().toISOString(),
                status:
                    'processing',
                pipelineVersion:
                    PIPELINE_VERSION
            };

            documents.push(
                newDoc
            );

            await db.saveDocument(
                newDoc
            );

            let combinedRawText =
                '';

            let uncertainSpans =
                [];

            const firstFile =
                req.files[0];

            const isPdf =
                req.files.length ===
                1 &&
                (
                    firstFile.mimetype ===
                    'application/pdf' ||
                    (
                        firstFile.originalname &&
                        firstFile
                            .originalname
                            .toLowerCase()
                            .endsWith(
                                '.pdf'
                            )
                    ) ||
                    (
                        firstFile.buffer &&
                        firstFile
                            .buffer
                            .slice(
                                0,
                                4
                            )
                            .toString() ===
                        '%PDF'
                    )
                );

            let usedDigitalPdf =
                false;

            // PDF analysis
            if (isPdf) {
                sendProgress(
                    uploadId,
                    'pdf_analysis',
                    25,
                    'Analyzing document format and embedded text layer...'
                );

                const parser =
                    new PDFParse({
                        data:
                            firstFile.buffer
                    });

                try {
                    const textResult =
                        await parser.getText();

                    const extractedText =
                        (
                            typeof textResult ===
                                'string'
                                ? textResult
                                : (
                                    textResult?.text ||
                                    ''
                                )
                        ).trim();

                    const printableChars =
                        extractedText
                            .replace(
                                /\s+/g,
                                ''
                            )
                            .length;

                    if (
                        printableChars >
                        50
                    ) {
                        console.log(
                            `[PDF] Digital PDF confirmed: extracted ${printableChars} characters directly via PDFParse.`
                        );

                        sendProgress(
                            uploadId,
                            'ocr_extraction',
                            45,
                            'Digital PDF text layer extracted without OCR'
                        );

                        combinedRawText =
                            extractedText;

                        usedDigitalPdf =
                            true;

                    } else {
                        console.log(
                            `[PDF] Scanned PDF detected (only ${printableChars} chars). Proceeding with OCR.`
                        );

                        sendProgress(
                            uploadId,
                            'ocr_extraction',
                            30,
                            'Scanned PDF detected — initiating OCR engine...'
                        );
                    }

                } catch (
                pdfErr
                ) {
                    console.warn(
                        '[PDF] PDFParse text extraction failed, falling back to OCR:',
                        pdfErr.message
                    );

                } finally {
                    await parser
                        .destroy()
                        .catch(
                            () => { }
                        );
                }
            }

            // OCR path
            if (!usedDigitalPdf) {
                sendProgress(
                    uploadId,
                    'ocr_extraction',
                    35,
                    'Preprocessing and preparing page images for OCR...'
                );

                const processedImages =
                    [];

                if (isPdf) {
                    console.log(
                        '[Stage 1] Rendering scanned PDF into image pages...'
                    );

                    sendProgress(
                        uploadId,
                        'ocr_extraction',
                        35,
                        'Rasterizing scanned PDF pages into image buffers...'
                    );

                    const pdfParser =
                        new PDFParse({
                            data:
                                firstFile.buffer
                        });

                    try {
                        const screenshotResult =
                            await pdfParser.getScreenshot();

                        const pages =
                            screenshotResult
                                ?.pages ||
                            [];

                        console.log(
                            `[Stage 1] Rendered ${pages.length} image page(s) from scanned PDF`
                        );

                        if (
                            pages.length ===
                            0
                        ) {
                            throw new Error(
                                'No pages were rendered from the scanned PDF.'
                            );
                        }

                        for (
                            let i = 0;
                            i < pages.length;
                            i++
                        ) {
                            const imageBuf =
                                Buffer.from(
                                    pages[i]
                                        .data
                                );

                            const buf =
                                await sharp(
                                    imageBuf
                                )
                                    .resize({
                                        width:
                                            1200,
                                        height:
                                            1200,
                                        fit:
                                            'inside',
                                        withoutEnlargement:
                                            true
                                    })
                                    .jpeg({
                                        quality:
                                            80
                                    })
                                    .toBuffer();

                            processedImages.push(
                                buf
                            );
                        }

                    } catch (
                    renderErr
                    ) {
                        console.error(
                            '[Stage 1] Failed to rasterize scanned PDF with PDFParse getScreenshot:',
                            renderErr.message
                        );

                        throw new Error(
                            `Failed to render scanned PDF pages: ${renderErr.message}`
                        );

                    } finally {
                        await pdfParser
                            .destroy()
                            .catch(
                                () => { }
                            );
                    }

                } else {
                    console.log(
                        `[Stage 1] Normalizing ${req.files.length} uploaded image page(s)...`
                    );

                    for (
                        let idx = 0;
                        idx <
                        req.files.length;
                        idx++
                    ) {
                        const buf =
                            await sharp(
                                req.files[
                                    idx
                                ].buffer
                            )
                                .resize({
                                    width:
                                        1200,
                                    height:
                                        1200,
                                    fit:
                                        'inside',
                                    withoutEnlargement:
                                        true
                                })
                                .jpeg({
                                    quality:
                                        80
                                })
                                .toBuffer();

                        processedImages.push(
                            buf
                        );
                    }
                }

                console.log(
                    '[Stage 2] OCR starting (parallel worker pool)...'
                );

                const {
                    results:
                    pagesOcr,
                    uncertainSpans:
                    newUncertain
                } =
                    await ocrPagesParallel(
                        processedImages,
                        uploadId
                    );

                uncertainSpans.push(
                    ...newUncertain
                );

                console.log(
                    '[Stage 3] Assembling text...'
                );

                pagesOcr.sort(
                    (a, b) =>
                        a.index -
                        b.index
                );

                combinedRawText =
                    pagesOcr
                        .map(
                            p =>
                                `--- Page ${p.index + 1} ---\n${p.text}`
                        )
                        .join(
                            '\n\n'
                        );
            }

            const paragraphs =
                combinedRawText
                    .split(
                        /\n\s*\n/
                    )
                    .map(
                        (text, i) => ({
                            i,
                            text:
                                text.trim()
                        })
                    )
                    .filter(
                        p =>
                            p.text.length >
                            0
                    );

            // ==========================================================
            // Stage 4: COMPLETE document Groq processing in chunks
            // ==========================================================
            console.log(
                '[Stage 4] Groq Text structuring...'
            );

            sendProgress(
                uploadId,
                'structuring',
                65,
                'Analyzing the complete document in safe sequential chunks (Groq)...'
            );

            const GROQ_CHUNK_CHARS =
                6500;

            const GROQ_CHUNK_OVERLAP =
                500;

            function splitTextForGroq(
                text,
                chunkSize =
                    GROQ_CHUNK_CHARS,
                overlap =
                    GROQ_CHUNK_OVERLAP
            ) {
                const chunks =
                    [];

                if (!text) {
                    return chunks;
                }

                let start = 0;

                while (
                    start < text.length
                ) {
                    const end =
                        Math.min(
                            start +
                            chunkSize,
                            text.length
                        );

                    chunks.push(
                        text.slice(
                            start,
                            end
                        )
                    );

                    if (
                        end >=
                        text.length
                    ) {
                        break;
                    }

                    start =
                        Math.max(
                            end -
                            overlap,
                            start + 1
                        );
                }

                return chunks;
            }

            const groqChunks =
                splitTextForGroq(
                    combinedRawText
                );

            console.log(
                `[Stage 4] Processing ${groqChunks.length} chunk(s) covering ${combinedRawText.length} characters.`
            );

            const callGroq =
                async (
                    prompt,
                    maxTokens,
                    temp,
                    label
                ) => {
                    try {
                        // Estimate input + output tokens
                        // for the rate limiter.
                        const estimatedInputTokens =
                            Math.ceil(
                                prompt.length /
                                4
                            );

                        const estimatedTokens =
                            estimatedInputTokens +
                            maxTokens;

                        const response =
                            await rateLimiter.fetchWithBackoff(
                                () =>
                                    groq.chat.completions.create(
                                        {
                                            model:
                                                textModel,

                                            messages: [
                                                {
                                                    role:
                                                        'user',
                                                    content:
                                                        prompt
                                                }
                                            ],

                                            temperature:
                                                temp,

                                            max_tokens:
                                                maxTokens
                                        }
                                    ),
                                estimatedTokens
                            );

                        const rawText =
                            response
                                .choices[0]
                                ?.message
                                ?.content ||
                            '';

                        console.log(
                            `[Stage 4 - ${label}] Raw (first 300 chars): ${rawText.substring(0, 300)}`
                        );

                        return {
                            status:
                                'fulfilled',
                            value:
                                rawText
                        };

                    } catch (
                    error
                    ) {
                        console.error(
                            `[Stage 4 - ${label}] GROQ API ERROR:`,
                            error.status,
                            error.message
                        );

                        return {
                            status:
                                'rejected',
                            reason:
                                error
                        };
                    }
                };

            // Each chunk is processed ONE AT A TIME.
            const structCandidates =
                [];

            const summaryCandidates =
                [];

            for (
                let chunkIndex = 0;
                chunkIndex <
                groqChunks.length;
                chunkIndex++
            ) {
                const chunkText =
                    groqChunks[
                    chunkIndex
                    ];

                const label =
                    `CHUNK ${chunkIndex + 1}/${groqChunks.length}`;

                sendProgress(
                    uploadId,
                    'structuring',
                    65 +
                    Math.round(
                        (
                            (
                                chunkIndex +
                                1
                            ) /
                            Math.max(
                                groqChunks.length,
                                1
                            )
                        ) *
                        15
                    ),
                    `Analyzing document section ${chunkIndex + 1} of ${groqChunks.length}...`
                );

                const chunkPrompt =
                    `Analyze this section of an OCR-extracted Indian legal document.

Return ONLY valid JSON using exactly this schema:

{
  "is_legal_document": true,
  "doc_type": "",
  "case_number": "",
  "court_name": "",
  "parties": [],
  "key_dates": [],
  "summary_en": [],
  "summary_hi": []
}

Rules:
- Extract only facts actually supported by this section.
- Do not invent missing information.
- Use an empty string or empty array when the section does not contain the information.
- summary_en must contain 1-2 concise important points from THIS section.
- summary_hi must contain 1-2 corresponding Hindi points.
- Correct obvious OCR errors only when the intended text is unambiguous.
- Do not include markdown.

DOCUMENT SECTION ${chunkIndex + 1} OF ${groqChunks.length}:

${chunkText}

Respond ONLY with a valid JSON object.`;

                const chunkRes =
                    await callGroq(
                        chunkPrompt,
                        1024,
                        0,
                        `STRUCTURE ${label}`
                    );

                if (
                    chunkRes.status !==
                    'fulfilled'
                ) {
                    console.warn(
                        `[Stage 4] ${label} failed; continuing with remaining sections.`
                    );

                    continue;
                }

                try {
                    const parsed =
                        parseThinkingModelJSON(
                            chunkRes.value ||
                            '{}'
                        );

                    if (
                        parsed &&
                        typeof parsed ===
                        'object'
                    ) {
                        structCandidates.push(
                            parsed
                        );

                        summaryCandidates.push(
                            {
                                summary_en:
                                    Array.isArray(
                                        parsed.summary_en
                                    )
                                        ? parsed.summary_en
                                        : [],

                                summary_hi:
                                    Array.isArray(
                                        parsed.summary_hi
                                    )
                                        ? parsed.summary_hi
                                        : []
                            }
                        );
                    }

                } catch (
                e
                ) {
                    console.error(
                        `[Stage 4] JSON Parse failed for ${label}:`,
                        e.message
                    );
                }
            }

            // Merge structured facts from ALL chunks.
            const uniqueByKey =
                (
                    items,
                    keyFn
                ) => {
                    const seen =
                        new Set();

                    const result =
                        [];

                    for (
                        const item of
                        Array.isArray(
                            items
                        )
                            ? items
                            : []
                    ) {
                        if (!item) {
                            continue;
                        }

                        const key =
                            keyFn(
                                item
                            );

                        if (
                            !key ||
                            seen.has(key)
                        ) {
                            continue;
                        }

                        seen.add(
                            key
                        );

                        result.push(
                            item
                        );
                    }

                    return result;
                };

            const isUsefulString =
                value =>
                    typeof value ===
                    'string' &&
                    value
                        .trim()
                        .length >
                    0 &&
                    value
                        .trim()
                        .toUpperCase() !==
                    'N/A';

            let structData =
            {
                is_legal_document:
                    undefined,

                doc_type:
                    '',

                case_number:
                    '',

                court_name:
                    '',

                parties:
                    [],

                key_dates:
                    [],

                old_law_citations:
                    []
            };

            for (
                const candidate of
                structCandidates
            ) {
                if (
                    candidate.is_legal_document ===
                    true
                ) {
                    structData.is_legal_document =
                        true;
                } else if (
                    structData.is_legal_document ===
                    undefined &&
                    typeof candidate.is_legal_document ===
                    'boolean'
                ) {
                    structData.is_legal_document =
                        candidate.is_legal_document;
                }

                if (
                    !isUsefulString(
                        structData.doc_type
                    ) &&
                    isUsefulString(
                        candidate.doc_type
                    )
                ) {
                    structData.doc_type =
                        candidate
                            .doc_type
                            .trim();
                }

                if (
                    !isUsefulString(
                        structData.case_number
                    ) &&
                    isUsefulString(
                        candidate.case_number
                    )
                ) {
                    structData.case_number =
                        candidate
                            .case_number
                            .trim();
                }

                if (
                    !isUsefulString(
                        structData.court_name
                    ) &&
                    isUsefulString(
                        candidate.court_name
                    )
                ) {
                    structData.court_name =
                        candidate
                            .court_name
                            .trim();
                }

                if (
                    Array.isArray(
                        candidate.parties
                    )
                ) {
                    structData.parties.push(
                        ...candidate.parties
                    );
                }

                if (
                    Array.isArray(
                        candidate.key_dates
                    )
                ) {
                    structData.key_dates.push(
                        ...candidate.key_dates
                    );
                }
            }

            structData.parties =
                uniqueByKey(
                    structData.parties,
                    p =>
                        `${String(p.name || '')
                            .trim()
                            .toLowerCase()}|${String(p.role || '')
                                .trim()
                                .toLowerCase()}`
                );

            structData.key_dates =
                uniqueByKey(
                    structData.key_dates,
                    d =>
                        `${String(d.date || '')
                            .trim()
                            .toLowerCase()}|${String(d.event || '')
                                .trim()
                                .toLowerCase()}`
                );

            if (
                structCandidates.some(
                    c =>
                        c.is_legal_document ===
                        true
                )
            ) {
                structData.is_legal_document =
                    true;
            }

            // Final synthesis uses summaries from every chunk,
            // rather than truncating the original document.
            let explainData =
                {};

            if (
                summaryCandidates.length >
                0
            ) {
                const summaryText =
                    JSON.stringify(
                        summaryCandidates
                    );

                const explainPrompt =
                    `Create the final summary for an Indian legal document using ONLY the section summaries below.

Return exactly this JSON schema:

{
  "summary_en": ["3-5 concise bullets in English"],
  "summary_hi": ["3-5 concise bullets in Hindi"],
  "action_required": "one line of urgent action required in plain language, or none apparent",
  "suggested_questions": ["exactly 3 useful questions"]
}

Rules:
- Do not invent facts.
- Combine information across ALL supplied sections.
- Prefer concrete case facts, issues, decisions, and procedural developments.
- Keep the bullets concise.

SECTION SUMMARIES:

${summaryText}

Respond ONLY with valid JSON.`;

                const explainResult =
                    await callGroq(
                        explainPrompt,
                        1024,
                        0.2,
                        'FINAL SYNTHESIS'
                    );

                if (
                    explainResult.status ===
                    'fulfilled'
                ) {
                    try {
                        explainData =
                            parseThinkingModelJSON(
                                explainResult.value ||
                                '{}'
                            );

                        console.log(
                            '[Stage 4b] Parsed explainData keys:',
                            Object.keys(
                                explainData
                            )
                        );

                    } catch (
                    e
                    ) {
                        console.error(
                            '[Stage 4b] JSON Parse failed for FINAL SYNTHESIS:',
                            e.message
                        );
                    }
                }
            }

            sendProgress(
                uploadId,
                'summarizing',
                85,
                'Generating multilingual summaries & action items...'
            );

            if (
                structData.is_legal_document ===
                false
            ) {
                newDoc.status =
                    'failed';

                saveDocuments();

                sendProgress(
                    uploadId,
                    'error',
                    0,
                    'Uploaded file does not appear to be a legal document.'
                );

                return res
                    .status(400)
                    .json({
                        error:
                            'Uploaded file does not appear to be a legal document.'
                    });
            }

            // Deterministic citation extraction
            // ALWAYS sees the complete document.
            const extractedCitations =
                extractCitations(
                    combinedRawText,
                    bnsMap
                );

            // Deterministic fallback
            const fallbackResults =
                applyDeterministicFallbacks(
                    combinedRawText,
                    structData,
                    explainData,
                    extractedCitations
                );

            structData =
                fallbackResults
                    .structData;

            explainData =
                fallbackResults
                    .explainData;

            structData.old_law_citations =
                extractedCitations;

            const finalStructuredData =
            {
                ...structData,
                ...explainData,

                old_law_citations:
                    extractedCitations,

                // IMPORTANT:
                // Store the COMPLETE document.
                raw_text:
                    combinedRawText,

                uncertain_spans:
                    uncertainSpans
            };

            // Stage 5: local embeddings
            const chunks = [];

            for (
                let idx = 0;
                idx <
                paragraphs.length;
                idx++
            ) {
                const p =
                    paragraphs[idx];

                if (
                    !p.text ||
                    p.text.length <
                    10
                ) {
                    continue;
                }

                try {
                    const emb =
                        await getEmbedding(
                            p.text.substring(
                                0,
                                1000
                            )
                        );

                    chunks.push({
                        id:
                            `${docId}_chunk_${idx}`,

                        text:
                            p.text,

                        embedding:
                            emb,

                        source_doc_id:
                            docId,

                        source_filename:
                            fileName
                    });

                } catch (
                e
                ) {
                    console.warn(
                        `[Embeddings] Chunk ${idx} failed:`,
                        e.message
                    );
                }
            }

            // Stage 6: Persist
            newDoc.status =
                'completed';

            newDoc.structuredData =
                finalStructuredData;

            newDoc.caseNumber =
                finalStructuredData.case_number ||
                null;

            newDoc.case_number =
                finalStructuredData.case_number ||
                null;

            newDoc.paragraphs =
                paragraphs;

            newDoc.chunks =
                chunks;

            await db.saveDocument(
                newDoc
            );

            if (
                !fs.existsSync(
                    DEMO_CACHE_FILE
                )
            ) {
                fs.writeFileSync(
                    DEMO_CACHE_FILE,
                    JSON.stringify(
                        newDoc,
                        null,
                        2
                    )
                );
            }

            sendProgress(
                uploadId,
                'completed',
                100,
                'Analysis complete',
                {
                    documentId:
                        newDoc.id
                }
            );

            const clientDoc =
            {
                ...newDoc
            };

            delete clientDoc.paragraphs;

            res.json(
                clientDoc
            );

        } catch (
        error
        ) {
            console.error(
                'Error processing document:',
                error
            );

            sendProgress(
                uploadId,
                'error',
                0,
                error.message ||
                'Failed to process document'
            );

            res
                .status(500)
                .json({
                    error:
                        'Failed to process document'
                });
        }
    }
);

// ============================================================
// Chat Endpoint
// ============================================================
app.post(
    [
        '/api/chat',
        '/chat'
    ],
    async (
        req,
        res
    ) => {
        try {
            const {
                documentId,
                question
            } = req.body;

            const doc =
                await db.getDocumentById(
                    documentId
                );

            if (!doc) {
                return res
                    .status(404)
                    .json({
                        error:
                            'Document not found'
                    });
            }

            // Groq chat helper with input + output token estimation
            const callGroqChat =
                async (
                    messages,
                    maxTokens,
                    temp
                ) => {
                    const promptChars =
                        messages.reduce(
                            (
                                sum,
                                m
                            ) =>
                                sum +
                                String(
                                    m?.content ||
                                    ''
                                ).length,
                            0
                        );

                    const estimatedTokens =
                        Math.ceil(
                            promptChars /
                            4
                        ) +
                        maxTokens;

                    const response =
                        await rateLimiter.fetchWithBackoff(
                            () =>
                                groq.chat.completions.create(
                                    {
                                        model:
                                            textModel,

                                        messages:
                                            messages,

                                        temperature:
                                            temp,

                                        max_tokens:
                                            maxTokens
                                    }
                                ),
                            estimatedTokens
                        );

                    const raw =
                        response
                            .choices[0]
                            ?.message
                            ?.content ||
                        '';

                    return raw
                        .replace(
                            /<think>[\s\S]*?<\/think>/gi,
                            ''
                        )
                        .trim();
                };

            // Tier 0
            const metadata =
                JSON.stringify({
                    doc_type:
                        doc.structuredData
                            ?.doc_type,

                    case_number:
                        doc.structuredData
                            ?.case_number,

                    court_name:
                        doc.structuredData
                            ?.court_name,

                    parties:
                        doc.structuredData
                            ?.parties,

                    key_dates:
                        doc.structuredData
                            ?.key_dates
                });

            console.log(
                '[Chat] Trying Tier 0...'
            );

            const tier0Answer =
                await callGroqChat(
                    [
                        {
                            role:
                                'user',

                            content:
                                `You are a helpful legal assistant. Answer the user's question using ONLY the provided JSON metadata about a legal case. Detect the language of the question and answer in the SAME language (English, Hindi, or Marathi). If the metadata does not contain enough information to answer, reply ONLY with the exact string: INSUFFICIENT_DATA

Metadata:
${metadata}

Question:
${question}`
                        }
                    ],
                    512,
                    0.1
                );

            if (
                tier0Answer &&
                !tier0Answer.includes(
                    'INSUFFICIENT_DATA'
                )
            ) {
                return res.json({
                    answer:
                        tier0Answer,
                    supporting_quote:
                        '',
                    source:
                        'document',
                    unverifiedFigure:
                        false
                });
            }

            // Cross-document pool
            await ensureDocumentChunks(
                doc
            );

            const currentCase =
                doc.structuredData
                    ?.case_number;

            let searchPool =
                [];

            if (
                currentCase &&
                currentCase !==
                'N/A'
            ) {
                searchPool =
                    await db.getChunksForCase(
                        currentCase
                    );
            }

            if (
                !searchPool ||
                searchPool.length ===
                0
            ) {
                searchPool =
                    (
                        doc.chunks ||
                        []
                    ).map(
                        c => ({
                            ...c,
                            source_doc_id:
                                doc.id,
                            source_filename:
                                doc.fileName
                        })
                    );
            }

            // Tier 1
            console.log(
                '[Chat] Trying Tier 1 (Hybrid Retrieval)...'
            );

            let scored =
                [];

            try {
                const questionEmbedding =
                    await getEmbedding(
                        question
                    );

                const qTokens =
                    extractQuestionTokens(
                        question
                    );

                scored =
                    searchPool
                        .map(
                            c => {
                                const vectorScore =
                                    cosineSim(
                                        questionEmbedding,
                                        c.embedding
                                    );

                                let keywordBoost =
                                    0;

                                if (
                                    qTokens.length >
                                    0
                                ) {
                                    const chunkUpper =
                                        c.text.toUpperCase();

                                    for (
                                        const tok of
                                        qTokens
                                    ) {
                                        if (
                                            chunkUpper.includes(
                                                tok
                                            )
                                        ) {
                                            keywordBoost +=
                                                0.15;
                                        }
                                    }
                                }

                                return {
                                    ...c,
                                    score:
                                        vectorScore +
                                        Math.min(
                                            keywordBoost,
                                            0.3
                                        )
                                };
                            }
                        )
                        .sort(
                            (
                                a,
                                b
                            ) =>
                                b.score -
                                a.score
                        )
                        .slice(
                            0,
                            5
                        );

            } catch (
            embedErr
            ) {
                console.warn(
                    '[Chat] Embedding calculation failed, falling back to keyword filter:',
                    embedErr.message
                );

                const keywords =
                    question
                        .toLowerCase()
                        .split(
                            /\W+/
                        )
                        .filter(
                            w =>
                                w.length >
                                3
                        );

                scored =
                    searchPool
                        .filter(
                            c =>
                                keywords.some(
                                    k =>
                                        c.text
                                            .toLowerCase()
                                            .includes(
                                                k
                                            )
                                )
                        )
                        .slice(
                            0,
                            5
                        );
            }

            if (
                scored.length >
                0
            ) {
                const contextText =
                    scored
                        .map(
                            c =>
                                c.text
                        )
                        .join(
                            '\n\n'
                        )
                        .substring(
                            0,
                            10000
                        );

                const tier1Answer =
                    await callGroqChat(
                        [
                            {
                                role:
                                    'user',

                                content:
                                    `You are a helpful legal assistant. Answer the user's question using ONLY the provided text snippets from a legal document. Detect the language of the question and answer in the SAME language (English, Hindi, or Marathi). After your answer, on a new line write QUOTE: followed by a short verbatim phrase from the text that supports your answer. If the text does not contain the answer, reply ONLY with: INSUFFICIENT_DATA

Text snippets:

${contextText}

Question:
${question}`
                            }
                        ],
                        768,
                        0.1
                    );

                if (
                    tier1Answer &&
                    !tier1Answer.includes(
                        'INSUFFICIENT_DATA'
                    )
                ) {
                    const quoteMatch =
                        tier1Answer.match(
                            /QUOTE:\s*(.+)/i
                        );

                    const cleanAnswer =
                        tier1Answer
                            .replace(
                                /QUOTE:.*/i,
                                ''
                            )
                            .trim();

                    const topChunk =
                        scored[0];

                    const isCrossDoc =
                        Boolean(
                            topChunk &&
                            topChunk.source_doc_id &&
                            topChunk.source_doc_id !==
                            doc.id
                        );

                    return res.json({
                        answer:
                            cleanAnswer,

                        supporting_quote:
                            quoteMatch
                                ? quoteMatch[1]
                                    .trim()
                                : '',

                        source:
                            'document',

                        unverifiedFigure:
                            false,

                        cross_document:
                            isCrossDoc,

                        source_filename:
                            isCrossDoc
                                ? topChunk.source_filename
                                : undefined
                    });
                }
            }

            // Tier 2
            console.log(
                '[Chat] Trying Tier 2 (Full Text)...'
            );

            const fullRawText =
                doc
                    .structuredData
                    ?.raw_text ||
                '';

            // Larger fallback context.
            // Primary processing uses 100% of the document.
            const tier2Text =
                fullRawText.substring(
                    0,
                    30000
                );

            const tier2Answer =
                await callGroqChat(
                    [
                        {
                            role:
                                'user',

                            content:
                                `You are a helpful legal assistant. Answer the user's question based on the document text below. Detect the language of the question and answer in the SAME language (English, Hindi, or Marathi). After your answer, on a new line write QUOTE: followed by a short verbatim phrase from the text that supports your answer. If you cannot find a clear answer in the document, reply ONLY with: NOT_IN_DOCUMENT

Document:

${tier2Text}

Question:
${question}`
                        }
                    ],
                    768,
                    0.2
                );

            if (
                tier2Answer &&
                !tier2Answer.includes(
                    'NOT_IN_DOCUMENT'
                ) &&
                tier2Answer.length >
                20
            ) {
                const quoteMatch =
                    tier2Answer.match(
                        /QUOTE:\s*(.+)/i
                    );

                const cleanAnswer =
                    tier2Answer
                        .replace(
                            /QUOTE:.*/i,
                            ''
                        )
                        .trim();

                return res.json({
                    answer:
                        cleanAnswer,

                    supporting_quote:
                        quoteMatch
                            ? quoteMatch[1]
                                .trim()
                            : '',

                    source:
                        'document',

                    unverifiedFigure:
                        false
                });
            }

            // Tier 3
            console.log(
                '[Chat] Falling back to Tier 3 (General Assistant)...'
            );

            const tier3Answer =
                await callGroqChat(
                    [
                        {
                            role:
                                'system',

                            content:
                                `You are a friendly assistant helping someone understand the Indian legal system. Many users are anxious litigants who may not be fluent in English.

STRICT RULES:
- Keep answers SHORT — 2 to 4 plain sentences by default. No markdown headers, no numbered lists, no bold text unless the user explicitly asks for steps or a detailed explanation (e.g. "explain in detail", "what are all the steps").
- If you need to ask a clarifying question, ask ONLY ONE — the single most important one. Never ask multiple questions at once.
- End with ONE brief line: "For advice specific to your situation, consult a qualified advocate."
- Do NOT repeat disclaimers or caveats more than once.
- Detect the language of the user's question (English, Hindi, or Marathi) and respond in the SAME language.
- If the question seems to be about their specific uploaded document, gently suggest they use the document chat instead.`
                        },
                        {
                            role:
                                'user',

                            content:
                                question
                        }
                    ],
                    400,
                    0.4
                );

            const limitationRegex =
                /\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten|fifteen|twenty|thirty|forty-five|sixty|ninety|180|365)\s+(days?|weeks?|months?|years?)\b/i;

            const hasUnverifiedFigure =
                limitationRegex.test(
                    tier3Answer
                );

            return res.json({
                answer:
                    tier3Answer,

                supporting_quote:
                    '',

                source:
                    'general',

                unverifiedFigure:
                    hasUnverifiedFigure
            });

        } catch (
        error
        ) {
            console.error(
                'Chat Error:',
                error
            );

            res
                .status(500)
                .json({
                    error:
                        'Chat failed'
                });
        }
    }
);

// Global Express Error Handler
app.use(
    (
        err,
        req,
        res,
        next
    ) => {
        console.error(
            '[Server Error]',
            err
        );

        if (
            !res.headersSent
        ) {
            res
                .status(
                    err.status ||
                    500
                )
                .json({
                    error:
                        err.message ||
                        'An internal error occurred'
                });
        }
    }
);

const PORT =
    process.env.PORT ||
    5001;

// Initialize database schema and start listening
(async () => {
    try {
        await db.initDB();
    } catch (
    e
    ) {
        console.error(
            '[Startup] DB initialization error:',
            e.message
        );
    }

    app.listen(
        PORT,
        '0.0.0.0',
        () =>
            console.log(
                `Backend listening on 0.0.0.0:${PORT}`
            )
    );
})();