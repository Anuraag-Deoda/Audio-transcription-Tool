// server.js - Enhanced Node.js Express Server with SQLite optimizations
const express = require("express");
const multer = require("multer");
const cors = require("cors");
const path = require("path");
const fs = require("fs").promises;
const { v4: uuidv4 } = require("uuid");
const crypto = require("crypto");
const sqlite3 = require("sqlite3").verbose();
const winston = require("winston");
const { spawn, exec } = require("child_process");
const sanitize = require("sanitize-filename");
const rateLimit = require("express-rate-limit");

const app = express();
const PORT = process.env.PORT || 3001;

// Enhanced logging
const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json()
    ),
    transports: [
        new winston.transports.File({ filename: 'error.log', level: 'error' }),
        new winston.transports.File({ filename: 'combined.log' }),
        new winston.transports.Console({ format: winston.format.simple() })
    ]
});

app.use(cors());
app.use(express.json());
app.use('/api/transcribe', rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, // Limit to 100 requests per IP
    message: 'Too many transcription requests, please try again later.'
}));

// Initialize SQLite database
const db = new sqlite3.Database('./transcription_jobs.db');

// Initialize database tables
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        filename TEXT,
        file_hash TEXT,
        status TEXT DEFAULT 'pending',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        started_at DATETIME,
        completed_at DATETIME,
        result TEXT,
        error TEXT,
        file_size INTEGER,
        duration REAL,
        processing_time REAL
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS job_cache (
        file_hash TEXT PRIMARY KEY,
        result TEXT,
        file_size INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        access_count INTEGER DEFAULT 1,
        last_accessed DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_jobs_created ON jobs(created_at)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_cache_accessed ON job_cache(last_accessed)`);
});

// Set WAL mode for better concurrent access
db.run("PRAGMA journal_mode=WAL");

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, "uploads/");
    },
    filename: (req, file, cb) => {
        const uniqueName = `${uuidv4()}-${sanitize(file.originalname)}`;
        cb(null, uniqueName);
    }
});

const upload = multer({
    storage: storage,
    limits: { fileSize: 100 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const allowedMimes = [
            "audio/mpeg", "audio/wav", "audio/m4a", "audio/mp4", "audio/ogg", "audio/webm",
            "video/mp4", "video/webm", "video/quicktime", "video/x-msvideo", "video/x-flv", "video/x-matroska"
        ];
        if (allowedMimes.includes(file.mimetype)) cb(null, true);
        else cb(new Error("Invalid file type. Please upload an audio or video file."), false);
    }
});

// Process Pool Management
class WhisperProcessPool {
    constructor(poolSize = 2) {
        this.poolSize = poolSize;
        this.processes = [];
        this.busy = new Set();
        this.queue = [];
        this.initPool();
    }

    async initPool() {
        logger.info(`Initializing Whisper process pool with ${this.poolSize} processes`);
    }

    async getAvailableProcess() {
        const availableProcess = this.processes.find(p => !this.busy.has(p.id));
        if (availableProcess) return availableProcess;
        if (this.processes.length < this.poolSize) return await this.createProcess();
        return new Promise((resolve) => this.queue.push(resolve));
    }

    async createProcess() {
        const process = { id: uuidv4(), created: Date.now(), used: 0 };
        this.processes.push(process);
        logger.info(`Created new Whisper process: ${process.id}`);
        return process;
    }

    async executeTranscription(audioPath, fileHash) {
        const process = await this.getAvailableProcess();
        this.busy.add(process.id);
        try {
            const result = await this.runWhisperTranscription(audioPath, fileHash);
            process.used++;
            await this.restartProcess(process);
            return result;
        } finally {
            this.busy.delete(process.id);
            if (this.queue.length > 0) {
                const nextResolve = this.queue.shift();
                nextResolve(process);
            }
        }
    }

    async restartProcess(process) {
        if (process.used > 10) { // Restart after 10 uses
            logger.info(`Restarting process ${process.id} after ${process.used} uses.`);
            const index = this.processes.findIndex(p => p.id === process.id);
            if (index !== -1) {
                this.processes.splice(index, 1);
                await this.createProcess();
            }
        }
    }

    async runWhisperTranscription(audioPath, fileHash) {
        return new Promise((resolve, reject) => {
            const venvPythonPath = "./venv/bin/python";
            const scriptPath = path.join(__dirname, "whisperx_transcribe.py");
            const startTime = Date.now();
            logger.info(`Starting transcription for ${fileHash} using script: ${scriptPath}`);

            const pythonParams = {
                audio_path: audioPath,
                model_size: "base",
                device: "cpu",
                compute_type: "float32",
                batch_size: 8,
                language: null, // Let the model detect language
                max_duration_minutes: 120,
                filtering_level: "standard",
                vad_filter: true,
                vad_parameters: { threshold: 0.5, min_speech_duration_ms: 250 }
            };

            const pythonProcess = spawn(venvPythonPath, [scriptPath], {
                stdio: ['pipe', 'pipe', 'pipe'],
                env: { ...process.env, PYTHONUNBUFFERED: '1' }
            });
            let stdout = "", stderr = "";
            const timeoutId = setTimeout(() => {
                pythonProcess.kill('SIGTERM');
                reject(new Error("Transcription timeout after 10 minutes"));
            }, 10 * 60 * 1000);

            pythonProcess.stdin.write(JSON.stringify(pythonParams));
            pythonProcess.stdin.end();

            pythonProcess.stdout.on("data", (data) => { stdout += data.toString(); });
            pythonProcess.stderr.on("data", (data) => { stderr += data.toString(); logger.debug(`[Python STDERR]: ${data.toString()}`); });

            pythonProcess.on("close", (code) => {
                clearTimeout(timeoutId);
                if (code === 0) {
                    try {
                        if (!stdout) throw new Error("Python script returned empty output.");
                        const jsonStartIndex = stdout.indexOf('{');
                        if (jsonStartIndex === -1) throw new Error("No JSON object found in Python script output.");
                        const result = JSON.parse(stdout.substring(jsonStartIndex));
                        if (result.status === "success") resolve(result.data);
                        else throw new Error(result.message || "Python script reported an error");
                    } catch (error) {
                        logger.error("Failed to parse Python JSON output.", { error_message: error.message, raw_stdout: stdout });
                        reject(new Error("Failed to process Python script output."));
                    }
                } else {
                    logger.error(`Python script failed with code ${code}:`, { stderr });
                    reject(new Error(`Whisper script failed: ${stderr || 'Unknown error'}`));
                }
            });

            pythonProcess.on("error", (error) => {
                clearTimeout(timeoutId);
                reject(new Error(`Failed to start Python process: ${error.message}`));
            });
        });
    }
}

const whisperPool = new WhisperProcessPool(2);

const generateFileHash = (filePath) => new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = require('fs').createReadStream(filePath);
    stream.on('data', data => hash.update(data)).on('end', () => resolve(hash.digest('hex'))).on('error', reject);
});

const checkCache = (fileHash) => new Promise((resolve) => {
    db.get("SELECT result FROM job_cache WHERE file_hash = ?", [fileHash], (err, row) => {
        if (err) { logger.error("Cache check error:", err); resolve(null); }
        else if (row) {
            db.run("UPDATE job_cache SET access_count = access_count + 1, last_accessed = CURRENT_TIMESTAMP WHERE file_hash = ?", [fileHash]);
            logger.info(`Cache hit for file hash: ${fileHash}`);
            resolve(JSON.parse(row.result));
        } else resolve(null);
    });
});

const saveToCache = (fileHash, result, fileSize) => new Promise((resolve, reject) => {
    db.run("INSERT OR REPLACE INTO job_cache (file_hash, result, file_size) VALUES (?, ?, ?)", [fileHash, JSON.stringify(result), fileSize], (err) => {
        if (err) { logger.error("Cache save error:", err); reject(err); }
        else { logger.info(`Cached result for file hash: ${fileHash}`); resolve(); }
    });
});

const ensureUploadsDir = async () => {
    try { await fs.access("uploads"); } catch { await fs.mkdir("uploads", { recursive: true }); }
};

const extractAudioFromVideo = (videoPath, outputPath) => new Promise((resolve, reject) => {
    exec('which ffmpeg', (error) => {
        if (error) {
            logger.error("ffmpeg not found. Please install ffmpeg.");
            return reject(new Error("ffmpeg not found. Please install ffmpeg and ensure it's in your system's PATH."));
        }
        const command = `ffmpeg -y -i "${sanitize(videoPath)}" -vn -acodec pcm_s16le -ar 16000 -ac 1 "${sanitize(outputPath)}"`;
        logger.info(`Executing ffmpeg command: ${command}`);
        exec(command, (execError, stdout, stderr) => {
            if (execError) {
                logger.error(`ffmpeg error: ${execError.message}`, { stderr });
                return reject(new Error(`Failed to extract audio from video: ${execError.message}`));
            }
            logger.info(`Audio extracted to: ${outputPath}`);
            resolve(outputPath);
        });
    });
});

const processTranscriptionData = (whisperResult) => {
    if (!whisperResult || !whisperResult.segments || whisperResult.segments.length === 0) {
        return { text: '', language: 'unknown', duration: 0, words: [], sentences: [], paragraphs: [] };
    }

    const allWords = [];
    const sentences = whisperResult.segments.map(segment => {
        const sentenceWords = (segment.words || []).map(word => ({
            word: word.word.trim(),
            start: word.start,
            end: word.end,
            confidence: word.probability || word.confidence || 0.95
        }));
        allWords.push(...sentenceWords);
        return {
            text: segment.text.trim(),
            start: segment.start,
            end: segment.end,
            words: sentenceWords,
        };
    });

    const paragraphs = [];
    let currentParagraph = { text: "", start: null, end: null, sentences: [] };
    let lastEnd = 0;
    sentences.forEach((sentence, index) => {
        if (currentParagraph.start === null) currentParagraph.start = sentence.start;
        
        // Group by pauses greater than 2 seconds
        if (lastEnd > 0 && (sentence.start - lastEnd > 2.0)) {
            currentParagraph.text = currentParagraph.text.trim();
            paragraphs.push({ ...currentParagraph });
            currentParagraph = { text: "", start: sentence.start, end: null, sentences: [] };
        }

        currentParagraph.text += sentence.text + " ";
        currentParagraph.sentences.push(sentence);
        currentParagraph.end = sentence.end;
        lastEnd = sentence.end;

        if (index === sentences.length - 1) {
             currentParagraph.text = currentParagraph.text.trim();
             paragraphs.push({ ...currentParagraph });
        }
    });

    const duration = whisperResult.duration || whisperResult.segments[whisperResult.segments.length - 1].end || 0;

    return {
        text: whisperResult.text,
        language: whisperResult.language,
        duration: duration,
        words: allWords,
        sentences,
        paragraphs,
        processing_time: whisperResult.processing_time,
        processed_at: whisperResult.processed_at,
        raw_whisper_data: whisperResult
    };
};

const cleanupOldCache = () => {
    const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    db.run("DELETE FROM job_cache WHERE last_accessed < ?", [oneWeekAgo], function (err) {
        if (err) logger.error("Cache cleanup error:", err);
        else if (this.changes > 0) logger.info(`Cleaned up ${this.changes} old cache entries`);
    });
};

const cleanupOldJobs = () => {
    const oneMonthAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    db.run("DELETE FROM jobs WHERE created_at < ?", [oneMonthAgo], function (err) {
        if (err) logger.error("Job cleanup error:", err);
        else if (this.changes > 0) logger.info(`Cleaned up ${this.changes} old job records`);
    });
};

setInterval(() => { cleanupOldCache(); cleanupOldJobs(); }, 60 * 60 * 1000);

// Routes
app.get("/api/health", (req, res) => {
    db.get("SELECT 1", (err) => {
        res.json({
            status: "OK", message: "Audio Transcription API is running",
            uptime: Math.floor(process.uptime()),
            memory: { used: Math.round(process.memoryUsage().heapUsed / 1024 / 1024), total: Math.round(process.memoryUsage().heapTotal / 1024 / 1024) },
            database: err ? 'error' : 'ok',
            processPool: { active: whisperPool.processes.length, busy: whisperPool.busy.size, queue: whisperPool.queue.length }
        });
    });
});

app.post("/api/transcribe", upload.single("audio"), async (req, res) => {
    const jobId = uuidv4();
    const startTime = Date.now();
    let extractedAudioPath = null;

    try {
        if (!req.file) return res.status(400).json({ error: "No file uploaded" });
        
        let filePathToTranscribe = req.file.path;
        if (req.file.mimetype.startsWith('video/')) {
            logger.info(`Video file detected: ${req.file.originalname}. Extracting audio...`);
            extractedAudioPath = path.join('uploads', `${uuidv4()}_extracted_audio.wav`);
            await extractAudioFromVideo(req.file.path, extractedAudioPath);
            filePathToTranscribe = extractedAudioPath;
        }
        
        const fileStats = await fs.stat(req.file.path);
        const fileHash = await generateFileHash(req.file.path); // Hash original file for caching
        logger.info(`Processing file: ${req.file.filename}, size: ${fileStats.size}, hash: ${fileHash}`);

        db.run("INSERT INTO jobs (id, filename, file_hash, file_size, started_at) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)", [jobId, req.file.filename, fileHash, fileStats.size]);

        const cachedResult = await checkCache(fileHash);
        if (cachedResult) {
            db.run("UPDATE jobs SET status = 'completed', completed_at = CURRENT_TIMESTAMP WHERE id = ?", [jobId]);
            logger.info(`Cache hit for job ${jobId}, returning cached result`);
            res.json(cachedResult);
        } else {
            db.run("UPDATE jobs SET status = 'processing' WHERE id = ?", [jobId]);
            const whisperResult = await whisperPool.executeTranscription(filePathToTranscribe, fileHash);
            const processedResult = processTranscriptionData(whisperResult);
            await saveToCache(fileHash, processedResult, fileStats.size);

            const processingTime = (Date.now() - startTime) / 1000;
            db.run("UPDATE jobs SET status = 'completed', completed_at = CURRENT_TIMESTAMP, processing_time = ?, result = ? WHERE id = ?", [processingTime, JSON.stringify(processedResult), jobId]);
            logger.info(`Transcription completed successfully for job ${jobId} in ${processingTime}s`);
            res.json(processedResult);
        }
    } catch (error) {
        logger.error(`Transcription error for job ${jobId}:`, { message: error.message, stack: error.stack });
        db.run("UPDATE jobs SET status = 'failed', error = ? WHERE id = ?", [error.message, jobId]);
        res.status(500).json({ error: error.message || "Failed to transcribe audio", jobId });
    } finally {
        // Cleanup all files in finally block to ensure execution
        if (req.file) try { await fs.unlink(req.file.path); } catch (e) { logger.error("Error cleaning up original file:", e); }
        if (extractedAudioPath) try { await fs.unlink(extractedAudioPath); } catch (e) { logger.error("Error cleaning up extracted audio:", e); }
    }
});

app.get("/api/formats", (req, res) => {
    res.json({
        supported_formats: ["mp3", "wav", "m4a", "mp4", "ogg", "webm", "quicktime", "avi", "flv", "mkv"],
        max_file_size: "100MB",
        features: ["Word-level timestamps", "Confidence scores", "Language detection", "Video audio extraction", "Intelligent caching", "Process pooling"]
    });
});

app.get("/api/stats", (req, res) => {
    db.all(`SELECT COUNT(*) as total_jobs, COUNT(CASE WHEN status = 'completed' THEN 1 END) as completed_jobs, COUNT(CASE WHEN status = 'failed' THEN 1 END) as failed_jobs, AVG(processing_time) as avg_processing_time, SUM(file_size) as total_bytes_processed FROM jobs WHERE created_at > datetime('now', '-7 days')`, (err, rows) => {
        if (err) return res.status(500).json({ error: "Failed to fetch statistics" });
        db.get(`SELECT COUNT(*) as cache_entries, SUM(access_count) as total_cache_hits, SUM(file_size) as cached_bytes FROM job_cache`, (cacheErr, cacheStats) => {
            if (cacheErr) return res.status(500).json({ error: "Failed to fetch cache statistics" });
            res.json({ jobs: rows[0], cache: cacheStats, period: "last_7_days" });
        });
    });
});

app.use((error, req, res, next) => {
    if (error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE") {
        return res.status(400).json({ error: "File too large. Maximum size is 100MB." });
    }
    logger.error("Unhandled middleware error:", { message: error.message, stack: error.stack });
    res.status(500).json({ error: "Internal server error" });
});

const startServer = async () => {
    await ensureUploadsDir();
    app.listen(PORT, () => {
        logger.info(`✓ Server running on port ${PORT}`);
        logger.info(`→ API endpoint: http://localhost:${PORT}/api/transcribe`);
    });
};

startServer().catch((error) => { logger.error("Failed to start server:", error); process.exit(1); });

const gracefulShutdown = (signal) => {
    logger.info(`Received ${signal}, shutting down gracefully`);
    db.close((err) => {
        if (err) logger.error("Error closing database:", err);
        else logger.info("Database connection closed");
        process.exit(0);
    });
};

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on('uncaughtException', (error) => { logger.error('Uncaught Exception:', { message: error.message, stack: error.stack }); process.exit(1); });
process.on('unhandledRejection', (reason, promise) => { logger.error('Unhandled Rejection:', { reason }); });