#!/usr/bin/env python3
"""R61.3 gate: STT cross-check of the FINAL video audio against the script.

Transcribes each utterance's window from the rendered video (faster-whisper,
local) and fuzzy-matches the expected speech text. Detects dropped or shaved
line openings (the first characters missing) and gross content mismatches.
This is the permanent, annotation-independent detector for audio regressions.

Matching is kana-insensitive and ignores punctuation; the head check requires
the first 40% of the expected text to be present with >=0.6 similarity.
"""
import json
import argparse
import re
import subprocess
import sys
import unicodedata
from difflib import SequenceMatcher
from pathlib import Path

COMMON_READING_VARIANTS = {
    # IPADIC bundled with kuromoji treats the first character of this common
    # recruiting abbreviation as unknown, while Whisper usually emits kana or
    # the homophone 周活. Canonicalize the intended spoken reading first.
    "就活": "しゅうかつ",
}

DEFAULT_MANIFEST = Path("canvas/manga-videos/manga-photo-homecoming-001/episode-manifest.json")


def normalize(text, pronunciation_variants=None):
    text = unicodedata.normalize("NFKC", text or "")
    text = re.sub(r"\[[^\]]*\]", "", text)
    # A script may introduce a name as 漢字（かな）. The spoken form contains
    # only the reading, so collapse the ruby pair before punctuation removal.
    text = re.sub(
        r"([\u3400-\u9fff々〆ヶ]+)[（(]([ぁ-ゖァ-ヶー\s]+)[）)]",
        lambda match: match.group(2),
        text,
    )
    # proper nouns / numerals: fold both sides to one spelling so kanji-vs-kana
    # orthography from the STT cannot fail an acoustically correct line
    variants = {**COMMON_READING_VARIANTS, **(pronunciation_variants or {})}
    for src, dst in sorted(
        variants.items(),
        key=lambda entry: len(entry[0]),
        reverse=True,
    ):
        text = text.replace(src, dst)
    text = re.sub(r"[\s、。！？!?…‥.,「」()（）・/ɾɴ-]", "", text)
    # katakana -> hiragana
    return "".join(chr(ord(ch) - 0x60) if "ァ" <= ch <= "ヶ" else ch for ch in text)


def phoneticize_many(texts, project_dir):
    helper = project_dir / "scripts" / "japanese-reading-kuromoji.mjs"
    completed = subprocess.run(
        ["node", str(helper)],
        cwd=str(project_dir),
        input=json.dumps(texts, ensure_ascii=False),
        capture_output=True,
        text=True,
        check=True,
    )
    readings = json.loads(completed.stdout)
    if not isinstance(readings, list) or len(readings) != len(texts):
        raise RuntimeError("Japanese reading helper returned an invalid result")
    return readings


def similarity(a, b):
    return SequenceMatcher(None, japanese_morae(a), japanese_morae(b)).ratio()


