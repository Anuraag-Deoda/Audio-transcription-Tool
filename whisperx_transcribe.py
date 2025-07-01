#!/usr/bin/env python3
import json
import sys
import time
import gc
import warnings
import re
from typing import Dict, Any, Optional, List

warnings.filterwarnings("ignore")

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

def advanced_segment_filter(segment: Dict[str, Any]) -> bool:
    """
    Advanced filtering for WhisperX segments with content analysis
    """
    text = segment.get("text", "").strip()
    
    # Basic length check
    if len(text) < 3:
        print(f"[FILTER] Removed very short segment: '{text}'", file=sys.stderr, flush=True)
        return False
    
    # Check for index/list content
    if is_likely_index_or_list(text):
        print(f"[FILTER] Removed index/list content: '{text[:50]}...'", file=sys.stderr, flush=True)
        return False
    
    # Check for excessive repetition
    if detect_repetition(text, min_repetitions=8):  # Slightly higher threshold for WhisperX
        print(f"[FILTER] Removed repetitive content: '{text[:50]}...'", file=sys.stderr, flush=True)
        return False
    
    # Skip segments with only punctuation
    text_alphanumeric = ''.join(c for c in text if c.isalnum())
    if len(text_alphanumeric) < 2:
        print(f"[FILTER] Removed punctuation-only segment: '{text}'", file=sys.stderr, flush=True)
        return False
    
    # Duration-based filtering
    duration = segment.get("end", 0) - segment.get("start", 0)
    word_count = len(text.split())
    
    if duration > 0 and word_count > 0:
        words_per_second = word_count / duration
        # Skip if speaking rate is unrealistic (too fast or too slow)
        if words_per_second > 12 or words_per_second < 0.2:
            print(f"[FILTER] Removed unrealistic speech rate segment ({words_per_second:.1f} w/s): '{text[:30]}'", file=sys.stderr, flush=True)
            return False
    
    # Check for very short duration with complex text (likely transcription error)
    if duration < 0.5 and word_count > 5:
        print(f"[FILTER] Removed short duration/complex text segment: '{text[:30]}'", file=sys.stderr, flush=True)
        return False
    
    return True

def transcribe_with_whisperx(audio_path: str, model_size: str = "base", language: Optional[str] = None, 
                           device: str = "cpu", compute_type: str = "int8") -> Dict[str, Any]:
    """
    Transcribe using WhisperX with improved accuracy and enhanced content filtering
    """
    try:
        import whisperx
        
        print(f"[WHISPERX] Loading model: {model_size} on {device}", file=sys.stderr, flush=True)
        
        # Load WhisperX model
        model = whisperx.load_model(model_size, device, compute_type=compute_type, language=language)
        
        # Load audio
        print(f"[WHISPERX] Loading audio: {audio_path}", file=sys.stderr, flush=True)
        audio = whisperx.load_audio(audio_path)
        
        # Transcribe with improved parameters
        print("[WHISPERX] Transcribing...", file=sys.stderr, flush=True)
        result = model.transcribe(audio, batch_size=16)
        
        # Load alignment model for precise word timestamps
        print("[WHISPERX] Loading alignment model...", file=sys.stderr, flush=True)
        model_a, metadata = whisperx.load_align_model(language_code=result["language"], device=device)
        
        # Perform forced alignment
        print("[WHISPERX] Performing forced alignment...", file=sys.stderr, flush=True)
        result = whisperx.align(result["segments"], model_a, metadata, audio, device, return_char_alignments=False)
        
        # Apply enhanced filtering with content analysis
        print("[WHISPERX] Applying enhanced content filtering...", file=sys.stderr, flush=True)
        
        original_count = len(result.get("segments", []))
        filtered_segments = []
        
        for segment in result.get("segments", []):
            # Clean the text first
            cleaned_text = clean_repetitive_text(segment.get("text", "").strip())
            segment["text"] = cleaned_text
            
            # Apply advanced filtering
            if advanced_segment_filter(segment):
                filtered_segments.append(segment)
        
        filtered_count = len(filtered_segments)
        print(f"[WHISPERX] Content filtering: {original_count} -> {filtered_count} segments", file=sys.stderr, flush=True)
        
        # Build final result
        final_result = {
            "text": " ".join([seg.get("text", "") for seg in filtered_segments]).strip(),
            "language": result.get("language", "unknown"),
            "segments": filtered_segments,
            "processing_metadata": {
                "model_type": "whisperx",
                "model_size": model_size,
                "enhanced_filtering_applied": True,
                "forced_alignment_applied": True,
                "original_segments": original_count,
                "filtered_segments": filtered_count,
                "filter_removal_rate": round((original_count - filtered_count) / original_count * 100, 1) if original_count > 0 else 0,
                "device": device,
                "compute_type": compute_type,
                "content_analysis_enabled": True,
                "repetition_detection_enabled": True,
                "index_list_detection_enabled": True
            }
        }
        
        print(f"[WHISPERX] Completed. {filtered_count} segments after enhanced filtering (removed {original_count - filtered_count})", file=sys.stderr, flush=True)
        
        # Cleanup
        del model, model_a
        gc.collect()
        
        return final_result
        
    except ImportError:
        raise Exception("WhisperX not installed. Install with: pip install whisperx")
    except Exception as e:
        raise Exception(f"WhisperX transcription failed: {str(e)}")

