#!/usr/bin/env python3
"""Voice quality gates for generated Japanese speech (both harnesses).

Measures, per utterance WAV:
  - utmos:     UTMOS22 predicted naturalness MOS (torch.hub tarepan/SpeechMOS)
  - cer:       character error rate vs expected text (faster-whisper, kana-insensitive)
  - prosody:   F0 spread in semitones (monotone detector), voiced ratio,
               speech rate in mora/sec (needs expectedText), edge silences
  - loudness:  integrated LUFS (pyloudnorm), sample peak / clipping
  - speaker:   cosine similarity to an approved anchor voice (resemblyzer)

Config JSON:
{
  "checks": [
    {"id": "...", "type": "voiceQuality",
     "audio": "utt.wav",
     "expectedText": "こんにちは",              // optional: enables cer + mora rate
     "anchorAudio": "approved-voice.wav",        // optional: enables speaker similarity
     "minUtmos": 2.7, "warnUtmos": 3.1,
     "maxCer": 0.15,
     "minF0SemitoneStd": 1.2,                    // below = monotone read
     "moraPerSecRange": [4.0, 10.0],
     "maxEdgeSilenceSec": 1.5,
     "loudness": {"target": -14.0, "tolerance": 4.0},
     "minSpeakerCosine": 0.72}
  ]
}

Metrics whose optional dependency or input is missing are reported with
status "unavailable" instead of silently passing; the check fails only on
measured violations. Exit 0 = no failures, 3 = at least one check failed.
All inference is local; audio never leaves the machine.
"""
import hashlib
import json
import math
import sys
import unicodedata
from pathlib import Path

import numpy as np

SMALL_KANA = set("ゃゅょぁぃぅぇぉャュョァィゥェォっッー")


def fail(message):
    print(f"ERROR: {message}", file=sys.stderr)
    sys.exit(1)


def load_audio(path, target_sr=16000):
    import soundfile as sf
    data, sr = sf.read(str(path), dtype="float64", always_2d=True)
    mono = data.mean(axis=1)
    if sr != target_sr:
        import librosa
        mono = librosa.resample(mono, orig_sr=sr, target_sr=target_sr)
        sr = target_sr
    return mono, sr


def normalize_kana(text):
    """Reading-normalize: convert to katakana via morphological analysis so
    kanji spellings and kana transcripts compare as pronunciation, then strip
    punctuation/whitespace."""
    text = unicodedata.normalize("NFKC", text)
    try:
        from fugashi import Tagger
        global _TAGGER
        if "_TAGGER" not in globals() or _TAGGER is None:
            _TAGGER = Tagger()
        text = "".join(
            (word.feature.kana if getattr(word.feature, "kana", None) else word.surface)
            for word in _TAGGER(text)
        )
    except ImportError:
        pass
    text = "".join(chr(ord(ch) + 0x60) if "ぁ" <= ch <= "ゔ" else ch for ch in text)
    return "".join(ch for ch in text if not unicodedata.category(ch).startswith("P") and not ch.isspace())


def mora_count(text):
    try:
        from fugashi import Tagger
    except ImportError:
        return None
    tagger = Tagger()
    yomi = "".join(
        (word.feature.kana or word.surface) if hasattr(word.feature, "kana") else word.surface
        for word in tagger(text)
    )
    yomi = unicodedata.normalize("NFKC", yomi)
    return sum(1 for ch in yomi if ("ァ" <= ch <= "ヺ" or "ぁ" <= ch <= "ゔ") and ch not in SMALL_KANA) or None


_UTMOS = None


def utmos_score(audio, sr):
    global _UTMOS
    import torch
    if _UTMOS is None:
        _UTMOS = torch.hub.load("tarepan/SpeechMOS:v1.2.0", "utmos22_strong", trust_repo=True)
    with torch.no_grad():
        return float(_UTMOS(torch.from_numpy(audio).float().unsqueeze(0), sr).item())


def f0_semitone_std(audio, sr):
    import pyworld
    f0, _ = pyworld.harvest(audio, sr, f0_floor=60.0, f0_ceil=500.0, frame_period=10.0)
    voiced = f0[f0 > 0]
    if voiced.size < 10:
        return None, 0.0
    semitones = 12.0 * np.log2(voiced / np.median(voiced))
    return float(np.std(semitones)), float(voiced.size / f0.size)