def japanese_morae(text):
    """Group small kana with the preceding kana for Japanese STT matching."""
    units = []
    for char in text:
        if char in "ゃゅょぁぃぅぇぉゎ" and units:
            units[-1] += char
        else:
            units.append(char)
    return units


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", default=str(DEFAULT_MANIFEST))
    parser.add_argument("--video")
    parser.add_argument("--output")
    args = parser.parse_args()
    manifest_path = Path(args.manifest).resolve()
    manifest = json.loads(manifest_path.read_text())
    pronunciation_variants = {
        str(entry.get("from", "")): str(entry.get("to", ""))
        for entry in manifest.get("speech", {}).get("pronunciations", [])
        if entry.get("from") and entry.get("to")
    }
    project_dir = manifest_path.parents[3]
    video = str(Path(args.video).resolve()) if args.video else (
        manifest.get("outputs", {}).get("reviewVideo", {}).get("filePath")
        or manifest["outputs"]["finalVideo"]["filePath"]
    )
    from faster_whisper import WhisperModel
    import tempfile, os
    model = WhisperModel("small", device="cpu", compute_type="int8")
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
        tmp_path = tmp.name
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", video,
                    "-vn", "-ar", "16000", "-ac", "1", tmp_path], check=True)
    # One transcription pass over the whole episode; per-line verification is
    # then pure text alignment with an order cursor, so concat frame-rounding
    # drift cannot shift any window.
    segments, _ = model.transcribe(tmp_path, language="ja", beam_size=3,
                                   condition_on_previous_text=False)
    raw_heard_full = "".join(seg.text for seg in segments)
    os.unlink(tmp_path)
    raw_expected = [u.get("speechText") or u["text"] for u in manifest["utterances"]]
    prepared = [normalize(raw_heard_full, pronunciation_variants)] + [
        normalize(text, pronunciation_variants) for text in raw_expected
    ]
    phonetic = phoneticize_many(prepared, project_dir)
    heard_full = normalize(phonetic[0])
    expected_readings = [normalize(text) for text in phonetic[1:]]
    rows = []
    cursor = 0
    for utterance_index, u in enumerate(manifest["utterances"]):
        a = u["audio"]
        # Compare against the DISPLAY text (kanji) — the speech text carries
        # pronunciation-corrected kana spellings (しゃしん etc.) that cannot
        # char-match Whisper's kanji output.
        expected = expected_readings[utterance_index]
        # search window: from a little before the cursor to cursor + generous span
        lo = max(0, cursor - 10)
        hi = min(len(heard_full), cursor + len(expected) * 3 + 60)
        window = heard_full[lo:hi]
        best_sim, best_off = 0.0, 0
        for off in range(0, max(1, len(window) - len(expected) + 1)):
            sim = similarity(expected, window[off:off + len(expected)])
            if sim > best_sim:
                best_sim, best_off = sim, off
                if sim > 0.97:
                    break
        head_len = max(3, int(len(expected) * 0.4))
        head_expected = expected[:head_len]
        best_head = 0.0
        for off in range(0, max(1, len(window) - head_len + 1)):
            best_head = max(best_head, similarity(head_expected, window[off:off + head_len]))
            if best_head > 0.95:
                break
        ok = best_sim >= 0.55 and best_head >= 0.6
        if best_sim >= 0.4:
            cursor = lo + best_off + int(len(expected) * best_sim * 0.8)
        recheck = None
        if not ok:
            # Second chance: the single-pass transcript sometimes drops a soft
            # word the audio clearly contains. Re-transcribe just this line's
            # window with margins; if the focused pass hears it, the audio is
            # fine and only the long-form transcript was lossy.
            t = u["timing"]
            with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp2:
                tmp2_path = tmp2.name
            subprocess.run(["ffmpeg", "-v", "error", "-y",
                            "-ss", str(max(0, float(t["audioStartSeconds"]) - 0.35)),
                            "-t", str(float(a["durationSeconds"]) + 0.8),
                            "-i", video, "-vn", "-ar", "16000", "-ac", "1", tmp2_path], check=True)
            local_segments, _ = model.transcribe(tmp2_path, language="ja", beam_size=5)
            local_raw = normalize("".join(seg.text for seg in local_segments), pronunciation_variants)
            local_heard = normalize(phoneticize_many([local_raw], project_dir)[0])
            os.unlink(tmp2_path)
            local_sim = 0.0
            for off in range(0, max(1, len(local_heard) - len(expected) + 1)):
                local_sim = max(local_sim, similarity(expected, local_heard[off:off + len(expected)]))
            local_head = 0.0
            for off in range(0, max(1, len(local_heard) - head_len + 1)):
                local_head = max(local_head, similarity(head_expected, local_heard[off:off + head_len]))
            recheck = {
                "fullSimilarity": round(local_sim, 3),
                "headSimilarity": round(local_head, 3),
                "heardNormalized": local_heard,
            }
            ok = local_sim >= 0.55 and local_head >= 0.6
        rows.append({
            "id": u["id"],
            "fullSimilarity": round(best_sim, 3),
            "headSimilarity": round(best_head, 3),
            **({"windowedRecheck": recheck} if recheck else {}),
            "pass": bool(ok),
        })
    result = {
        "version": "stt-verification-v2-fulltrack",
        "videoPath": video,
        "model": "faster-whisper small int8 (single pass, order-aligned, kuromoji phonetic normalization)",
        "rows": rows,
        "pass": all(r["pass"] for r in rows),
    }
    output_path = Path(args.output).resolve() if args.output else manifest_path.parent / "stt-verification-audit.json"
    output_path.write_text(json.dumps(result, ensure_ascii=False, indent=1))
    print(json.dumps({"pass": result["pass"], "failures": [r for r in rows if not r["pass"]], "checked": len(rows)}, ensure_ascii=False))
    if not result["pass"]:
        sys.exit(1)


if __name__ == "__main__":
    main()
