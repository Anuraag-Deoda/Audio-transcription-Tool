# Audio Transcription & Editing Tool

A full-stack, locally-hosted application for high-precision audio transcription, editing, and alignment. This tool leverages OpenAI's Whisper models (via `whisperx` and `faster-whisper`) to generate accurate speech-to-text results with word-level timestamps, offering a rich React-based frontend for editing, synchronization, and export.

## 🚀 Current Features

### Core Transcription
*   **High-Accuracy Engines**: Utilizes `whisperx` for forced alignment and `faster-whisper` for rapid inference.
*   **Format Support**: Accepts a wide range of audio/video formats (MP3, WAV, MP4, M4A, OGG, MOV, etc.).
*   **Video Support**: Automatically extracts audio from uploaded video files using `ffmpeg` before processing.
*   **VAD (Voice Activity Detection)**: Filters out silence and non-speech noise for cleaner transcripts.
*   **Intelligent Filtering**: Algorithms to detect and remove hallucinations, repetitive loops, and index-like non-speech patterns.

### Backend Architecture
*   **Process Pooling**: Manages concurrent transcription tasks efficiently with a dedicated Python process pool.
*   **Smart Caching**: SQLite-based caching system hashes files to prevent re-processing identical uploads, delivering instant results for previously transcribed files.
*   **Robust Logging**: Comprehensive logging via `winston` for error tracking and system health monitoring.
*   **Job Management**: Tracks job status (pending, processing, completed, failed) with SQLite persistence.

### Frontend Interface
*   **Interactive Waveform**: Visual audio navigation with zoom, pan, and click-to-seek functionality.
*   **Multi-View Editor**:
    *   **Words**: Granular editing of individual words and timestamps.
    *   **Sentences/Paragraphs**: Higher-level text editing.
    *   **Custom**: Import XHTML/HTML scripts to align against audio or draft entirely new text blocks.
*   **Precision Timing**: Adjust start and end times for any text block down to the millisecond.
*   **Search & Replace**: (Planned/Partial) Homophone detection and text normalization.
*   **Export Options**:
    *   **SRT**: Standard subtitles.
    *   **JSON**: Full data structure with confidence scores.
    *   **SMIL**: Synchronized Multimedia Integration Language for digital talking books.
    *   **Audacity Labels**: Import markers directly into audio engineering software.

## 🛠 Tech Stack

*   **Frontend**: React.js, Bootstrap 5, Lucide React (Icons), HTML5 Canvas (Waveform).
*   **Backend**: Node.js, Express.js, SQLite3 (Persistence), Multer (Uploads).
*   **AI/ML**: Python 3, WhisperX, Faster-Whisper, PyTorch, FFmpeg.

## 🔮 Roadmap & Future Advancements

Based on the current architecture, the following features are planned to elevate the tool into a production-grade platform:

### 1. AI & NLP Enhancements
*   **Speaker Diarization**: Implement speaker identification (e.g., "Speaker A", "Speaker B") to distinguish voices in interviews or meetings.
*   **LLM Integration**: Add a "Generate Summary" button using local LLMs (Llama 3) or APIs (OpenAI/Anthropic) to create meeting minutes, action items, and sentiment analysis.
*   **Translation**: Add a post-processing step to translate transcripts into multiple languages while preserving timestamps.

### 2. Collaboration & Workflow
*   **User Accounts & Cloud Sync**: Move from local-only SQLite to a centralized database (PostgreSQL) to support user accounts and save project history across devices.
*   **Real-Time Collaboration**: Use WebSockets (Socket.io) to allow multiple users to edit the same transcript simultaneously (Google Docs style).
*   **Project Folders**: Organize transcriptions into folders/projects for better file management.

### 3. Advanced Audio Tools
*   **In-Browser Audio Recording**: Allow users to record audio directly from the browser instead of just uploading files.
*   **Audio Enhancement**: Integrate noise reduction and audio normalization pipelines before transcription to improve accuracy on poor-quality recordings.

### 4. Enterprise Features
*   **API Keys**: Expose the backend as a secured API service for third-party integrations.
*   **Webhooks**: Notify external systems when a long-running transcription job completes.
*   **Docker Compose**: Fully containerize the application (Frontend + Backend + Python Environment) for one-click deployment.

## 📦 Installation & Setup

1.  **Prerequisites**:
    *   Node.js (v16+)
    *   Python 3.8+
    *   FFmpeg installed and added to system PATH.

2.  **Install Dependencies**:
    ```bash
    # Backend
    npm install
    
    # Frontend
    cd frontend
    npm install
    ```

3.  **Python Setup**:
    ```bash
    # From root directory
    python3 -m venv venv
    source venv/bin/activate
    pip install openai-whisper whisperx faster-whisper torch torchaudio
    ```

4.  **Run Application**:
    ```bash
    # Terminal 1: Backend
    npm run dev

    # Terminal 2: Frontend
    cd frontend
    npm start
    ```

5.  **Access**: Open `http://localhost:3000` in your browser.
