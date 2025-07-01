#!/usr/bin/env python3
import sys
import json
import whisper
import warnings
from pathlib import Path

warnings.filterwarnings("ignore")

def transcribe_audio(audio_path, model_size="base"):
    """
    Transcribe audio file using OpenAI Whisper
    
    Args:
        audio_path (str): Path to audio file
        model_size (str): Whisper model size (tiny, base, small, medium, large)
    
    Returns:
        dict: Transcription result with word-level timestamps
    """
    try:
        print(f"Loading Whisper model: {model_size}", file=sys.stderr)
        model = whisper.load_model(model_size)
        
        print(f"Transcribing audio: {audio_path}", file=sys.stderr)
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
        
        print(f"Transcription completed. Found {len(result.get('segments', []))} segments", file=sys.stderr)
        
     
        return result
        
    except Exception as e:
        error_msg = f"Whisper transcription failed: {str(e)}"
        print(error_msg, file=sys.stderr)
        raise Exception(error_msg)

def main():
    """Main function to handle command line arguments and output JSON"""
    if len(sys.argv) < 2:
        error_result = {"error": "No audio file path provided"}
        print(json.dumps(error_result))
        sys.exit(1)
    
    audio_path = sys.argv[1]
    model_size = sys.argv[2] if len(sys.argv) > 2 else "base"
    
    # Validate file exists
    if not Path(audio_path).exists():
        error_result = {"error": f"Audio file not found: {audio_path}"}
        print(json.dumps(error_result))
        sys.exit(1)
    
    try:
        result = transcribe_audio(audio_path, model_size)
        
        print(json.dumps(result, ensure_ascii=False, indent=None))
        
    except Exception as e:
        error_result = {"error": str(e)}
        print(json.dumps(error_result))
        sys.exit(1)

if __name__ == "__main__":
    main()