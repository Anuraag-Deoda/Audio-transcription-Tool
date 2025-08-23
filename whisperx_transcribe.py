#!/usr/bin/env python3
import json
import sys
import time
import gc
import warnings
import re
import os
from typing import Dict, Any, Optional, List, Tuple

warnings.filterwarnings("ignore")

def validate_audio(file_path: str, max_duration_minutes: int = 120) -> Tuple[bool, str]:
    if not os.path.exists(file_path): return False, f"Audio file not found at path: {file_path}"
    if not os.access(file_path, os.R_OK): return False, f"No read permissions for audio file: {file_path}"
    try:
        from pydub import AudioSegment
        from pydub.exceptions import CouldntDecodeError
        audio = AudioSegment.from_file(file_path)
        duration_minutes = len(audio) / 60000.0
        if duration_minutes > max_duration_minutes: return False, f"Audio duration ({duration_minutes:.2f} min) exceeds maximum allowed ({max_duration_minutes} min)."
    except CouldntDecodeError: return False, "Could not decode audio file. It may be corrupt or in an unsupported format."
    except ImportError: return False, "pydub library not found. Please run 'pip install pydub'."
    except Exception as e: return False, f"An unexpected error occurred during audio validation: {str(e)}"
    return True, ""

def is_likely_index_or_list(text: str) -> Tuple[bool, str]:
    text_lower = text.lower().strip()
    index_keywords = ['table of contents', 'chapter', 'section', 'appendix', 'bibliography', 'references', 'glossary', 'index']
    if any(keyword in text_lower for keyword in index_keywords): return (True, f"Detected index keyword: '{next(k for k in index_keywords if k in text_lower)}'")
    word_count = len(text.split())
    if word_count < 10: return (False, "")
    comma_count = text.count(',')
    if comma_count > 5 and comma_count > word_count * 0.2: return (True, f"High comma count: {comma_count} commas in {word_count} words")
    period_count = text.count('. ')
    if period_count > 5 and period_count > word_count * 0.15: return (True, f"High period count: {period_count} periods in {word_count} words")
    lines = [line.strip() for line in text.split('\n') if line.strip()]
    if len(lines) > 4:
        short_lines = [line for line in lines if len(line.split()) <= 5]
        if len(short_lines) / len(lines) > 0.6: return (True, f"Structured list detected: {len(short_lines)}/{len(lines)} short lines")
    return (False, "")