def fallback_to_faster_whisper(audio_path: str, model_size: str = "base", language: Optional[str] = None,
                              device: str = "cpu", compute_type: str = "int8") -> Dict[str, Any]:
    """
    Fallback to faster-whisper with enhanced filtering and content analysis
    """
    try:
        from faster_whisper import WhisperModel
        
        print("[FALLBACK] Using faster-whisper with enhanced content filtering", file=sys.stderr, flush=True)
        
        model = WhisperModel(model_size, device=device, compute_type=compute_type)
        
        # Safer VAD parameters - avoid None values
        vad_params = {
            "min_silence_duration_ms": 500,  # Minimum silence duration in ms
            "speech_pad_ms": 200,           # Padding around speech segments
        }
        
        # Enhanced transcription parameters
        segments, info = model.transcribe(
            audio_path,
            word_timestamps=True,
            vad_filter=True,
            vad_parameters=vad_params,
            temperature=[0.0, 0.2],
            best_of=2,
            beam_size=3,
            condition_on_previous_text=False,
            compression_ratio_threshold=2.4,
            log_prob_threshold=-1.0,
            no_speech_threshold=0.6,
            language=language
        )
        
        result_segments = []
        full_text = ""
        original_count = 0
        
        for segment in segments:
            original_count += 1
            text = segment.text.strip()
            
            # Clean the text first
            cleaned_text = clean_repetitive_text(text)
            
            # Create segment dict for filtering
            segment_dict = {
                "start": segment.start,
                "end": segment.end,
                "text": cleaned_text,
                "words": []
            }
            
            # Apply advanced filtering
            if not advanced_segment_filter(segment_dict):
                continue
            
            # Skip segments with very low speech probability
            if hasattr(segment, 'no_speech_prob') and segment.no_speech_prob > 0.8:
                print(f"[FILTER] Skipping low-speech segment: '{cleaned_text[:30]}'", file=sys.stderr, flush=True)
                continue
            
            # Add word-level data if available
            if hasattr(segment, 'words') and segment.words:
                for word in segment.words:
                    word_text = word.word.strip()
                    if word_text:  # Only include non-empty words
                        word_dict = {
                            "word": word_text,
                            "start": word.start,
                            "end": word.end
                        }
                        # Add probability if available
                        if hasattr(word, 'probability'):
                            word_dict["probability"] = word.probability
                        segment_dict["words"].append(word_dict)
            
            result_segments.append(segment_dict)
            full_text += cleaned_text + " "
        
        filtered_count = len(result_segments)
        print(f"[FALLBACK] Enhanced filtering: {original_count} -> {filtered_count} segments", file=sys.stderr, flush=True)
        
        return {
            "text": full_text.strip(),
            "language": info.language,
            "segments": result_segments,
            "processing_metadata": {
                "model_type": "faster-whisper-enhanced",
                "model_size": model_size,
                "vad_filtering_applied": True,
                "enhanced_content_filtering_applied": True,
                "original_segments": original_count,
                "filtered_segments": filtered_count,
                "filter_removal_rate": round((original_count - filtered_count) / original_count * 100, 1) if original_count > 0 else 0,
                "device": device,
                "compute_type": compute_type,
                "language_probability": getattr(info, 'language_probability', None),
                "content_analysis_enabled": True,
                "repetition_detection_enabled": True,
                "index_list_detection_enabled": True
            }
        }
        
    except Exception as e:
        raise Exception(f"Enhanced faster-whisper transcription failed: {str(e)}")

