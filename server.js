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
const { spawn, exec } = require("child_process"); // Add 'exec' here

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
    const uniqueName = `${uuidv4()}-${file.originalname}`;
    cb(null, uniqueName);
  }
});

const upload = multer({
  storage: storage,
  limits: {
    fileSize: 100 * 1024 * 1024, 
  },
  fileFilter: (req, file, cb) => {
    const allowedMimes = [
      "audio/mpeg",
      "audio/wav", 
      "audio/m4a",
      "audio/mp4",
      "audio/ogg",
      "audio/webm",

      // --- NEW: Added video mimetypes ---
      "video/mp4",
      "video/webm",
      "video/quicktime",
      "video/x-msvideo", // Common for .avi
      "video/x-flv",     // Common for .flv
      "video/x-matroska" // Common for .mkv
      // --- END NEW ---
    ];
    
    if (allowedMimes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error("Invalid file type. Please upload an audio file."), false);
    }
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

  initPool() {
    logger.info(`Initializing Whisper process pool with ${this.poolSize} processes`);
    // Pre-warm processes will be created on demand to avoid startup overhead
  }

  async getAvailableProcess() {
    // Find available process
    const availableProcess = this.processes.find(p => !this.busy.has(p.id));
    if (availableProcess) {
      return availableProcess;
    }

    // Create new process if under limit
    if (this.processes.length < this.poolSize) {
      const process = await this.createProcess();
      return process;
    }

    // Wait for available process
    return new Promise((resolve) => {
      this.queue.push(resolve);
    });
  }

  async createProcess() {
    const processId = uuidv4();
    const process = {
      id: processId,
      created: Date.now(),
      used: 0
    };
    
    this.processes.push(process);
    logger.info(`Created new Whisper process: ${processId}`);
    return process;
  }

  async executeTranscription(audioPath, fileHash) {
    const process = await this.getAvailableProcess();
    this.busy.add(process.id);
    
    try {
      const result = await this.runWhisperTranscription(audioPath, fileHash);
      process.used++;
      
      // Restart process if used too many times (prevent memory leaks)
      if (process.used > 10) {
        await this.restartProcess(process);
      }
      
      return result;
    } finally {
      this.busy.delete(process.id);
      
      // Process next in queue
      if (this.queue.length > 0) {
        const nextResolve = this.queue.shift();
        nextResolve(process);
      }
    }
  }

  async restartProcess(process) {
    logger.info(`Restarting process ${process.id} after ${process.used} uses`);
    const index = this.processes.findIndex(p => p.id === process.id);
    if (index !== -1) {
      this.processes.splice(index, 1);
    }
  }

  async runWhisperTranscription(audioPath, fileHash) {
    return new Promise((resolve, reject) => {
      const venvPythonPath = "./venv/bin/python";
      const startTime = Date.now();
      
      logger.info(`Starting transcription for ${fileHash}`);
      
      const pythonProcess = spawn(venvPythonPath, ["whisper_transcribe.py", audioPath, "base"], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, PYTHONUNBUFFERED: '1' }
      });

      let stdout = "";
      let stderr = "";
      let timeoutId;

      // Set timeout for long-running processes
      timeoutId = setTimeout(() => {
        pythonProcess.kill('SIGTERM');
        reject(new Error("Transcription timeout after 10 minutes"));
      }, 10 * 60 * 1000);

      pythonProcess.stdout.on("data", (data) => {
        stdout += data.toString();
      });

      pythonProcess.stderr.on("data", (data) => {
        stderr += data.toString();
      });

      pythonProcess.on("close", (code) => {
        clearTimeout(timeoutId);
        const processingTime = (Date.now() - startTime) / 1000;
        
        logger.info(`Python process exited with code ${code}, processing time: ${processingTime}s`);

        if (code === 0) {
          try {
            const jsonStartIndex = stdout.indexOf("{");
            const jsonEndIndex = stdout.lastIndexOf("}");

            if (jsonStartIndex === -1 || jsonEndIndex === -1) {
              throw new Error("Valid JSON not found in Whisper output");
            }

            const jsonString = stdout.substring(jsonStartIndex, jsonEndIndex + 1);
            const result = JSON.parse(jsonString);
            
            // Add processing metadata
            result.processing_time = processingTime;
            result.processed_at = new Date().toISOString();
            
            resolve(result);
          } catch (error) {
            logger.error("Failed to parse Whisper JSON:", error);
            logger.error("Stdout:", stdout);
            reject(new Error("Failed to parse Whisper output"));
          }
        } else {
          logger.error(`Whisper failed with code ${code}:`, stderr);
          reject(new Error(`Whisper failed: ${stderr}`));
        }
      });

      pythonProcess.on("error", (error) => {
        clearTimeout(timeoutId);
        logger.error("Python process error:", error);
        reject(new Error(`Failed to start Python process: ${error.message}`));
      });
    });
  }
}

