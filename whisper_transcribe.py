#!/usr/bin/env python3
import sys
import json
import warnings
import gc
import time
import psutil
import os
import re
from pathlib import Path
from typing import Dict, Any, Optional, List

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

def is_likely_index_or_list(text: str) -> bool:
    """
    Enhanced check if text appears to be an index, list, or structured content
    """
    text_lower = text.lower().strip()
    
    # Check for index-like patterns
    index_indicators = [
        'index', 'contents', 'table of contents', 'chapter', 'section',
        'appendix', 'bibliography', 'references', 'glossary', 'australia',
        'austria', 'denmark', 'egypt', 'england', 'france', 'germany',
        'india', 'italy', 'mexico', 'turkey', 'united states'
    ]
    
    if any(indicator in text_lower for indicator in index_indicators):
        print(f"[FILTER] Detected index content by keywords: {text[:50]}...", file=sys.stderr, flush=True)
        return True
    
    # Check if text is mostly comma-separated items (like your example)
    comma_count = text.count(',')
    word_count = len(text.split())
    if comma_count > 5 and comma_count > word_count * 0.15:  # More than 15% commas
        print(f"[FILTER] Detected comma-separated list: {comma_count} commas in {word_count} words", file=sys.stderr, flush=True)
        return True
    
    # Check for period-separated items
    period_count = text.count('. ')
    if period_count > 5 and period_count > word_count * 0.1:
        print(f"[FILTER] Detected period-separated list: {period_count} periods", file=sys.stderr, flush=True)
        return True
    
    # Check for list-like structure (many short items)
    lines = [line.strip() for line in text.split('\n') if line.strip()]
    if len(lines) > 5:
        short_lines = [line for line in lines if len(line.split()) <= 4]  # 4 words or less
        if len(short_lines) / len(lines) > 0.6:  # 60% are short lines
            print(f"[FILTER] Detected structured list: {len(short_lines)}/{len(lines)} short lines", file=sys.stderr, flush=True)
            return True
    
    # Check for single-line lists with many short items
    items = [item.strip() for item in text.replace(',', '.').split('.') if item.strip()]
    if len(items) > 8:  # More than 8 items
        short_items = [item for item in items if len(item.split()) <= 3]
        if len(short_items) / len(items) > 0.7:  # 70% are short items
            print(f"[FILTER] Detected item list: {len(short_items)}/{len(items)} short items", file=sys.stderr, flush=True)
            return True
    
    # Check for bullet points or numbered lists
    list_patterns = [
        r'^\s*[-*•]\s',  # Bullet points
        r'^\s*\d+\.\s',  # Numbered lists
        r'^\s*[a-zA-Z]\.\s',  # Letter lists
        r'^\s*[ivxlcdm]+\.\s',  # Roman numerals
    ]
    
    lines = text.split('\n')
    list_matches = 0
    for line in lines:
        if any(re.match(pattern, line, re.IGNORECASE) for pattern in list_patterns):
            list_matches += 1
    
    if list_matches > 2:
        print(f"[FILTER] Detected formatted list: {list_matches} list items", file=sys.stderr, flush=True)
        return True
    
    return False

def detect_repetition(text: str, min_repetitions: int = 6) -> bool:  # Increased from 4 to 6
    """
    Detect if text contains excessive repetitions - much more conservative
    """
    if not text or len(text.strip()) < 30:  # Increased from 20 to 30
        return False
    
    # Don't flag structured content like indexes or lists
    if is_likely_index_or_list(text):
        return False
    
    words = text.lower().split()
    if len(words) < min_repetitions:
        return False
    
    # Check for word repetitions - much more lenient
    word_counts = {}
    for word in words:
        # Skip very common words that might naturally repeat
        if word in ['the', 'and', 'or', 'of', 'to', 'in', 'a', 'an', 'is', 'are', 'was', 'were', 'on', 'at', 'for', 'with', 'by']:
            continue
        # Also skip very short words that might repeat naturally
        if len(word) <= 2:
            continue
        word_counts[word] = word_counts.get(word, 0) + 1
    
    if not word_counts:
        return False
    
    # Much higher threshold - 60% instead of 40%
    max_count = max(word_counts.values())
    if max_count > len(words) * 0.6 and max_count >= min_repetitions:
        most_repeated_word = max(word_counts, key=word_counts.get)
        # Only flag if repeated word is substantial and repetitive
        if len(most_repeated_word) > 4 and max_count >= 8:  # Higher thresholds
            print(f"[FILTER] Detected word repetition: '{most_repeated_word}' appears {max_count} times", file=sys.stderr, flush=True)
            return True
    
    # Check for phrase repetitions - much more conservative
    for phrase_len in [4, 5]:  # Only check longer phrases
        if len(words) < phrase_len * 3:  # Need at least 3 occurrences
            continue
            
        phrase_counts = {}
        for i in range(len(words) - phrase_len + 1):
            phrase = ' '.join(words[i:i + phrase_len])
            # Skip phrases with common words
            if any(common in phrase for common in ['the', 'and', 'of', 'to', 'in', 'a', 'an']):
                continue
            phrase_counts[phrase] = phrase_counts.get(phrase, 0) + 1
        
        if phrase_counts:
            max_phrase_count = max(phrase_counts.values())
            # Much higher threshold for phrase repetition
            if max_phrase_count >= min_repetitions and max_phrase_count > len(words) / (phrase_len * 2):
                most_repeated_phrase = max(phrase_counts, key=phrase_counts.get)
                print(f"[FILTER] Detected phrase repetition: '{most_repeated_phrase}' appears {max_phrase_count} times", file=sys.stderr, flush=True)
                return True
    
    return False