def detect_repetition(text: str, min_repetitions: int = 5) -> Tuple[bool, str]:
    if not text or len(text.strip()) < 40: return (False, "")
    is_list, _ = is_likely_index_or_list(text)
    if is_list: return (False, "")
    words = text.lower().split()
    word_count = len(words)
    if word_count < min_repetitions: return (False, "")
    word_counts = {}
    stop_words = {'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'is', 'are', 'was', 'were'}
    for word in words:
        if word not in stop_words and len(word) > 3: word_counts[word] = word_counts.get(word, 0) + 1
    if word_counts:
        max_count = max(word_counts.values())
        if max_count > word_count * 0.5 and max_count >= min_repetitions:
            most_repeated_word = max(word_counts, key=word_counts.get)
            return (True, f"Extreme word repetition: '{most_repeated_word}' appears {max_count} times")
    for phrase_len in [3, 4]:
        if word_count < phrase_len * min_repetitions: continue
        phrase_counts = {}
        for i in range(word_count - phrase_len + 1):
            phrase = ' '.join(words[i:i + phrase_len])
            phrase_counts[phrase] = phrase_counts.get(phrase, 0) + 1
        if phrase_counts:
            max_phrase_count = max(phrase_counts.values())
            if max_phrase_count >= min_repetitions:
                most_repeated_phrase = max(phrase_counts, key=phrase_counts.get)
                return (True, f"Phrase repetition: '{most_repeated_phrase}' appears {max_phrase_count} times")
    return (False, "")

def advanced_segment_filter(segment: Dict[str, Any], level: str = "standard") -> Tuple[bool, str]:
    """
    Applies filters to a segment based on the specified filtering level.
    Levels: "none", "standard", "aggressive".
    """
    if level == "none":
        return (True, "")

    text = segment.get("text", "").strip()

    if len(text) < 2:
        return (False, f"Segment too short: '{text}'")
    
    text_alphanumeric = ''.join(c for c in text if c.isalnum())
    if len(text_alphanumeric) < 2:
        return (False, f"Segment contains only punctuation/symbols: '{text}'")

    if level == "aggressive":
        is_list, list_reason = is_likely_index_or_list(text)
        if is_list:
            return (False, f"Removed index/list content (aggressive). Reason: {list_reason}")

    repetition_threshold = 7 if level == "standard" else 5
    is_repetitive, rep_reason = detect_repetition(text, min_repetitions=repetition_threshold)
    if is_repetitive:
        return (False, f"Removed repetitive content. Reason: {rep_reason}")

    duration = segment.get("end", 0) - segment.get("start", 0)
    word_count = len(text.split())

    if duration > 0 and word_count > 0:
        words_per_second = word_count / duration
        max_wps = 12 if level == "standard" else 15
        if words_per_second > max_wps or words_per_second < 0.1:
            return (False, f"Unrealistic speech rate: {words_per_second:.1f} wps")
    
    if duration < 0.5 and word_count > 5:
        return (False, f"Short duration for complex text: {duration:.2f}s for {word_count} words")
    
    return (True, "")

def transcribe_with_whisperx(params: Dict[str, Any]) -> Dict[str, Any]:
    try:
        import whisperx
    except ImportError:
        raise RuntimeError("WhisperX is not installed. Please run: pip install whisperx")

    filtering_level = params.get("filtering_level", "standard")
    
    model = whisperx.load_model(params["model_size"], params["device"], compute_type=params["compute_type"], language=params.get("language"))
    audio = whisperx.load_audio(params["audio_path"])
    result = model.transcribe(audio, batch_size=params["batch_size"])
    
    model_a, metadata = whisperx.load_align_model(language_code=result["language"], device=params["device"])
    result = whisperx.align(result["segments"], model_a, metadata, audio, device=params["device"], return_char_alignments=False)
    
    original_count = len(result.get("segments", []))
    filtered_segments = []
    filtering_log = []

    for segment in result.get("segments", []):
        is_valid, reason = advanced_segment_filter(segment, level=filtering_level)
        if is_valid:
            filtered_segments.append(segment)
        else:
            filtering_log.append({"text": segment.get("text", ""), "reason": reason})
            
    filtered_count = len(filtered_segments)
    final_result = {
        "text": " ".join([seg.get("text", "") for seg in filtered_segments]).strip(),
        "language": result.get("language", "unknown"),
        "segments": filtered_segments,
        "processing_metadata": {
            "model_type": "whisperx",
            "model_size": params["model_size"],
            "filtering_applied": filtering_level,
            "original_segments": original_count, "filtered_segments": filtered_count,
            "filter_removal_rate_percent": round((original_count - filtered_count) / original_count * 100, 1) if original_count > 0 else 0,
            "filtering_log": filtering_log
        }
    }
    del model, model_a, audio, result
    gc.collect()
    return final_result

def fallback_to_faster_whisper(params: Dict[str, Any]) -> Dict[str, Any]:
    try:
        from faster_whisper import WhisperModel
    except ImportError:
        raise RuntimeError("faster-whisper is not installed.")

    # Read VAD settings directly from the params sent by Node.js
    use_vad_filter = params.get("vad_filter", True)
    vad_parameters = params.get("vad_parameters", None)
    
    filtering_level = params.get("filtering_level", "standard")
    
    model = WhisperModel(params["model_size"], device=params["device"], compute_type=params["compute_type"])
    
    segments_generator, info = model.transcribe(
        params["audio_path"],
        word_timestamps=True,
        vad_filter=use_vad_filter,
        vad_parameters=vad_parameters,
        language=params.get("language")
    )

    result_segments = []
    filtering_log = []
    original_count = 0
    full_text = ""

    for segment in segments_generator:
        original_count += 1
        segment_dict = {"start": segment.start, "end": segment.end, "text": segment.text.strip()}
        
        is_valid, reason = advanced_segment_filter(segment_dict, level=filtering_level)
        
        if is_valid:
            words_list = []
            if hasattr(segment, 'words') and segment.words:
                for word in segment.words:
                    words_list.append({'word': word.word, 'start': word.start, 'end': word.end, 'probability': word.probability})
            segment_dict['words'] = words_list
            result_segments.append(segment_dict)
            full_text += segment.text
        else:
            filtering_log.append({"text": segment.text.strip(), "reason": reason})

    return {
        "text": full_text.strip(),
        "language": info.language,
        "segments": result_segments,
        "processing_metadata": {
            "model_type": "faster-whisper",
            "filtering_applied": filtering_level,
            "vad_filter_used": use_vad_filter,
            "original_segments": original_count,
            "filtered_segments": len(result_segments),
            "filtering_log": filtering_log
        }
    }

def main():
    try:
        params = json.load(sys.stdin)
        required_keys = ["audio_path", "model_size", "device", "compute_type", "batch_size"]
        if not all(key in params for key in required_keys):
            raise ValueError(f"Missing one or more required keys in input JSON: {required_keys}")
        
        max_duration = params.get("max_duration_minutes", 120)
        is_valid, error_msg = validate_audio(params["audio_path"], max_duration)
        if not is_valid:
            raise ValueError(f"Audio file validation failed: {error_msg}")

        start_time = time.time()
        result = None
        
        try:
            result = transcribe_with_whisperx(params)
        except (RuntimeError, ImportError) as primary_error:
            result = fallback_to_faster_whisper(params)
            result["processing_metadata"]["fallback_reason"] = str(primary_error)
        
        if result:
            result["processing_metadata"]["total_processing_time_seconds"] = round(time.time() - start_time, 2)
            final_output = {"status": "success", "data": result}
            print(json.dumps(final_output, ensure_ascii=False, separators=(',', ':')), flush=True)

    except Exception as e:
        output = {"status": "error", "message": str(e)}
        print(json.dumps(output, separators=(',', ':')), flush=True)
        sys.exit(1)

if __name__ == "__main__":
    main()