def transcribe_audio_enhanced(audio_path: str, model_size: str = "base", language: Optional[str] = None,
                            device: str = "cpu", compute_type: str = "int8") -> Dict[str, Any]:
    """
    Enhanced transcription that tries WhisperX first, then falls back to improved faster-whisper
    Both with advanced content filtering and analysis
    """
    start_time = time.time()
    
    try:
        # Try WhisperX first
        result = transcribe_with_whisperx(audio_path, model_size, language, device, compute_type)
        result["processing_metadata"]["processing_time"] = time.time() - start_time
        return result
        
    except Exception as whisperx_error:
        print(f"[WHISPERX] Failed: {whisperx_error}", file=sys.stderr, flush=True)
        print("[WHISPERX] Falling back to enhanced faster-whisper", file=sys.stderr, flush=True)
        
        try:
            result = fallback_to_faster_whisper(audio_path, model_size, language, device, compute_type)
            result["processing_metadata"]["processing_time"] = time.time() - start_time
            result["processing_metadata"]["whisperx_fallback_reason"] = str(whisperx_error)
            return result
            
        except Exception as fallback_error:
            raise Exception(f"Both WhisperX and enhanced faster-whisper failed. WhisperX: {whisperx_error}, Faster-Whisper: {fallback_error}")

def main():
    """Enhanced main function with WhisperX integration and advanced content filtering"""
    try:
        if len(sys.argv) < 2:
            error_result = {"error": "No audio file path provided"}
            print(json.dumps(error_result), flush=True)
            sys.exit(1)
        
        audio_path = sys.argv[1]
        model_size = "base"
        language = None
        device = "cpu"
        compute_type = "int8"
        
        # Parse arguments
        for i in range(2, len(sys.argv)):
            arg = sys.argv[i]
            if arg.startswith("--model="):
                model_size = arg.split("=")[1]
            elif arg.startswith("--lang="):
                language = arg.split("=")[1]
            elif arg.startswith("--device="):
                device = arg.split("=")[1]
            elif arg.startswith("--compute_type="):
                compute_type = arg.split("=")[1]
        
        print(f"[MAIN] Starting enhanced transcription with advanced content filtering", file=sys.stderr, flush=True)
        print(f"[MAIN] Parameters: model={model_size}, lang={language}, device={device}, compute_type={compute_type}", file=sys.stderr, flush=True)
        
        result = transcribe_audio_enhanced(audio_path, model_size, language, device, compute_type)
        
        print(json.dumps(result, ensure_ascii=False, separators=(',', ':')), flush=True)
        print(f"[MAIN] Enhanced transcription successful with content filtering", file=sys.stderr, flush=True)
        
    except Exception as e:
        error_result = {"error": str(e)}
        print(json.dumps(error_result), flush=True)
        print(f"[MAIN] Error: {e}", file=sys.stderr, flush=True)
        sys.exit(1)

if __name__ == "__main__":
    main()