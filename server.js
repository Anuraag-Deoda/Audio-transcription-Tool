// server.js - Node.js Express Server
const express = require("express");
const multer = require("multer");
const cors = require("cors");
const path = require("path");
const fs = require("fs").promises;
const { spawn } = require("child_process");
const { v4: uuidv4 } = require("uuid");

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

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
      "audio/webm"
    ];
    
    if (allowedMimes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error("Invalid file type. Please upload an audio file."), false);
    }
  }
});

const ensureUploadsDir = async () => {
  try {
    await fs.access("uploads");
  } catch {
    await fs.mkdir("uploads", { recursive: true });
  }
};

const runWhisperTranscription = (audioPath) => {
    return new Promise((resolve, reject) => {
      const venvPythonPath = "./venv/bin/python";
      console.log(`Using Python from virtual environment: ${venvPythonPath}`);
      
      const pythonProcess = spawn(venvPythonPath, ["whisper_transcribe.py", audioPath]);
  
      let stdout = "";
      let stderr = "";
  
      pythonProcess.stdout.on("data", (data) => {
        stdout += data.toString();
      });
  
      pythonProcess.stderr.on("data", (data) => {
        stderr += data.toString();
      });
  
      pythonProcess.on("close", (code) => {
        console.log(`Python exited with code ${code}`);
        console.log(`stdout:\n${stdout}`);
        console.log(`stderr:\n${stderr}`);
  
        if (code === 0) {
          try {
            // Extract JSON string by finding the first '{' and last '}'
            const jsonStartIndex = stdout.indexOf("{");
            const jsonEndIndex = stdout.lastIndexOf("}");

            if (jsonStartIndex === -1 || jsonEndIndex === -1) {
              throw new Error("Valid JSON not found in Whisper output");
            }

            const jsonString = stdout.substring(jsonStartIndex, jsonEndIndex + 1);
            const result = JSON.parse(jsonString);
          
            resolve(result);
          } catch (error) {
            console.error("❌ Failed to parse Whisper JSON:");
            console.error(stdout);
            reject(new Error("Failed to parse Whisper output"));
          }
        } else {
          reject(new Error(`Whisper failed: ${stderr}`));
        }
      });
  
      pythonProcess.on("error", (error) => {
        reject(new Error(`Failed to start Python process: ${error.message}`));
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
    raw_whisper_data: whisperResult
  };
};


app.get("/api/health", (req, res) => {
  res.json({ status: "OK", message: "Audio Transcription API is running" });
});

app.post("/api/transcribe", upload.single("audio"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No audio file uploaded" });
    }
    
    console.log(`Processing file: ${req.file.filename}`);
    
    const audioPath = req.file.path;
    
    const whisperResult = await runWhisperTranscription(audioPath);
    
    const processedResult = processTranscriptionData(whisperResult);
    
    await fs.unlink(audioPath);
    
    console.log("Transcription completed successfully");
    res.json(processedResult);
    
  } catch (error) {
    console.error("Transcription error:", error);
    
    // Clean up file if it exists
    if (req.file) {
      try {
        await fs.unlink(req.file.path);
      } catch (cleanupError) {
        console.error("Error cleaning up file:", cleanupError);
      }
    }
    
    res.status(500).json({ 
      error: error.message || "Failed to transcribe audio" 
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
      "Language detection"
    ]
  });
});

app.use((error, req, res, next) => {
  if (error instanceof multer.MulterError) {
    if (error.code === "LIMIT_FILE_SIZE") {
      return res.status(400).json({ error: "File too large. Maximum size is 100MB." });
    }
  }
  
  console.error("Unhandled error:", error);
  res.status(500).json({ error: "Internal server error" });
});

const startServer = async () => {
  await ensureUploadsDir();
  
  app.listen(PORT, () => {
    console.log(`🚀 Audio Transcription Server running on port ${PORT}`);
    console.log(`📡 API endpoint: http://localhost:${PORT}/api`);
    console.log(`🎵 Upload audio files to: http://localhost:${PORT}/api/transcribe`);
  });
};

startServer().catch(console.error);

process.on("SIGTERM", () => {
  console.log("Received SIGTERM, shutting down gracefully");
  process.exit(0);
});

process.on("SIGINT", () => {
  console.log("Received SIGINT, shutting down gracefully");
  process.exit(0);
});


