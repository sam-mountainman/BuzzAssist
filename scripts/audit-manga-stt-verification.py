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
import hashlib
import re
import subprocess
import sys
import tempfile
import unicodedata
import os
from difflib import SequenceMatcher
from pathlib import Path

COMMON_READING_VARIANTS = {
    # IPADIC bundled with kuromoji treats the first character of this common
    # recruiting abbreviation as unknown, while Whisper usually emits kana or
    # the homophone 周活. Canonicalize the intended spoken reading first.
    "就活": "しゅうかつ",
}

DEFAULT_MANIFEST = Path("canvas/manga-videos/manga-photo-homecoming-001/episode-manifest.json")


# Only the standalone vowel smalls fold. Small ya/yu/yo must not: 「びょういん」
# and 「びよういん」 are different words, and small tsu is real gemination.
SMALL_KANA_FOLD = str.maketrans({
    "ぁ": "あ", "ぃ": "い", "ぅ": "う", "ぇ": "え", "ぉ": "お",
})


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
    text = "".join(chr(ord(ch) - 0x60) if "ァ" <= ch <= "ヶ" else ch for ch in text)
    # A transcript writing 「ねぇ」 for 「ねえ」 is the same utterance, and an
    # acoustically correct line must not fail on that spelling choice.
    return text.translate(SMALL_KANA_FOLD)


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


def sha256_file(path):
    digest = hashlib.sha256()
    with open(path, "rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def extract_pcm(video, output_path):
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", video,
                    "-vn", "-ar", "16000", "-ac", "1", output_path], check=True)


def reusable_cached_report(output_path, video, current_audio_sha256, expected_sha256, expected_ids):
    if not output_path.exists():
        return None
    try:
        cached = json.loads(output_path.read_text())
    except (OSError, json.JSONDecodeError):
        return None
    if cached.get("pass") is not True or [row.get("id") for row in cached.get("rows", [])] != expected_ids:
        return None
    if cached.get("expectedSpeechSha256") != expected_sha256:
        return None
    # A cached videoPath often names the same final file that has just been
    # overwritten. Re-extracting that path would compare the new PCM with
    # itself and incorrectly bless stale transcript rows. Only the PCM digest
    # captured when those rows were produced can authorize reuse.
    if cached.get("audioSha256") != current_audio_sha256:
        return None
    return cached


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
    raw_expected = [u.get("speechText") or u["text"] for u in manifest["utterances"]]
    expected_ids = [u["id"] for u in manifest["utterances"]]
    # Neighbouring line edges, so a focused recheck can be clipped to this
    # line's own silence instead of reaching into the next character's words.
    ordered = sorted(
        manifest["utterances"],
        key=lambda entry: float((entry.get("timing") or {}).get("audioStartSeconds", 0.0)),
    )
    previous_audio_end = {}
    next_audio_start = {}
    for position, entry in enumerate(ordered):
        if position > 0:
            before = ordered[position - 1]
            previous_audio_end[entry["id"]] = (
                float(before["timing"]["audioStartSeconds"])
                + float(before["audio"]["durationSeconds"])
            )
        if position + 1 < len(ordered):
            next_audio_start[entry["id"]] = float(ordered[position + 1]["timing"]["audioStartSeconds"])
    expected_sha256 = hashlib.sha256(json.dumps({
        "utterances": list(zip(expected_ids, raw_expected)),
        "pronunciationVariants": pronunciation_variants,
    }, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest()
    output_path = Path(args.output).resolve() if args.output else manifest_path.parent / "stt-verification-audit.json"
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
        tmp_path = tmp.name
    extract_pcm(video, tmp_path)
    audio_sha256 = sha256_file(tmp_path)
    cached = reusable_cached_report(output_path, video, audio_sha256, expected_sha256, expected_ids)
    if cached:
        cached.update({
            "version": "stt-verification-v3-audio-hash-cache",
            "videoPath": video,
            "audioSha256": audio_sha256,
            "expectedSpeechSha256": expected_sha256,
            "cache": {
                "hit": True,
                "basis": "exact-decoded-pcm-and-ordered-utterance-ids",
            },
        })
        output_path.write_text(json.dumps(cached, ensure_ascii=False, indent=1))
        os.unlink(tmp_path)
        print(json.dumps({"pass": True, "failures": [], "checked": len(cached["rows"]), "cacheHit": True}, ensure_ascii=False))
        return
    from faster_whisper import WhisperModel
    model = WhisperModel("small", device="cpu", compute_type="int8")
    # One transcription pass over the whole episode; per-line verification is
    # then pure text alignment with an order cursor, so concat frame-rounding
    # drift cannot shift any window.
    segments, _ = model.transcribe(tmp_path, language="ja", beam_size=3,
                                   condition_on_previous_text=False)
    raw_heard_full = "".join(seg.text for seg in segments)
    os.unlink(tmp_path)
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
            # The margins must stay inside this line's own silence. Gaps between
            # lines are ~0.18 s, so a fixed 0.35/0.45 s margin reaches into the
            # neighbouring line and makes the recheck score its words against
            # this line's text.
            start_seconds = float(t["audioStartSeconds"])
            end_seconds = start_seconds + float(a["durationSeconds"])
            previous_end = previous_audio_end.get(u["id"])
            next_start = next_audio_start.get(u["id"])
            head_margin = 0.35 if previous_end is None else max(0.0, min(0.35, start_seconds - previous_end - 0.02))
            tail_margin = 0.45 if next_start is None else max(0.0, min(0.45, next_start - end_seconds - 0.02))
            with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp2:
                tmp2_path = tmp2.name
            subprocess.run(["ffmpeg", "-v", "error", "-y",
                            "-ss", str(max(0, start_seconds - head_margin)),
                            "-t", str(float(a["durationSeconds"]) + head_margin + tail_margin),
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
        "version": "stt-verification-v3-audio-hash-cache",
        "videoPath": video,
        "audioSha256": audio_sha256,
        "expectedSpeechSha256": expected_sha256,
        "cache": {"hit": False, "basis": "fresh-faster-whisper-transcription"},
        "model": "faster-whisper small int8 (single pass, order-aligned, kuromoji phonetic normalization)",
        "rows": rows,
        "pass": all(r["pass"] for r in rows),
    }
    output_path.write_text(json.dumps(result, ensure_ascii=False, indent=1))
    print(json.dumps({"pass": result["pass"], "failures": [r for r in rows if not r["pass"]], "checked": len(rows)}, ensure_ascii=False))
    if not result["pass"]:
        sys.exit(1)


if __name__ == "__main__":
    main()
