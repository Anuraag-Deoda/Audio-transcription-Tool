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

def detect_repetition(text: str, min_repetitions: int = 6) -> bool:
    """
    Detect if text contains excessive repetitions - much more conservative
    """
    if not text or len(text.strip()) < 30:
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
        if len(most_repeated_word) > 4 and max_count >= 8:
            print(f"[FILTER] Detected word repetition: '{most_repeated_word}' appears {max_count} times", file=sys.stderr, flush=True)
            return True
    
    # Check for phrase repetitions - much more conservative
    for phrase_len in [4, 5]:
        if len(words) < phrase_len * 3:
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
    if len(words) <= 5:
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

def preserve_word_alignment(segment_text: str, words_data: List[Dict]) -> List[Dict]:
    """
    Fix word alignment issues by ensuring words match the segment text
    Improved version with better handling of empty/corrupted word data
    """
    if not words_data or not segment_text.strip():
        return words_data
    
    # Clean and tokenize the segment text, removing punctuation for matching
    import re
    segment_text_clean = segment_text.strip()
    
    # Split into words, preserving punctuation but treating it separately
    segment_words = []
    # This regex splits on whitespace but keeps punctuation attached
    raw_words = segment_text_clean.split()
    
    for word in raw_words:
        # Clean up the word but keep track of original form
        clean_word = re.sub(r'^[^\w]*|[^\w]*$', '', word)  # Remove leading/trailing punct
        if clean_word:  # Only add non-empty words
            segment_words.append(word)  # Keep original form with punctuation
    
    print(f"[WORD_ALIGN] Segment: '{segment_text_clean}' -> {len(segment_words)} words: {segment_words}", file=sys.stderr, flush=True)
    print(f"[WORD_ALIGN] Original word data: {len(words_data)} entries", file=sys.stderr, flush=True)
    
    # Filter out empty or invalid word data entries
    valid_words_data = []
    for i, word_data in enumerate(words_data):
        word_text = word_data.get("word", "").strip()
        start_time = word_data.get("start", 0.0)
        end_time = word_data.get("end", 0.0)
        
        # Skip empty words or invalid timestamps
        if (not word_text or 
            len(word_text) == 0 or 
            start_time < 0 or 
            end_time <= start_time or
            word_text.isspace()):
            print(f"[WORD_ALIGN] Skipping invalid word data at index {i}: '{word_text}' ({start_time}-{end_time})", file=sys.stderr, flush=True)
            continue
            
        valid_words_data.append(word_data)
    
    print(f"[WORD_ALIGN] After filtering: {len(valid_words_data)} valid word entries", file=sys.stderr, flush=True)
    
    # If we have the same number of valid words as segment words, align them
    if len(valid_words_data) == len(segment_words):
        aligned_words = []
        for i, (segment_word, word_data) in enumerate(zip(segment_words, valid_words_data)):
            aligned_word = {
                "word": segment_word,  # Use the actual segment word
                "start": float(word_data.get("start", 0.0)),
                "end": float(word_data.get("end", 0.0)),
                "probability": float(word_data.get("probability", 0.5))
            }
            aligned_words.append(aligned_word)
            print(f"[WORD_ALIGN] Aligned word {i}: '{segment_word}' ({aligned_word['start']:.3f}-{aligned_word['end']:.3f})", file=sys.stderr, flush=True)
        
        return aligned_words
    
    # If counts don't match, try to create reasonable word boundaries
    print(f"[WORD_ALIGN] Count mismatch: {len(segment_words)} segment words vs {len(valid_words_data)} word data entries", file=sys.stderr, flush=True)
    
    # Get segment timing bounds
    if valid_words_data:
        segment_start = min(word_data.get("start", 0.0) for word_data in valid_words_data)
        segment_end = max(word_data.get("end", 0.0) for word_data in valid_words_data)
    else:
        segment_start = 0.0
        segment_end = len(segment_words) * 0.3  # Estimate 300ms per word
    
    # Create evenly distributed word timings
    segment_duration = segment_end - segment_start
    if segment_duration <= 0:
        segment_duration = len(segment_words) * 0.3
    
    word_duration = segment_duration / len(segment_words) if segment_words else 0.3
    
    aligned_words = []
    for i, segment_word in enumerate(segment_words):
        word_start = segment_start + (i * word_duration)
        word_end = word_start + word_duration
        
        # Try to get probability from corresponding word data if available
        probability = 0.5
        if i < len(valid_words_data):
            probability = float(valid_words_data[i].get("probability", 0.5))
        
        aligned_word = {
            "word": segment_word,
            "start": word_start,
            "end": word_end,
            "probability": probability
        }
        aligned_words.append(aligned_word)
        print(f"[WORD_ALIGN] Created word {i}: '{segment_word}' ({word_start:.3f}-{word_end:.3f})", file=sys.stderr, flush=True)
    
    return aligned_words