def edge_silence_seconds(audio, sr, threshold_db=-45.0):
    amplitude = np.abs(audio)
    if amplitude.max() <= 0:
        return len(audio) / sr, len(audio) / sr
    limit = amplitude.max() * (10 ** (threshold_db / 20.0))
    above = np.flatnonzero(amplitude > limit)
    if above.size == 0:
        return len(audio) / sr, len(audio) / sr
    return float(above[0] / sr), float((len(audio) - 1 - above[-1]) / sr)


def integrated_lufs(audio, sr):
    try:
        import pyloudnorm
    except ImportError:
        return None
    meter = pyloudnorm.Meter(sr)
    return float(meter.integrated_loudness(audio))


_WHISPER = None


def transcribe(path, check_model=None):
    global _WHISPER
    try:
        from faster_whisper import WhisperModel
    except ImportError:
        return None
    if _WHISPER is None:
        _WHISPER = WhisperModel(check_model or "kotoba-tech/kotoba-whisper-v2.0-faster", device="cpu", compute_type="int8")
    segments, _ = _WHISPER.transcribe(str(path), language="ja", beam_size=5)
    return "".join(segment.text for segment in segments)


def char_error_rate(expected, actual):
    expected, actual = normalize_kana(expected), normalize_kana(actual)
    if not expected:
        return None
    rows = list(range(len(actual) + 1))
    for i, ech in enumerate(expected, 1):
        previous, rows[0] = rows[0], i
        for j, ach in enumerate(actual, 1):
            previous, rows[j] = rows[j], min(rows[j] + 1, rows[j - 1] + 1, previous + (ech != ach))
    return rows[-1] / len(expected)


_SPEAKER_ENCODER = None


def speaker_cosine(audio_path, anchor_path):
    global _SPEAKER_ENCODER
    try:
        from resemblyzer import VoiceEncoder, preprocess_wav
    except ImportError:
        return None
    if _SPEAKER_ENCODER is None:
        _SPEAKER_ENCODER = VoiceEncoder()
    a = _SPEAKER_ENCODER.embed_utterance(preprocess_wav(Path(audio_path)))
    b = _SPEAKER_ENCODER.embed_utterance(preprocess_wav(Path(anchor_path)))
    return float(np.dot(a, b) / (np.linalg.norm(a) * np.linalg.norm(b)))