def clean_repetitive_text(text: str) -> str:
    """
    Clean text by removing excessive repetitions - very conservative
    """
    if not text:
        return text
    
    # Don't clean structured content
    if is_likely_index_or_list(text):
        return text
    
    words = text.split()
    if len(words) <= 5:  # Don't clean very short text
        return text
    
    # Only remove consecutive identical words (allow up to 4 repetitions)
    cleaned_words = [words[0]]
    consecutive_count = 1
    
    for i in range(1, len(words)):
        if words[i].lower() == words[i-1].lower():
            consecutive_count += 1
            # Allow up to 4 consecutive repetitions
            if consecutive_count <= 4:
                cleaned_words.append(words[i])
            else:
                print(f"[FILTER] Removing consecutive repetition: {words[i]}", file=sys.stderr, flush=True)
        else:
            consecutive_count = 1
            cleaned_words.append(words[i])
    
    return ' '.join(cleaned_words)

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

def get_model(model_size: str = "base", use_faster_whisper: bool = True, compute_type: str = "int8", device: str = "cpu"):
    """
    Get Whisper model from cache or load new one
    Tries faster-whisper first, falls back to regular whisper
    """
    cache_key = f"{model_size}_{use_faster_whisper}_{compute_type}_{device}"
    
    if cache_key in MODEL_CACHE:
        print(f"[MODEL] Using cached model: {cache_key}", file=sys.stderr, flush=True)
        return MODEL_CACHE[cache_key], use_faster_whisper
    
    log_memory_usage("before_model_load")
    
    if use_faster_whisper:
        try:
            from faster_whisper import WhisperModel
            print(f"[MODEL] Loading faster-whisper model: {model_size} with compute_type={compute_type} on device={device}", file=sys.stderr, flush=True)
            
            # Determine compute type based on available resources and user preference
            if device == "cpu" and compute_type == "auto":
                actual_compute_type = "int8"
            elif device == "cuda" and compute_type == "auto":
                actual_compute_type = "float16"
            else:
                actual_compute_type = compute_type

            # Check for GPU availability
            if device == "cuda":
                try:
                    import torch
                    if not torch.cuda.is_available():
                        print("[MODEL] CUDA not available, falling back to CPU", file=sys.stderr, flush=True)
                        device = "cpu"
                        actual_compute_type = "int8"
                except ImportError:
                    print("[MODEL] PyTorch not available, cannot check CUDA, falling back to CPU", file=sys.stderr, flush=True)
                    device = "cpu"
                    actual_compute_type = "int8"

            model = WhisperModel(
                model_size, 
                device=device, 
                compute_type=actual_compute_type,
                cpu_threads=min(4, os.cpu_count() or 1) if device == "cpu" else None
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

def transcribe_with_faster_whisper(model, audio_path: str, language: Optional[str] = None, initial_prompt: Optional[str] = None) -> Dict[str, Any]:
    """Transcribe using faster-whisper with much more conservative settings"""
    print("[TRANSCRIBE] Using faster-whisper with very conservative anti-repetition settings", file=sys.stderr, flush=True)
    
    # Very conservative parameters - prioritize content preservation
    segments, info = model.transcribe(
        audio_path,
        word_timestamps=True,
        # Conservative temperature settings
        temperature=[0.0, 0.2, 0.4],
        best_of=1,
        beam_size=2,  # Slightly increased for better accuracy
        patience=1.0,
        length_penalty=1.0,
        condition_on_previous_text=False,  # Keep disabled to prevent repetition
        # Default thresholds to preserve content
        compression_ratio_threshold=2.4,
        log_prob_threshold=-1.0,
        no_speech_threshold=0.6,
        # VAD settings
        vad_filter=True,
        vad_parameters=dict(
            min_silence_duration_ms=300,  # Reduced for better capture
            speech_pad_ms=200
        ),
        language=language,
        initial_prompt=initial_prompt,
        # Very light repetition penalty
        repetition_penalty=1.02,  # Much lower
        suppress_tokens=[-1],
        without_timestamps=False
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
    filtered_segments = 0
    
    for segment in segments:
        # Very light cleaning
        cleaned_text = clean_repetitive_text(segment.text)
        
        # Much more conservative repetition detection - higher threshold
        if detect_repetition(cleaned_text, min_repetitions=8):  # Increased threshold
            print(f"[FILTER] Skipping repetitive segment: {cleaned_text[:50]}...", file=sys.stderr, flush=True)
            filtered_segments += 1
            continue
        
        segment_dict = {
            "id": len(result["segments"]),
            "seek": int(segment.start * 100),
            "start": segment.start,
            "end": segment.end,
            "text": cleaned_text,
            "tokens": [],
            "temperature": 0.0,
            "avg_logprob": segment.avg_logprob if hasattr(segment, 'avg_logprob') else -0.5,
            "compression_ratio": segment.compression_ratio if hasattr(segment, 'compression_ratio') else 2.0,
            "no_speech_prob": segment.no_speech_prob if hasattr(segment, 'no_speech_prob') else 0.1,
            "words": []
        }
        
        if segment.words:
            prev_word = None
            consecutive_count = 0
            
            for word in segment.words:
                # Much more lenient word-level filtering
                current_word = word.word.lower().strip()
                
                if current_word == prev_word:
                    consecutive_count += 1
                    if consecutive_count >= 6:  # Increased from 4 to 6
                        continue
                else:
                    consecutive_count = 0
                
                word_dict = {
                    "word": word.word,
                    "start": word.start,
                    "end": word.end,
                    "probability": word.probability
                }
                segment_dict["words"].append(word_dict)
                prev_word = current_word
        
        if segment_dict["words"] or cleaned_text.strip():
            result["segments"].append(segment_dict)
            full_text += cleaned_text + " "
    
    result["text"] = clean_repetitive_text(full_text.strip())
    
    print(f"[TRANSCRIBE] Processed {len(result['segments'])} segments, filtered {filtered_segments} repetitive segments", file=sys.stderr, flush=True)
    
    return result

def transcribe_with_regular_whisper(model, audio_path: str, language: Optional[str] = None, initial_prompt: Optional[str] = None) -> Dict[str, Any]:
    """Transcribe using regular whisper with very conservative settings"""
    print("[TRANSCRIBE] Using regular whisper with very conservative anti-repetition settings", file=sys.stderr, flush=True)
    
    result = model.transcribe(
        audio_path,
        word_timestamps=True,
        verbose=False,
        language=language,
        task="transcribe",
        # Conservative anti-repetition parameters
        temperature=[0.0, 0.2, 0.4],
        best_of=1,
        beam_size=2,  # Slightly increased
        patience=1.0,
        length_penalty=1.0,
        suppress_tokens=[-1],
        initial_prompt=initial_prompt,
        condition_on_previous_text=False,
        fp16=True,
        # Default thresholds to preserve content
        compression_ratio_threshold=2.4,
        logprob_threshold=-1.0,
        no_speech_threshold=0.6
    )
    
    # Post-process very conservatively
    if "segments" in result:
        cleaned_segments = []
        full_text = ""
        filtered_segments = 0
        
        for segment in result["segments"]:
            cleaned_text = clean_repetitive_text(segment["text"])
            
            # Much more conservative repetition detection
            if detect_repetition(cleaned_text, min_repetitions=8):
                print(f"[FILTER] Skipping repetitive segment: {cleaned_text[:50]}...", file=sys.stderr, flush=True)
                filtered_segments += 1
                continue
            
            segment["text"] = cleaned_text
            
            # Clean words very conservatively
            if "words" in segment and segment["words"]:
                cleaned_words = []
                prev_word = None
                consecutive_count = 0
                
                for word in segment["words"]:
                    current_word = word["word"].lower().strip()
                    
                    if current_word == prev_word:
                        consecutive_count += 1
                        if consecutive_count >= 6:  # Much higher threshold
                            continue
                    else:
                        consecutive_count = 0
                    
                    cleaned_words.append(word)
                    prev_word = current_word
                
                segment["words"] = cleaned_words
            
            if cleaned_text.strip():
                cleaned_segments.append(segment)
                full_text += cleaned_text + " "
        
        result["segments"] = cleaned_segments
        result["text"] = clean_repetitive_text(full_text.strip())
        
        print(f"[TRANSCRIBE] Processed {len(result['segments'])} segments, filtered {filtered_segments} repetitive segments", file=sys.stderr, flush=True)
    
    return result

def transcribe_audio(audio_path: str, model_size: str = "base", language: Optional[str] = None, initial_prompt: Optional[str] = None, compute_type: str = "int8", device: str = "cpu") -> Dict[str, Any]:
    """
    Transcribe audio file using OpenAI Whisper with very conservative anti-repetition
    """
    start_time = time.time()
    
    try:
        # Get file info
        file_size = os.path.getsize(audio_path) / (1024 * 1024)  # MB
        print(f"[TRANSCRIBE] Processing {file_size:.1f}MB audio file", file=sys.stderr, flush=True)
        
        # Preprocess audio
        processed_audio_path = preprocess_audio(audio_path)
        
        # Get model (try faster-whisper first)
        model, is_faster_whisper = get_model(model_size, use_faster_whisper=True, compute_type=compute_type, device=device)
        
        log_memory_usage("before_transcription")
        
        # Transcribe based on model type
        if is_faster_whisper:
            result = transcribe_with_faster_whisper(model, processed_audio_path, language, initial_prompt)
        else:
            result = transcribe_with_regular_whisper(model, processed_audio_path, language, initial_prompt)
        
        log_memory_usage("after_transcription")
        
        # Clean up preprocessed file if it was created
        if processed_audio_path != audio_path and os.path.exists(processed_audio_path):
            os.unlink(processed_audio_path)
            print(f"[CLEANUP] Removed preprocessed file: {processed_audio_path}", file=sys.stderr, flush=True)
        
        # Final text check - but be very conservative
        if result.get("text"):
            # Only clean if it's clearly not structured content
            if not is_likely_index_or_list(result["text"]):
                final_text = clean_repetitive_text(result["text"])
                result["text"] = final_text
            else:
                print(f"[FILTER] Preserving structured content as-is", file=sys.stderr, flush=True)
        
        # Add processing metadata
        processing_time = time.time() - start_time
        result["processing_metadata"] = {
            "processing_time": processing_time,
            "model_type": "faster-whisper" if is_faster_whisper else "whisper",
            "model_size": model_size,
            "preprocessing_applied": processed_audio_path != audio_path,
            "process_uptime": time.time() - PROCESS_START_TIME,
            "language_specified": language,
            "initial_prompt_used": bool(initial_prompt),
            "compute_type": compute_type,
            "device": device,
            "anti_repetition_applied": True,
            "conservative_filtering": True,
            "file_size_mb": file_size
        }
        
        print(f"[TRANSCRIBE] Completed in {processing_time:.2f}s. Found {len(result.get('segments', []))} segments", file=sys.stderr, flush=True)
        print(f"[TRANSCRIBE] Final text length: {len(result.get('text', ''))}", file=sys.stderr, flush=True)
        
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
        
        if available_memory_gb < 2.0 and len(MODEL_CACHE) > 1:
            print(f"[CLEANUP] Low memory ({available_memory_gb:.1f}GB), cleaning model cache", file=sys.stderr, flush=True)
            
            # Keep only the most recently used model
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
        
        # Check file size
        file_size = path.stat().st_size
        if file_size == 0:
            print(f"[VALIDATION] Empty audio file: {audio_path}", file=sys.stderr, flush=True)
            return False
        
        # Increased size limit to 1GB for large files
        if file_size > 1024 * 1024 * 1024:  # 1GB limit
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
        
        # Parse optional arguments
        model_size = "base"
        language = None
        initial_prompt = None
        compute_type = "int8"
        device = "cpu"

        # Simple argument parsing
        for i in range(2, len(sys.argv)):
            arg = sys.argv[i]
            if arg.startswith("--model="):
                model_size = arg.split("=")[1]
            elif arg.startswith("--lang="):
                language = arg.split("=")[1]
            elif arg.startswith("--prompt="):
                initial_prompt = arg.split("=")[1]
            elif arg.startswith("--compute_type="):
                compute_type = arg.split("=")[1]
            elif arg.startswith("--device="):
                device = arg.split("=")[1]
            else:
                # Backward compatibility
                if i == 2:
                    model_size = arg

        print(f"[MAIN] Starting transcription: {audio_path} with model {model_size}, lang={language}, prompt={initial_prompt}, compute_type={compute_type}, device={device}", file=sys.stderr, flush=True)
        
        # Validate audio file
        if not validate_audio_file(audio_path):
            error_result = {"error": f"Invalid or inaccessible audio file: {audio_path}"}
            print(json.dumps(error_result), flush=True)
            sys.exit(1)
        
        # Clean up models if memory is low
        cleanup_old_models()
        
        # Transcribe
        result = transcribe_audio(audio_path, model_size, language, initial_prompt, compute_type, device)
        
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