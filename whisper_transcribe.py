#!/usr/bin/env python3
import sys
import json
import warnings
import gc
import time
import psutil
import os
from pathlib import Path
from typing import Dict, Any, Optional

# Suppress warnings
warnings.filterwarnings("ignore")
os.environ['TF_CPP_MIN_LOG_LEVEL'] = '3'

# Global model cache to avoid reloading
MODEL_CACHE = {}
PROCESS_START_TIME = time.time()

def log_memory_usage(stage: str):
    """Log current memory usage for monitoring"""
    process = psutil.Process()
    memory_mb = process.memory_info().rss / 1024 / 1024
    print(f"[MEMORY] {stage}: {memory_mb:.1f}MB", file=sys.stderr, flush=True)

def preprocess_audio(audio_path: str) -> str:
    """
    Preprocess audio for better transcription quality
    Returns path to preprocessed audio (same path if no preprocessing needed)
    """
    try:
        import librosa
        import soundfile as sf
        
        print(f"[PREPROCESSING] Loading audio: {audio_path}", file=sys.stderr, flush=True)
        
        # Load audio
        y, sr = librosa.load(audio_path, sr=16000)  # Whisper works best at 16kHz
        
        # Remove silence from beginning and end
        y_trimmed, _ = librosa.effects.trim(y, top_db=20)
        
        # Normalize audio
        y_normalized = librosa.util.normalize(y_trimmed)
        
        # If significant preprocessing was done, save to temp file
        if len(y_normalized) < len(y) * 0.95:  # More than 5% trimmed
            preprocessed_path = audio_path + "_preprocessed.wav"
            sf.write(preprocessed_path, y_normalized, sr)
            print(f"[PREPROCESSING] Saved preprocessed audio: {preprocessed_path}", file=sys.stderr, flush=True)
            return preprocessed_path
        
        return audio_path
        
    except ImportError:
        print("[PREPROCESSING] librosa not available, skipping preprocessing", file=sys.stderr, flush=True)
        return audio_path
    except Exception as e:
        print(f"[PREPROCESSING] Error during preprocessing: {e}, using original", file=sys.stderr, flush=True)
        return audio_path

def get_model(model_size: str = "base", use_faster_whisper: bool = True):
    """
    Get Whisper model from cache or load new one
    Tries faster-whisper first, falls back to regular whisper
    """
    cache_key = f"{model_size}_{use_faster_whisper}"
    
    if cache_key in MODEL_CACHE:
        print(f"[MODEL] Using cached model: {cache_key}", file=sys.stderr, flush=True)
        return MODEL_CACHE[cache_key], use_faster_whisper
    
    log_memory_usage("before_model_load")
    
    if use_faster_whisper:
        try:
            from faster_whisper import WhisperModel
            print(f"[MODEL] Loading faster-whisper model: {model_size}", file=sys.stderr, flush=True)
            
            # Determine compute type based on available resources
            compute_type = "int8"  # Good balance of speed and accuracy
            if psutil.virtual_memory().available < 4 * 1024 * 1024 * 1024:  # Less than 4GB available
                compute_type = "int8"
            
            model = WhisperModel(
                model_size, 
                device="cpu", 
                compute_type=compute_type,
                cpu_threads=min(4, os.cpu_count() or 1)
            )
            
            MODEL_CACHE[cache_key] = model
            log_memory_usage("after_faster_whisper_load")
            return model, True
            
        except ImportError:
            print("[MODEL] faster-whisper not available, falling back to regular whisper", file=sys.stderr, flush=True)
        except Exception as e:
            print(f"[MODEL] Error loading faster-whisper: {e}, falling back to regular whisper", file=sys.stderr, flush=True)
    
    # Fallback to regular whisper
    try:
        import whisper
        print(f"[MODEL] Loading regular whisper model: {model_size}", file=sys.stderr, flush=True)
        
        model = whisper.load_model(model_size)
        cache_key = f"{model_size}_False"
        MODEL_CACHE[cache_key] = model
        log_memory_usage("after_whisper_load")
        return model, False
        
    except Exception as e:
        raise Exception(f"Failed to load any Whisper model: {e}")