def transcribe_with_faster_whisper(model, audio_path: str, language: Optional[str] = None, initial_prompt: Optional[str] = None) -> Dict[str, Any]:
    """Transcribe using faster-whisper with improved word-level accuracy"""
    print("[TRANSCRIBE] Using faster-whisper with improved word alignment", file=sys.stderr, flush=True)
    
    # Enhanced parameters for better word-level accuracy
    segments, info = model.transcribe(
        audio_path,
        word_timestamps=True,
        # More precise temperature settings
        temperature=[0.0, 0.1, 0.3, 0.5],
        best_of=2,
        beam_size=3,
        patience=1.2,
        length_penalty=1.0,
        condition_on_previous_text=False,
        # More conservative thresholds
        compression_ratio_threshold=2.2,
        log_prob_threshold=-0.8,
        no_speech_threshold=0.5,
        # Enhanced VAD settings
        vad_filter=True,
        vad_parameters=dict(
            min_silence_duration_ms=250,
            speech_pad_ms=150
        ),
        language=language,
        initial_prompt=initial_prompt,
        repetition_penalty=1.01,
        suppress_tokens=[-1],
        without_timestamps=False,
        prepend_punctuations="\\\"'¿([{-",
        append_punctuations="\\\"'.。,，!！?？:：)]}、"
    )

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
        # Very conservative text cleaning
        cleaned_text = clean_repetitive_text(segment.text.strip())
        
        # Only filter if it's clearly repetitive (higher threshold)
        if detect_repetition(cleaned_text, min_repetitions=10):
            print(f"[FILTER] Skipping highly repetitive segment: {cleaned_text[:50]}...", file=sys.stderr, flush=True)
            filtered_segments += 1
            continue
        
        segment_dict = {
            "id": len(result["segments"]),
            "seek": int(segment.start * 100),
            "start": segment.start,
            "end": segment.end,
            "text": cleaned_text,
            "tokens": [],
            "temperature": getattr(segment, 'temperature', 0.0),
            "avg_logprob": getattr(segment, 'avg_logprob', -0.5),
            "compression_ratio": getattr(segment, 'compression_ratio', 2.0),
            "no_speech_prob": getattr(segment, 'no_speech_prob', 0.1),
            "words": []
        }
        
        # Improved word processing with validation
        if segment.words:
            words_data = []
            
            for word in segment.words:
                word_dict = {
                    "word": word.word.strip(),
                    "start": float(word.start),
                    "end": float(word.end),
                    "probability": float(word.probability)
                }
                words_data.append(word_dict)
            
            # First validate the timestamps
            words_data = validate_word_timestamps(words_data)
            
            # Then fix word alignment with segment text
            segment_dict["words"] = preserve_word_alignment(cleaned_text, words_data)
            
            print(f"[TRANSCRIBE] Final segment: '{cleaned_text}' -> {len(segment_dict['words'])} aligned words", file=sys.stderr, flush=True)
        
        # Only include segments with actual content
        if cleaned_text.strip():
            result["segments"].append(segment_dict)
            full_text += cleaned_text + " "
    
    result["text"] = full_text.strip()
    
    print(f"[TRANSCRIBE] Processed {len(result['segments'])} segments, filtered {filtered_segments} repetitive segments", file=sys.stderr, flush=True)
    
    return result