def check_voice_quality(check):
    audio_path = Path(check["audio"])
    if not audio_path.exists():
        fail(f"audio not found: {audio_path}")
    audio, sr = load_audio(audio_path)
    duration = len(audio) / sr
    metrics = {"durationSec": round(duration, 3)}
    problems, warnings, unavailable = [], [], []

    try:
        score = utmos_score(audio, sr)
        metrics["utmos"] = round(score, 3)
        # UTMOS under-scores very short clips (approved 1.0s utterance measured
        # 2.18 on 2026-08-28 calibration), so below minUtmosDuration a low MOS
        # is a warning for human ears, not an automatic rejection.
        short_clip = duration < float(check.get("minUtmosDuration", 2.0))
        if score < float(check.get("minUtmos", 2.7)):
            (warnings if short_clip else problems).append(
                f"utmos {score:.2f} < {check.get('minUtmos', 2.7)}" + (" (short clip)" if short_clip else ""))
        elif score < float(check.get("warnUtmos", 0.0)):
            warnings.append(f"utmos {score:.2f} below warn threshold")
    except Exception as error:  # noqa: BLE001 - report which metric is missing
        unavailable.append(f"utmos: {str(error)[:80]}")

    std, voiced_ratio = None, None
    try:
        std, voiced_ratio = f0_semitone_std(audio, sr)
        if std is not None:
            metrics["f0SemitoneStd"] = round(std, 2)
            metrics["voicedRatio"] = round(voiced_ratio, 3)
            if std < float(check.get("minF0SemitoneStd", 1.2)):
                problems.append(f"monotone pitch: f0 std {std:.2f} semitones")
    except Exception as error:  # noqa: BLE001
        unavailable.append(f"f0: {str(error)[:80]}")

    lead, tail = edge_silence_seconds(audio, sr)
    metrics["edgeSilenceSec"] = [round(lead, 2), round(tail, 2)]
    max_edge = float(check.get("maxEdgeSilenceSec", 1.5))
    if max(lead, tail) > max_edge:
        problems.append(f"edge silence {max(lead, tail):.2f}s > {max_edge}s")

    # Internal silences from the amplitude envelope (provider-agnostic):
    # warn-level because long pauses can be intentional drama.
    frame = max(1, sr // 100)
    envelope = np.abs(audio[: (len(audio) // frame) * frame]).reshape(-1, frame).max(axis=1)
    if envelope.max() > 0:
        quiet = envelope < envelope.max() * (10 ** (-45.0 / 20.0))
        runs, run = [], 0
        for flag in quiet:
            run = run + 1 if flag else (runs.append(run) or 0 if run else 0)
        interior = quiet.copy()
        first_loud = int(np.argmax(~quiet))
        last_loud = len(quiet) - 1 - int(np.argmax(~quiet[::-1]))
        interior[: first_loud] = False
        interior[last_loud:] = False
        best, run = 0, 0
        for flag in interior:
            run = run + 1 if flag else 0
            best = max(best, run)
        internal_pause = best / 100.0
        metrics["maxInternalPauseSec"] = round(internal_pause, 2)
        if internal_pause > float(check.get("maxInternalPauseSec", 0.9)):
            warnings.append(f"internal pause {internal_pause:.2f}s (check intent)")

    peak = float(np.abs(audio).max())
    metrics["peak"] = round(peak, 4)
    if peak >= 0.999:
        problems.append("clipping at full scale")

    lufs = integrated_lufs(audio, sr)
    if lufs is None:
        unavailable.append("loudness: pyloudnorm missing")
    else:
        metrics["lufs"] = round(lufs, 2)
        loudness = check.get("loudness") or {}
        if loudness:
            target, tolerance = float(loudness.get("target", -14.0)), float(loudness.get("tolerance", 4.0))
            if abs(lufs - target) > tolerance:
                problems.append(f"loudness {lufs:.1f} LUFS outside {target}±{tolerance}")

    expected = check.get("expectedText", "")
    if expected:
        moras = mora_count(expected)
        if moras and duration > max(lead + tail, 0.01):
            rate = moras / max(duration - lead - tail, 0.2)
            metrics["moraPerSec"] = round(rate, 2)
            lo, hi = check.get("moraPerSecRange", [4.0, 10.0])
            if not (float(lo) <= rate <= float(hi)):
                problems.append(f"speech rate {rate:.1f} mora/s outside {lo}-{hi}")
        elif moras is None:
            unavailable.append("moraRate: fugashi missing")
        actual = transcribe(audio_path)
        if actual is None:
            unavailable.append("cer: faster-whisper missing")
        else:
            cer = char_error_rate(expected, actual)
            metrics["cer"] = round(cer, 4)
            metrics["transcript"] = actual[:120]
            if cer > float(check.get("maxCer", 0.13)):
                problems.append(f"cer {cer:.3f} > {check.get('maxCer', 0.13)}")

    anchor = check.get("anchorAudio")
    if anchor:
        cosine = speaker_cosine(audio_path, anchor)
        if cosine is None:
            unavailable.append("speaker: resemblyzer missing")
        else:
            metrics["speakerCosine"] = round(cosine, 4)
            if cosine < float(check.get("minSpeakerCosine", 0.72)):
                problems.append(f"speaker cosine {cosine:.3f} below {check.get('minSpeakerCosine', 0.72)}")

    status = "fail" if problems else ("warn" if warnings or unavailable else "pass")
    return {"metrics": metrics, "problems": problems, "warnings": warnings,
            "unavailable": unavailable, "status": status}


HANDLERS = {"voiceQuality": check_voice_quality}


def input_digests(check):
    digests = {}
    for key in ("audio", "anchorAudio"):
        if check.get(key):
            digests[str(check[key])] = hashlib.sha256(Path(check[key]).read_bytes()).hexdigest()
    return digests


def main():
    if len(sys.argv) != 2:
        fail("usage: audit-voice-quality.py <config.json>")
    config = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    checks = config.get("checks", [])
    if not checks:
        fail("config.checks must not be empty")
    results = []
    for check in checks:
        handler = HANDLERS.get(check.get("type"))
        if handler is None:
            fail(f"unknown check type: {check.get('type')}")
        outcome = handler(check)
        results.append({"id": check.get("id", ""), "type": check["type"],
                        "inputSha256": input_digests(check), **outcome})
    overall = "fail" if any(r["status"] == "fail" for r in results) else (
        "warn" if any(r["status"] == "warn" for r in results) else "pass")
    print(json.dumps({"overall": overall, "checks": results}, ensure_ascii=False))
    sys.exit(0 if overall != "fail" else 3)


if __name__ == "__main__":
    main()