def transcribe_with_faster_whisper(model, audio_path: str) -> Dict[str, Any]:
    """Transcribe using faster-whisper"""
    print("[TRANSCRIBE] Using faster-whisper", file=sys.stderr, flush=True)
    
    segments, info = model.transcribe(
        audio_path,
        word_timestamps=True,
        temperature=0.0,
        best_of=5,
        beam_size=5,
        patience=1.0,
        length_penalty=1.0,
        condition_on_previous_text=True,
        compression_ratio_threshold=2.4,
        log_prob_threshold=-1.0,
        no_speech_threshold=0.6,
        vad_filter=True,  # Voice activity detection
        vad_parameters=dict(min_silence_duration_ms=500)
    )
    
    # Convert faster-whisper format to regular whisper format
    result = {
        "text": "",
        "language": info.language,
        "language_probability": info.language_probability,
        "duration": info.duration,
        "segments": []
    }
    
    full_text = ""
    
    for segment in segments:
        segment_dict = {
            "id": len(result["segments"]),
            "seek": int(segment.start * 100),  # Convert to seek format
            "start": segment.start,
            "end": segment.end,
            "text": segment.text,
            "tokens": [],  # Not available in faster-whisper
            "temperature": 0.0,
            "avg_logprob": segment.avg_logprob if hasattr(segment, 'avg_logprob') else -0.5,
            "compression_ratio": segment.compression_ratio if hasattr(segment, 'compression_ratio') else 2.0,
            "no_speech_prob": segment.no_speech_prob if hasattr(segment, 'no_speech_prob') else 0.1,
            "words": []
        }
        
        if segment.words:
            for word in segment.words:
                word_dict = {
                    "word": word.word,
                    "start": word.start,
                    "end": word.end,
                    "probability": word.probability
                }
                segment_dict["words"].append(word_dict)
        
        result["segments"].append(segment_dict)
        full_text += segment.text
    
    result["text"] = full_text.strip()
    return result

def transcribe_with_regular_whisper(model, audio_path: str) -> Dict[str, Any]:
    """Transcribe using regular whisper"""
    print("[TRANSCRIBE] Using regular whisper", file=sys.stderr, flush=True)
    
    result = model.transcribe(
        audio_path,
        word_timestamps=True,
        verbose=False,
        language=None, 
        task="transcribe",
        temperature=0.0,
        best_of=5,
        beam_size=5,
        patience=1.0,
        length_penalty=1.0,
        suppress_tokens=[-1],
        initial_prompt=None,
        condition_on_previous_text=True,
        fp16=True,
        compression_ratio_threshold=2.4,
        logprob_threshold=-1.0,
        no_speech_threshold=0.6
    )
    
    return result

def transcribe_audio(audio_path: str, model_size: str = "base") -> Dict[str, Any]:
    """
    Transcribe audio file using OpenAI Whisper with optimizations
    
    Args:
        audio_path (str): Path to audio file
        model_size (str): Whisper model size (tiny, base, small, medium, large)
    
    Returns:
        dict: Transcription result with word-level timestamps
    """
    start_time = time.time()
    
    try:
        # Preprocess audio
        processed_audio_path = preprocess_audio(audio_path)
        
        # Get model (try faster-whisper first)
        model, is_faster_whisper = get_model(model_size, use_faster_whisper=True)
        
        log_memory_usage("before_transcription")
        
        # Transcribe based on model type
        if is_faster_whisper:
            result = transcribe_with_faster_whisper(model, processed_audio_path)
        else:
            result = transcribe_with_regular_whisper(model, processed_audio_path)
        
        log_memory_usage("after_transcription")
        
        # Clean up preprocessed file if it was created
        if processed_audio_path != audio_path and os.path.exists(processed_audio_path):
            os.unlink(processed_audio_path)
            print(f"[CLEANUP] Removed preprocessed file: {processed_audio_path}", file=sys.stderr, flush=True)
        
        # Add processing metadata
        processing_time = time.time() - start_time
        result["processing_metadata"] = {
            "processing_time": processing_time,
            "model_type": "faster-whisper" if is_faster_whisper else "whisper",
            "model_size": model_size,
            "preprocessing_applied": processed_audio_path != audio_path,
            "process_uptime": time.time() - PROCESS_START_TIME
        }
        
        print(f"[TRANSCRIBE] Completed in {processing_time:.2f}s. Found {len(result.get('segments', []))} segments", file=sys.stderr, flush=True)
        
        # Force garbage collection to free memory
        gc.collect()
        log_memory_usage("after_gc")
        
        return result
        
    except Exception as e:
        error_msg = f"Whisper transcription failed: {str(e)}"
        print(f"[ERROR] {error_msg}", file=sys.stderr, flush=True)
        raise Exception(error_msg)