// Initialize process pool
const whisperPool = new WhisperProcessPool(2);

// Utility functions
const generateFileHash = (filePath) => {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = require('fs').createReadStream(filePath);
    
    stream.on('data', data => hash.update(data));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
};

const checkCache = (fileHash) => {
  return new Promise((resolve, reject) => {
    db.get(
      "SELECT result FROM job_cache WHERE file_hash = ?",
      [fileHash],
      (err, row) => {
        if (err) {
          logger.error("Cache check error:", err);
          resolve(null);
        } else if (row) {
          // Update access count and last accessed
          db.run(
            "UPDATE job_cache SET access_count = access_count + 1, last_accessed = CURRENT_TIMESTAMP WHERE file_hash = ?",
            [fileHash]
          );
          
          logger.info(`Cache hit for file hash: ${fileHash}`);
          resolve(JSON.parse(row.result));
        } else {
          resolve(null);
        }
      }
    );
  });
};

const saveToCache = (fileHash, result, fileSize) => {
  return new Promise((resolve, reject) => {
    db.run(
      "INSERT OR REPLACE INTO job_cache (file_hash, result, file_size) VALUES (?, ?, ?)",
      [fileHash, JSON.stringify(result), fileSize],
      (err) => {
        if (err) {
          logger.error("Cache save error:", err);
          reject(err);
        } else {
          logger.info(`Cached result for file hash: ${fileHash}`);
          resolve();
        }
      }
    );
  });
};

const ensureUploadsDir = async () => {
  try {
    await fs.access("uploads");
  } catch {
    await fs.mkdir("uploads", { recursive: true });
  }
};

// ... (after ensureUploadsDir function)

const extractAudioFromVideo = (videoPath, outputPath) => {
  return new Promise((resolve, reject) => {
    // First, check if ffmpeg is installed and available
    exec('which ffmpeg', (error, stdout, stderr) => {
      if (error) {
        logger.error("ffmpeg not found. Please install ffmpeg to enable video processing.");
        return reject(new Error("ffmpeg not found. Please install ffmpeg and ensure it's in your system's PATH."));
      }

      // ffmpeg command to extract audio:
      // -i: input file
      // -vn: no video
      // -acodec pcm_s16le: audio codec (uncompressed PCM, 16-bit signed little-endian)
      // -ar 16000: audio sample rate (16kHz, ideal for Whisper)
      // -map_metadata -1: remove all metadata from the output
      const command = `ffmpeg -i "${videoPath}" -vn -acodec pcm_s16le -ar 16000 -map_metadata -1 "${outputPath}"`;
      logger.info(`Executing ffmpeg command: ${command}`);

      exec(command, (error, stdout, stderr) => {
        if (error) {
          logger.error(`ffmpeg error: ${error.message}`);
          logger.error(`ffmpeg stderr: ${stderr}`); // Log stderr for more details
          return reject(new Error(`Failed to extract audio from video: ${error.message}`));
        }
        logger.info(`Audio extracted to: ${outputPath}`);
        resolve(outputPath);
      });
    });
  });
};



const processTranscriptionData = (whisperResult) => {
  const words = [];
  const sentences = [];
  const paragraphs = [];
  
  if (whisperResult.segments) {
    whisperResult.segments.forEach((segment) => {
      if (segment.words) {
        segment.words.forEach((word) => {
          words.push({
            word: word.word.trim(),
            start: word.start,
            end: word.end,
            confidence: word.probability || 0.95
          });
        });
      }
    });
  }
  
  let currentSentence = {
    text: "",
    start: null,
    end: null,
    words: []
  };
  
  words.forEach((word, index) => {
    if (currentSentence.start === null) {
      currentSentence.start = word.start;
    }
    
    currentSentence.text += word.word;
    currentSentence.words.push(index);
    currentSentence.end = word.end;
    
    const endsWithPunct = /[.!?]$/.test(word.word);
    const isLongSentence = currentSentence.words.length >= 15;
    
    if (endsWithPunct || isLongSentence || index === words.length - 1) {
      sentences.push({ ...currentSentence });
      currentSentence = {
        text: "",
        start: null,
        end: null,
        words: []
      };
    } else {
      currentSentence.text += " ";
    }
  });
  
  let currentParagraph = {
    text: "",
    start: null,
    end: null,
    sentences: []
  };
  
  sentences.forEach((sentence, index) => {
    if (currentParagraph.start === null) {
      currentParagraph.start = sentence.start;
    }
    
    currentParagraph.text += sentence.text + " ";
    currentParagraph.sentences.push(index);
    currentParagraph.end = sentence.end;
    
    if (currentParagraph.sentences.length >= 4 || index === sentences.length - 1) {
      currentParagraph.text = currentParagraph.text.trim();
      paragraphs.push({ ...currentParagraph });
      currentParagraph = {
        text: "",
        start: null,
        end: null,
        sentences: []
      };
    }
  });
  
  return {
    text: whisperResult.text,
    language: whisperResult.language,
    duration: whisperResult.segments ? 
      Math.max(...whisperResult.segments.map(s => s.end)) : 0,
    words,
    sentences,
    paragraphs,
    processing_time: whisperResult.processing_time,
    processed_at: whisperResult.processed_at,
    raw_whisper_data: whisperResult
  };
};