def transcribe_with_regular_whisper(model, audio_path: str, language: Optional[str] = None, initial_prompt: Optional[str] = None) -> Dict[str, Any]:
    """Transcribe using regular whisper with improved word accuracy"""
    print("[TRANSCRIBE] Using regular whisper with improved word alignment", file=sys.stderr, flush=True)
    
    result = model.transcribe(
        audio_path,
        word_timestamps=True,
        verbose=False,
        language=language,
        task="transcribe",
        # Improved parameters for word accuracy
        temperature=[0.0, 0.1, 0.3, 0.5],
        best_of=2,
        beam_size=3,
        patience=1.2,
        length_penalty=1.0,
        suppress_tokens=[-1],
        initial_prompt=initial_prompt,
        condition_on_previous_text=False,
        fp16=True,
        # More conservative thresholds
        compression_ratio_threshold=2.2,
        logprob_threshold=-0.8,
        no_speech_threshold=0.5
    )
    
    # Post-process with improved word alignment
    if "segments" in result:
        cleaned_segments = []
        full_text = ""
        filtered_segments = 0
        
        for segment in result["segments"]:
            cleaned_text = clean_repetitive_text(segment["text"].strip())
            
            # Only filter clearly repetitive content
            if detect_repetition(cleaned_text, min_repetitions=10):
                print(f"[FILTER] Skipping highly repetitive segment: {cleaned_text[:50]}...", file=sys.stderr, flush=True)
                filtered_segments += 1
                continue
            
            segment["text"] = cleaned_text
            
            # Improve word alignment
            if "words" in segment and segment["words"]:
                # Fix word alignment with segment text
                segment["words"] = preserve_word_alignment(cleaned_text, segment["words"])
                
                print(f"[WORD_ALIGN] Segment: '{cleaned_text}' -> {len(segment['words'])} words", file=sys.stderr, flush=True)
            
            if cleaned_text.strip():
                cleaned_segments.append(segment)
                full_text += cleaned_text + " "
        
        result["segments"] = cleaned_segments
        result["text"] = full_text.strip()
        
        print(f"[TRANSCRIBE] Processed {len(result['segments'])} segments, filtered {filtered_segments} repetitive segments", file=sys.stderr, flush=True)
    
    return result

def transcribe_audio(audio_path: str, model_size: str = "base", language: Optional[str] = None, initial_prompt: Optional[str] = None, compute_type: str = "int8", device: str = "cpu") -> Dict[str, Any]:
    """
    Transcribe audio file using OpenAI Whisper with improved word-level accuracy
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
            "word_alignment_improved": True,
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


def validate_word_timestamps(words_data: List[Dict]) -> List[Dict]:
    """
    Validate and fix word timestamp issues
    """
    if not words_data:
        return words_data
    
    validated_words = []
    prev_end = 0.0
    
    for i, word_data in enumerate(words_data):
        word_text = word_data.get("word", "").strip()
        start_time = float(word_data.get("start", 0.0))
        end_time = float(word_data.get("end", 0.0))
        probability = float(word_data.get("probability", 0.5))
        
        # Skip completely empty words
        if not word_text:
            print(f"[WORD_VALIDATE] Skipping empty word at index {i}", file=sys.stderr, flush=True)
            continue
        
        # Fix invalid timestamps
        if start_time < 0:
            start_time = prev_end
            print(f"[WORD_VALIDATE] Fixed negative start time for '{word_text}': {start_time}", file=sys.stderr, flush=True)
        
        if end_time <= start_time:
            end_time = start_time + 0.3  # Default 300ms duration
            print(f"[WORD_VALIDATE] Fixed invalid end time for '{word_text}': {end_time}", file=sys.stderr, flush=True)
        
        # Ensure non-overlapping timestamps
        if start_time < prev_end:
            start_time = prev_end
            if end_time <= start_time:
                end_time = start_time + 0.3
            print(f"[WORD_VALIDATE] Fixed overlapping timestamp for '{word_text}': {start_time}-{end_time}", file=sys.stderr, flush=True)
        
        validated_word = {
            "word": word_text,
            "start": start_time,
            "end": end_time,
            "probability": probability
        }
        
        validated_words.append(validated_word)
        prev_end = end_time
    
    print(f"[WORD_VALIDATE] Validated {len(validated_words)} words from {len(words_data)} original entries", file=sys.stderr, flush=True)
    return validated_words


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