def cleanup_old_models():
    """Clean up old models from cache if memory is getting low"""
    try:
        # Check available memory
        available_memory_gb = psutil.virtual_memory().available / (1024**3)
        
        if available_memory_gb < 2.0 and len(MODEL_CACHE) > 1:  # Less than 2GB available
            print(f"[CLEANUP] Low memory ({available_memory_gb:.1f}GB), cleaning model cache", file=sys.stderr, flush=True)
            
            # Keep only the most recently used model (last in cache)
            if MODEL_CACHE:
                last_key = list(MODEL_CACHE.keys())[-1]
                last_model = MODEL_CACHE[last_key]
                MODEL_CACHE.clear()
                MODEL_CACHE[last_key] = last_model
                
            gc.collect()
            log_memory_usage("after_model_cleanup")
            
    except Exception as e:
        print(f"[CLEANUP] Error during cleanup: {e}", file=sys.stderr, flush=True)

def validate_audio_file(audio_path: str) -> bool:
    """Validate that the audio file exists and is readable"""
    try:
        path = Path(audio_path)
        if not path.exists():
            return False
        
        # Check file size (not empty, not too large)
        file_size = path.stat().st_size
        if file_size == 0:
            print(f"[VALIDATION] Empty audio file: {audio_path}", file=sys.stderr, flush=True)
            return False
        
        if file_size > 500 * 1024 * 1024:  # 500MB limit
            print(f"[VALIDATION] Audio file too large: {file_size / (1024*1024):.1f}MB", file=sys.stderr, flush=True)
            return False
        
        print(f"[VALIDATION] Audio file valid: {file_size / (1024*1024):.1f}MB", file=sys.stderr, flush=True)
        return True
        
    except Exception as e:
        print(f"[VALIDATION] Error validating file: {e}", file=sys.stderr, flush=True)
        return False

def main():
    """Main function to handle command line arguments and output JSON"""
    try:
        log_memory_usage("process_start")
        
        if len(sys.argv) < 2:
            error_result = {"error": "No audio file path provided"}
            print(json.dumps(error_result), flush=True)
            sys.exit(1)
        
        audio_path = sys.argv[1]
        model_size = sys.argv[2] if len(sys.argv) > 2 else "base"
        
        print(f"[MAIN] Starting transcription: {audio_path} with model {model_size}", file=sys.stderr, flush=True)
        
        # Validate audio file
        if not validate_audio_file(audio_path):
            error_result = {"error": f"Invalid or inaccessible audio file: {audio_path}"}
            print(json.dumps(error_result), flush=True)
            sys.exit(1)
        
        # Clean up models if memory is low
        cleanup_old_models()
        
        # Transcribe
        result = transcribe_audio(audio_path, model_size)
        
        # Output result as JSON
        print(json.dumps(result, ensure_ascii=False, separators=(',', ':')), flush=True)
        
        print(f"[MAIN] Transcription successful", file=sys.stderr, flush=True)
        
    except KeyboardInterrupt:
        print("[MAIN] Process interrupted", file=sys.stderr, flush=True)
        sys.exit(130)
    except Exception as e:
        error_result = {
            "error": str(e),
            "process_uptime": time.time() - PROCESS_START_TIME
        }
        print(json.dumps(error_result), flush=True)
        print(f"[MAIN] Fatal error: {e}", file=sys.stderr, flush=True)
        sys.exit(1)

if __name__ == "__main__":
    main()