#!/usr/bin/env python3
"""Transcribe episode utterances once each and flag likely Japanese misreads.

This is a production audit, not a replacement for listening.  It deliberately
keeps the model loaded in one process so a 20-40 line episode is practical on
Apple Silicon.
"""

from __future__ import annotations

import argparse
import json
import re
import unicodedata
from difflib import SequenceMatcher
from pathlib import Path

try:
    from sudachipy import dictionary as sudachi_dictionary
    from sudachipy import tokenizer as sudachi_tokenizer

    SUDACHI = sudachi_dictionary.Dictionary().create()
    SUDACHI_MODE = sudachi_tokenizer.Tokenizer.SplitMode.C
except Exception:  # pragma: no cover - deterministic fallback for hosts without Sudachi
    SUDACHI = None
    SUDACHI_MODE = None


def normalized(value: str) -> str:
    text = unicodedata.normalize("NFKC", value or "").lower()
    return re.sub(r"[\s\u3000、。！？!?…・「」『』,.\-—―:：]", "", text)


def _katakana_to_hiragana(value: str) -> str:
    return "".join(
        chr(ord(character) - 0x60) if "ァ" <= character <= "ヶ" else character
        for character in value
    )


def reading_normalized(value: str) -> str:
    """Compare Japanese by pronunciation, not only by written kanji.

    For example, correctly spoken てんじ may be transcribed as 天時 instead of
    展示. Sudachi readings treat that as the same sound while still detecting
    real pronunciation differences such as ミオ versus みよ.
    """

    text = unicodedata.normalize("NFKC", value or "")
    if SUDACHI is not None:
        reading_parts = []
        for morpheme in SUDACHI.tokenize(text, SUDACHI_MODE):
            if morpheme.part_of_speech()[0] == "補助記号":
                continue
            reading = morpheme.reading_form()
            reading_parts.append(reading if reading and reading != "*" else morpheme.surface())
        text = "".join(reading_parts)
    # A deliberately lengthened name such as レーン is still the same lexical
    # reading as れん. Removing the Japanese long-vowel mark on both sides of
    # the comparison keeps expressive elongation from becoming a false
    # pronunciation failure (and affects expected/actual symmetrically).
    return normalized(_katakana_to_hiragana(text).replace("ー", ""))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("manifest")
    parser.add_argument("--output", default="")
    parser.add_argument("--model", default="mlx-community/whisper-large-v3-turbo-q4")
    parser.add_argument("--minimum-similarity", type=float, default=0.63)
    parser.add_argument("--utterance-ids", default="")
    parser.add_argument(
        "--reuse-transcriptions",
        default="",
        help="Reuse the `actual` strings from a previous audit instead of running Whisper again.",
    )
    args = parser.parse_args()

    manifest_path = Path(args.manifest).expanduser().resolve()
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    output_path = Path(args.output).expanduser().resolve() if args.output else manifest_path.with_name("speech-audit.json")
    pronunciation_rules = manifest.get("speech", {}).get("pronunciations", [])
    reused_rows = {}
    if args.reuse_transcriptions:
        reused_payload = json.loads(Path(args.reuse_transcriptions).expanduser().resolve().read_text(encoding="utf-8"))
        reused_rows = {
            str(row.get("utteranceId")): row
            for row in reused_payload.get("rows", [])
            if row.get("utteranceId")
        }
    rows = []
    requested_ids = {value.strip() for value in args.utterance_ids.split(",") if value.strip()}

    for utterance in manifest.get("utterances", []):
        if requested_ids and str(utterance.get("id")) not in requested_ids:
            continue
        audio_path = Path(utterance.get("audio", {}).get("filePath", ""))
        reused = reused_rows.get(str(utterance.get("id")))
        if reused is not None:
            actual = str(reused.get("actual") or "").strip()
        else:
            import mlx_whisper

            result = mlx_whisper.transcribe(
                str(audio_path),
                path_or_hf_repo=args.model,
                language="ja",
                task="transcribe",
                condition_on_previous_text=False,
                temperature=0.0,
                verbose=False,
            )
            actual = (result.get("text") or "").strip()
        expected = utterance.get("text", "")
        speech_text = utterance.get("speechAuditText") or utterance.get("speechText", expected)
        expected_reading = reading_normalized(speech_text)
        actual_reading = reading_normalized(actual)
        similarity = SequenceMatcher(None, expected_reading, actual_reading).ratio()
        missing_terms = []
        for rule in pronunciation_rules:
            source = str(rule.get("from", ""))
            spoken = str(rule.get("to", ""))
            if source and source in expected:
                spoken_reading = reading_normalized(spoken)
                if spoken_reading and spoken_reading not in actual_reading:
                    missing_terms.append(source)
        rows.append({
            "utteranceId": utterance.get("id"),
            "speakerName": utterance.get("speakerName"),
            "expected": expected,
            "speechText": speech_text,
            "actual": actual,
            "expectedReading": expected_reading,
            "actualReading": actual_reading,
            "similarity": round(similarity, 4),
            "missingPronunciationTerms": missing_terms,
            "pass": similarity >= args.minimum_similarity and not missing_terms,
        })
        print(json.dumps(rows[-1], ensure_ascii=False), flush=True)

    payload = {
        "version": 1,
        "episodeId": manifest.get("id"),
        "model": args.model,
        "minimumSimilarity": args.minimum_similarity,
        "comparison": "sudachi-reading" if SUDACHI is not None else "orthographic-fallback",
        "reusedTranscriptions": bool(args.reuse_transcriptions),
        "utteranceCount": len(rows),
        "requestedUtteranceIds": sorted(requested_ids),
        "passedCount": sum(1 for row in rows if row["pass"]),
        "flaggedCount": sum(1 for row in rows if not row["pass"]),
        "rows": rows,
    }
    output_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"outputPath": str(output_path), "passedCount": payload["passedCount"], "flaggedCount": payload["flaggedCount"]}, ensure_ascii=False))


if __name__ == "__main__":
    main()