// Cleanup functions
const cleanupOldCache = () => {
  const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  
  db.run(
    "DELETE FROM job_cache WHERE last_accessed < ?",
    [oneWeekAgo],
    function(err) {
      if (err) {
        logger.error("Cache cleanup error:", err);
      } else {
        logger.info(`Cleaned up ${this.changes} old cache entries`);
      }
    }
  );
};

const cleanupOldJobs = () => {
  const oneMonthAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  
  db.run(
    "DELETE FROM jobs WHERE created_at < ?",
    [oneMonthAgo],
    function(err) {
      if (err) {
        logger.error("Job cleanup error:", err);
      } else {
        logger.info(`Cleaned up ${this.changes} old job records`);
      }
    }
  );
};

// Run cleanup every hour
setInterval(() => {
  cleanupOldCache();
  cleanupOldJobs();
}, 60 * 60 * 1000);

// Memory monitoring
const monitorMemory = () => {
  const usage = process.memoryUsage();
  const memoryMB = Math.round(usage.heapUsed / 1024 / 1024);
  
  if (memoryMB > 1024) { // 1GB threshold
    logger.warn(`High memory usage detected: ${memoryMB}MB`);
    
    // Force garbage collection if available
    if (global.gc) {
      global.gc();
      logger.info("Forced garbage collection");
    }
  }
};

setInterval(monitorMemory, 5 * 60 * 1000); // Check every 5 minutes

// Routes
app.get("/api/health", (req, res) => {
  const uptime = process.uptime();
  const memoryUsage = process.memoryUsage();
  
  // Check database connectivity
  db.get("SELECT 1", (err) => {
    const dbStatus = err ? 'error' : 'ok';
    
    res.json({
      status: "OK",
      message: "Audio Transcription API is running",
      uptime: Math.floor(uptime),
      memory: {
        used: Math.round(memoryUsage.heapUsed / 1024 / 1024),
        total: Math.round(memoryUsage.heapTotal / 1024 / 1024)
      },
      database: dbStatus,
      processPool: {
        active: whisperPool.processes.length,
        busy: whisperPool.busy.size,
        queue: whisperPool.queue.length
      }
    });
  });
});

app.post("/api/transcribe", upload.single("audio"), async (req, res) => {
  const jobId = uuidv4();
  const startTime = Date.now();
  
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No audio file uploaded" });
    }
    
     // --- NEW: Check if the uploaded file is a video ---
     const isVideo = req.file.mimetype.startsWith('video/');

     if (isVideo) {
       logger.info(`Video file uploaded: ${req.file.originalname}. Extracting audio...`);
       // Create a unique path for the extracted audio file
       extractedAudioPath = path.join('uploads', `${uuidv4()}_extracted_audio.wav`);
       await extractAudioFromVideo(req.file.path, extractedAudioPath);
       filePathToTranscribe = extractedAudioPath; // Use the extracted audio for transcription
     }
     // --- END NEW ---

    const fileStats = await fs.stat(req.file.path);
    const fileHash = await generateFileHash(req.file.path);
    
    logger.info(`Processing file: ${req.file.filename}, size: ${fileStats.size}, hash: ${fileHash}`);
    
    // Record job in database
    db.run(
      "INSERT INTO jobs (id, filename, file_hash, file_size, started_at) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)",
      [jobId, req.file.filename, fileHash, fileStats.size]
    );
    
    // Check cache first
    const cachedResult = await checkCache(fileHash);
    if (cachedResult) {
      // Clean up uploaded file
      await fs.unlink(req.file.path);
      
      // Update job status
      db.run(
        "UPDATE jobs SET status = 'completed', completed_at = CURRENT_TIMESTAMP WHERE id = ?",
        [jobId]
      );
      
      logger.info(`Cache hit for job ${jobId}, returning cached result`);
      return res.json(cachedResult);
    }
    
    // Update job status to processing
    db.run("UPDATE jobs SET status = 'processing' WHERE id = ?", [jobId]);
    
    // Process with worker pool
    const whisperResult = await whisperPool.executeTranscription(req.file.path, fileHash);
    const processedResult = processTranscriptionData(whisperResult);
    
    // Save to cache
    await saveToCache(fileHash, processedResult, fileStats.size);
    
    // Update job status
    const processingTime = (Date.now() - startTime) / 1000;
    db.run(
      "UPDATE jobs SET status = 'completed', completed_at = CURRENT_TIMESTAMP, processing_time = ?, result = ? WHERE id = ?",
      [processingTime, JSON.stringify(processedResult), jobId]
    );
    
    // Clean up uploaded file
    await fs.unlink(req.file.path);
    
    logger.info(`Transcription completed successfully for job ${jobId} in ${processingTime}s`);
    res.json(processedResult);
    
  } catch (error) {
    logger.error(`Transcription error for job ${jobId}:`, error);
    
    // Update job status
    db.run(
      "UPDATE jobs SET status = 'failed', error = ? WHERE id = ?",
      [error.message, jobId]
    );
    
    // Clean up file if it exists
    if (req.file) {
      try {
        await fs.unlink(req.file.path);
      } catch (cleanupError) {
        logger.error("Error cleaning up file:", cleanupError);
      }
    }
    
    res.status(500).json({ 
      error: error.message || "Failed to transcribe audio",
      jobId: jobId
    });
  }
});

app.get("/api/formats", (req, res) => {
  res.json({
    supported_formats: [
      "mp3", "wav", "m4a", "mp4", "ogg", "webm"
    ],
    max_file_size: "100MB",
    features: [
      "Word-level timestamps",
      "Confidence scores",
      "Multiple output formats",
      "Language detection",
      "Intelligent caching",
      "Process pooling"
    ]
  });
});

// Statistics endpoint
app.get("/api/stats", (req, res) => {
  db.all(`
    SELECT 
      COUNT(*) as total_jobs,
      COUNT(CASE WHEN status = 'completed' THEN 1 END) as completed_jobs,
      COUNT(CASE WHEN status = 'failed' THEN 1 END) as failed_jobs,
      AVG(processing_time) as avg_processing_time,
      SUM(file_size) as total_bytes_processed
    FROM jobs 
    WHERE created_at > datetime('now', '-7 days')
  `, (err, rows) => {
    if (err) {
      return res.status(500).json({ error: "Failed to fetch statistics" });
    }
    
    db.get(`
      SELECT 
        COUNT(*) as cache_entries,
        SUM(access_count) as total_cache_hits,
        SUM(file_size) as cached_bytes
      FROM job_cache
    `, (err, cacheStats) => {
      if (err) {
        return res.status(500).json({ error: "Failed to fetch cache statistics" });
      }
      
      res.json({
        jobs: rows[0],
        cache: cacheStats,
        period: "last_7_days"
      });
    });
  });
});

app.use((error, req, res, next) => {
  if (error instanceof multer.MulterError) {
    if (error.code === "LIMIT_FILE_SIZE") {
      return res.status(400).json({ error: "File too large. Maximum size is 100MB." });
    }
  }
  
  logger.error("Unhandled error:", error);
  res.status(500).json({ error: "Internal server error" });
});

const startServer = async () => {
  await ensureUploadsDir();
  
  app.listen(PORT, () => {
    logger.info(`🚀 Enhanced Audio Transcription Server running on port ${PORT}`);
    logger.info(`📡 API endpoint: http://localhost:${PORT}/api`);
    logger.info(`🎵 Upload audio files to: http://localhost:${PORT}/api/transcribe`);
    logger.info(`📊 Statistics available at: http://localhost:${PORT}/api/stats`);
  });
};

startServer().catch((error) => {
  logger.error("Failed to start server:", error);
  process.exit(1);
});

// Graceful shutdown
const gracefulShutdown = (signal) => {
  logger.info(`Received ${signal}, shutting down gracefully`);
  
  // Close database connection
  db.close((err) => {
    if (err) {
      logger.error("Error closing database:", err);
    } else {
      logger.info("Database connection closed");
    }
    process.exit(0);
  });
};

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception:', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
});