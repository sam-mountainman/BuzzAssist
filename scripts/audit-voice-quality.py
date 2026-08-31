#!/usr/bin/env python3
"""Voice quality gates for generated Japanese speech (ledger R194, rev 2).

Per-check measurements:
  - utmos:    UTMOS22 naturalness MOS, loaded OFFLINE from the local torch hub
              cache only (no runtime code fetch; pre-fetch once by trusted hand)
  - cer:      STT round-trip CER per SEGMENT (utterance) when segments are
              given, else whole-clip; expected side uses `expectedReading`
              (confirmed kana) when provided so the metric is not circular
              through the same morphological dictionary as the transcript
  - prosody:  F0 semitone spread per segment (monotone), speech rate in
              mora/sec (sokuon and chouon COUNT as moras), edge silences and
              internal pauses via Silero VAD when available (envelope fallback)
  - levels:   sample peak measured on the ORIGINAL file samples (pre-resample),
              integrated LUFS (pyloudnorm)
  - speaker:  cosine vs anchor voice (resemblyzer; SpeechBrain ECAPA when
              VOICE_QA_SPEAKER_BACKEND=ecapa)

Config JSON:
{"checks": [{
  "id": "...", "type": "voiceQuality", "audio": "take.wav",
  "expectedText": "...",              // optional whole-clip fallback
  "expectedReading": "コンニチハ...",  // optional confirmed kana (preferred)
  "segments": [{"id": "u01", "start": 0.0, "end": 2.4,
                 "expectedText": "...", "expectedReading": "..."}],
  "anchorAudio": "...", "minUtmos": 2.7, "maxCer": 0.13, ...}]}

Every check result carries `inputSha256` (audio bytes) and `checkDigest`
(canonical config: expected text/reading, thresholds, segments) plus a
report-level `environment` block, so a stored PASS is bound to exactly what
was judged. Metrics with missing dependencies are listed in `unavailable`,
never silently passed. Exit 0 = no failures, 3 = at least one check failed.
All inference is local; audio never leaves the machine.
"""
import hashlib
import json
import os
import sys
import unicodedata
from pathlib import Path

import numpy as np

# Small kana combine with the previous mora; sokuon (っ/ッ) and chouon (ー)
# are their own moras (がっこう=4, スーパー=4 — 2026-08-28 Codex review fix).
COMBINING_KANA = set("ゃゅょぁぃぅぇぉャュョァィゥェォ")
UTMOS_CACHE_DIR = Path.home() / ".cache/torch/hub/tarepan_SpeechMOS_v1.2.0"


def fail(message):
    print(f"ERROR: {message}", file=sys.stderr)
    sys.exit(1)


def load_audio(path, target_sr=16000):
    import soundfile as sf
    data, sr = sf.read(str(path), dtype="float64", always_2d=True)
    original_peak = float(np.abs(data).max()) if data.size else 0.0
    mono = data.mean(axis=1)
    if sr != target_sr:
        import librosa
        mono = librosa.resample(mono, orig_sr=sr, target_sr=target_sr)
        sr = target_sr
    return mono, sr, original_peak


_TAGGER = None


def tagger():
    global _TAGGER
    if _TAGGER is None:
        from fugashi import Tagger
        _TAGGER = Tagger()
    return _TAGGER


def to_katakana_reading(text):
    """Morphological reading (katakana). Used for the TRANSCRIPT side and as
    a fallback for expected text when no confirmed reading is supplied."""
    text = unicodedata.normalize("NFKC", text)
    try:
        text = "".join(
            (word.feature.kana if getattr(word.feature, "kana", None) else word.surface)
            for word in tagger()(text)
        )
    except ImportError as error:
        # A raw-text fallback silently drops every kanji from the mora count,
        # making normal Japanese narration look artificially slow.  Speech
        # rate is a hard gate, so the tokenizer must be a hard dependency too.
        raise RuntimeError(
            "Japanese reading audit requires fugashi and a UniDic dictionary; "
            "refusing to compute a partial mora count"
        ) from error
    return fold_kana(text)


def fold_kana(text):
    text = unicodedata.normalize("NFKC", text)
    text = "".join(chr(ord(ch) + 0x60) if "ぁ" <= ch <= "ゔ" else ch for ch in text)
    return "".join(ch for ch in text if not unicodedata.category(ch).startswith("P") and not ch.isspace())


def mora_count_from_reading(reading):
    return sum(
        1 for ch in reading
        if ("ァ" <= ch <= "ヺ" or ch == "ー") and ch not in COMBINING_KANA
    )


_UTMOS = None
_UTMOS_ERROR = None


def utmos_score(audio, sr):
    global _UTMOS, _UTMOS_ERROR
    if _UTMOS_ERROR:
        raise RuntimeError(_UTMOS_ERROR)
    if _UTMOS is None:
        import torch
        checkpoint = Path.home() / ".cache/torch/hub/checkpoints/utmos22_strong_step7459_v1.pt"
        if not UTMOS_CACHE_DIR.exists() or not checkpoint.exists():
            _UTMOS_ERROR = (
                f"UTMOS cache incomplete ({UTMOS_CACHE_DIR}, {checkpoint.name}); pre-fetch once "
                "on a trusted run — this gate never downloads at audit time"
            )
            raise RuntimeError(_UTMOS_ERROR)
        # source="local" executes only the already-audited cached snapshot —
        # no network fetch, no fresh third-party code (Codex review, R194).
        _UTMOS = torch.hub.load(str(UTMOS_CACHE_DIR), "utmos22_strong", source="local")
    import torch
    with torch.no_grad():
        return float(_UTMOS(torch.from_numpy(audio).float().unsqueeze(0), sr).item())


def f0_semitone_std(audio, sr):
    import pyworld
    f0, _ = pyworld.harvest(np.ascontiguousarray(audio), sr, f0_floor=60.0, f0_ceil=500.0, frame_period=10.0)
    voiced = f0[f0 > 0]
    if voiced.size < 10:
        return None, 0.0
    semitones = 12.0 * np.log2(voiced / np.median(voiced))
    return float(np.std(semitones)), float(voiced.size / f0.size)


_VAD = None
_VAD_ERROR = None


def speech_spans(audio, sr):
    """Speech spans in seconds via Silero VAD; None when unavailable."""
    global _VAD, _VAD_ERROR
    if _VAD_ERROR:
        return None
    try:
        if _VAD is None:
            from silero_vad import get_speech_timestamps, load_silero_vad
            _VAD = (load_silero_vad(), get_speech_timestamps)
        model, get_ts = _VAD
        import torch
        stamps = get_ts(torch.from_numpy(audio).float(), model, sampling_rate=sr)
        return [(t["start"] / sr, t["end"] / sr) for t in stamps]
    except Exception as error:  # noqa: BLE001
        _VAD_ERROR = str(error)[:120]
        return None


def envelope_edges(audio, sr, threshold_db=-45.0):
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
    return float(pyloudnorm.Meter(sr).integrated_loudness(audio))


_WHISPER = None


def whisper_model(model_name=None):
    global _WHISPER
    try:
        from faster_whisper import WhisperModel
    except ImportError:
        return None
    if _WHISPER is None:
        name = model_name or "kotoba-tech/kotoba-whisper-v2.0-faster"
        try:
            _WHISPER = WhisperModel(name, device="cpu", compute_type="int8", local_files_only=True)
        except Exception:  # noqa: BLE001 - cache miss
            if os.environ.get("VOICE_QA_ALLOW_DOWNLOAD") != "1":
                return None
            _WHISPER = WhisperModel(name, device="cpu", compute_type="int8")
    return _WHISPER


def transcribe(audio_or_path, model_name=None):
    model = whisper_model(model_name)
    if model is None:
        return None
    source = audio_or_path if isinstance(audio_or_path, str) else audio_or_path.astype(np.float32)
    segments, _ = model.transcribe(source, language="ja", beam_size=5)
    return "".join(segment.text for segment in segments)


def first_pos(text):
    try:
        for word in tagger()(text):
            return str(word.feature.pos1 or "")
    except ImportError:
        return ""
    return ""


_ALIGN_WHISPER = None


def align_whisper_model():
    """Word timestamps need alignment heads, which the distil kotoba model
    lacks (ctranslate2 align -> bad_alloc). The cached "small" model provides
    the timing; kotoba stays the CER transcriber."""
    global _ALIGN_WHISPER
    try:
        from faster_whisper import WhisperModel
    except ImportError:
        return None
    if _ALIGN_WHISPER is None:
        try:
            _ALIGN_WHISPER = WhisperModel("small", device="cpu", compute_type="int8", local_files_only=True)
        except Exception:  # noqa: BLE001
            if os.environ.get("VOICE_QA_ALLOW_DOWNLOAD") != "1":
                return None
            _ALIGN_WHISPER = WhisperModel("small", device="cpu", compute_type="int8")
    return _ALIGN_WHISPER


def pause_position_audit(audio_or_path, min_pause=0.3):
    """Word-timestamp pause audit: a pause is natural after a phrase, but a
    pause IMMEDIATELY BEFORE a particle/auxiliary or inside a word reads as a
    breath in the wrong place. Heuristic soft signal (warn), never a fail."""
    model = align_whisper_model()
    if model is None:
        return None
    source = audio_or_path if isinstance(audio_or_path, str) else audio_or_path.astype(np.float32)
    segments, _ = model.transcribe(source, language="ja", beam_size=5, word_timestamps=True)
    words = [(w.word.strip(), w.start, w.end) for seg in segments for w in (seg.words or []) if w.word.strip()]
    pauses, suspicious = [], []
    for i in range(1, len(words)):
        gap = words[i][1] - words[i - 1][2]
        if gap >= min_pause:
            entry = {"afterWord": words[i - 1][0][-8:], "beforeWord": words[i][0][:8], "gapSec": round(gap, 2)}
            pauses.append(entry)
            pos = first_pos(words[i][0])
            if pos in ("助詞", "助動詞"):
                suspicious.append({**entry, "reason": f"pause-before-{pos}"})
    return {"pauses": pauses[:16], "suspicious": suspicious[:8]}


def reading_error_rate(expected_text, expected_reading, transcript):
    expected = fold_kana(expected_reading) if expected_reading else to_katakana_reading(expected_text)
    actual = to_katakana_reading(transcript)
    if not expected:
        return None
    rows = list(range(len(actual) + 1))
    for i, ech in enumerate(expected, 1):
        previous, rows[0] = rows[0], i
        for j, ach in enumerate(actual, 1):
            previous, rows[j] = rows[j], min(rows[j] + 1, rows[j - 1] + 1, previous + (ech != ach))
    return rows[-1] / len(expected)


_SPEAKER = None


def speaker_cosine(audio_path, anchor_path):
    global _SPEAKER
    backend = os.environ.get("VOICE_QA_SPEAKER_BACKEND", "resemblyzer")
    try:
        if backend == "ecapa":
            if _SPEAKER is None:
                from speechbrain.inference.speaker import SpeakerRecognition
                _SPEAKER = SpeakerRecognition.from_hparams(
                    source="speechbrain/spkrec-ecapa-voxceleb",
                    savedir=str(Path.home() / ".cache/speechbrain-ecapa"),
                )
            score, _ = _SPEAKER.verify_files(str(audio_path), str(anchor_path))
            return float(score.item())
        from resemblyzer import VoiceEncoder, preprocess_wav
        if _SPEAKER is None:
            _SPEAKER = VoiceEncoder()
        a = _SPEAKER.embed_utterance(preprocess_wav(Path(audio_path)))
        b = _SPEAKER.embed_utterance(preprocess_wav(Path(anchor_path)))
        return float(np.dot(a, b) / (np.linalg.norm(a) * np.linalg.norm(b)))
    except ImportError:
        return None


def canonical_check_digest(check):
    material = {k: check[k] for k in sorted(check) if k not in ("id",)}
    return hashlib.sha256(json.dumps(material, ensure_ascii=False, sort_keys=True).encode()).hexdigest()


def slice_audio(audio, sr, start, end):
    lo = max(0, int(start * sr))
    hi = min(len(audio), int(end * sr))
    return audio[lo:hi]


def check_voice_quality(check):
    audio_path = Path(check["audio"])
    if not audio_path.exists():
        fail(f"audio not found: {audio_path}")
    audio, sr, original_peak = load_audio(audio_path)
    duration = len(audio) / sr
    metrics = {"durationSec": round(duration, 3), "peak": round(original_peak, 4)}
    problems, warnings, unavailable = [], [], []

    if original_peak >= 0.999:
        problems.append("clipping at full scale (original samples)")

    if check.get("computeUtmos", True):
        try:
            score = utmos_score(audio, sr)
            metrics["utmos"] = round(score, 3)
            short_clip = duration < float(check.get("minUtmosDuration", 2.0))
            if score < float(check.get("minUtmos", 2.7)):
                (warnings if short_clip else problems).append(
                    f"utmos {score:.2f} < {check.get('minUtmos', 2.7)}" + (" (short clip)" if short_clip else ""))
            elif score < float(check.get("warnUtmos", 0.0)):
                warnings.append(f"utmos {score:.2f} below warn threshold")
        except Exception as error:  # noqa: BLE001
            unavailable.append(f"utmos: {str(error)[:120]}")
    else:
        metrics["utmos"] = "not-computed-by-config"

    spans = speech_spans(audio, sr)
    if spans:
        metrics["vad"] = "silero"
        lead, tail = spans[0][0], duration - spans[-1][1]
        internal = [round(spans[i + 1][0] - spans[i][1], 2)
                    for i in range(len(spans) - 1)
                    if spans[i + 1][0] - spans[i][1] > 0.05]
        metrics["internalPausesSec"] = internal[:12]
        max_pause = float(check.get("maxInternalPauseSec", 1.2))
        if any(p > max_pause for p in internal):
            problems.append(f"internal pause {max(internal):.2f}s > {max_pause}s")
    else:
        metrics["vad"] = "envelope-fallback"
        if _VAD_ERROR:
            unavailable.append(f"vad: {_VAD_ERROR}")
        lead, tail = envelope_edges(audio, sr)
    metrics["edgeSilenceSec"] = [round(lead, 2), round(tail, 2)]
    max_edge = float(check.get("maxEdgeSilenceSec", 1.5))
    if max(lead, tail) > max_edge:
        problems.append(f"edge silence {max(lead, tail):.2f}s > {max_edge}s")

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

    segments = check.get("segments") or []
    if segments:
        segment_rows = []
        for segment in segments:
            seg_id = segment.get("id", "")
            clip = slice_audio(audio, sr, float(segment.get("start", 0)), float(segment.get("end", duration)))
            seg_duration = len(clip) / sr
            row = {"id": seg_id, "durationSec": round(seg_duration, 3)}
            if seg_duration < 0.15:
                row["skipped"] = "too short"
                segment_rows.append(row)
                continue
            expected_text = segment.get("expectedText", "")
            if expected_text:
                transcript = transcribe(clip)
                if transcript is None:
                    unavailable.append(f"cer[{seg_id}]: faster-whisper missing")
                else:
                    cer = reading_error_rate(expected_text, segment.get("expectedReading", ""), transcript)
                    row["cer"] = round(cer, 4)
                    row["transcript"] = transcript[:80]
                    if cer > float(check.get("maxCer", 0.13)):
                        problems.append(f"cer[{seg_id}] {cer:.3f} > {check.get('maxCer', 0.13)}")
                reading = segment.get("expectedReading", "") or to_katakana_reading(expected_text)
                moras = mora_count_from_reading(fold_kana(reading))
                if moras and seg_duration > 0.2:
                    rate = moras / seg_duration
                    row["moraPerSec"] = round(rate, 2)
                    lo, hi = check.get("moraPerSecRange", [4.0, 10.0])
                    if not (float(lo) <= rate <= float(hi)):
                        problems.append(f"speech rate[{seg_id}] {rate:.1f} mora/s outside {lo}-{hi}")
            if seg_duration >= 0.5:
                try:
                    std, _voiced = f0_semitone_std(clip, sr)
                    if std is not None:
                        row["f0SemitoneStd"] = round(std, 2)
                        if std < float(check.get("minF0SemitoneStd", 1.2)):
                            problems.append(f"monotone pitch[{seg_id}]: f0 std {std:.2f}")
                except Exception as error:  # noqa: BLE001
                    unavailable.append(f"f0[{seg_id}]: {str(error)[:80]}")
            segment_rows.append(row)
        metrics["segments"] = segment_rows
    else:
        expected = check.get("expectedText", "")
        if expected:
            transcript = transcribe(str(audio_path))
            if transcript is None:
                unavailable.append("cer: faster-whisper missing")
            else:
                cer = reading_error_rate(expected, check.get("expectedReading", ""), transcript)
                metrics["cer"] = round(cer, 4)
                metrics["transcript"] = transcript[:120]
                if cer > float(check.get("maxCer", 0.13)):
                    problems.append(f"cer {cer:.3f} > {check.get('maxCer', 0.13)}")
            reading = check.get("expectedReading", "") or to_katakana_reading(expected)
            moras = mora_count_from_reading(fold_kana(reading))
            voiced_window = max(duration - lead - tail, 0.2)
            if moras:
                rate = moras / voiced_window
                metrics["moraPerSec"] = round(rate, 2)
                lo, hi = check.get("moraPerSecRange", [4.0, 10.0])
                if not (float(lo) <= rate <= float(hi)):
                    problems.append(f"speech rate {rate:.1f} mora/s outside {lo}-{hi}")
        try:
            std, voiced_ratio = f0_semitone_std(audio, sr)
            if std is None:
                unavailable.append("f0: not enough voiced frames")
            else:
                metrics["f0SemitoneStd"] = round(std, 2)
                metrics["voicedRatio"] = round(voiced_ratio, 3)
                if std < float(check.get("minF0SemitoneStd", 1.2)):
                    problems.append(f"monotone pitch: f0 std {std:.2f} semitones")
        except Exception as error:  # noqa: BLE001
            unavailable.append(f"f0: {str(error)[:80]}")

    if (check.get("expectedText") or segments) and check.get("pausePositionAudit", True):
        try:
            audit = pause_position_audit(str(audio_path), float(check.get("minPausePositionSec", 0.3)))
            if audit is None:
                unavailable.append("pausePosition: faster-whisper missing")
            else:
                metrics["pausePositions"] = audit["pauses"]
                for finding in audit["suspicious"]:
                    warnings.append(
                        f"unnatural pause {finding['gapSec']}s before particle "
                        f"({finding['afterWord']}|{finding['beforeWord']})")
        except Exception as error:  # noqa: BLE001
            unavailable.append(f"pausePosition: {str(error)[:80]}")

    anchor = check.get("anchorAudio")
    if anchor:
        cosine = speaker_cosine(audio_path, anchor)
        if cosine is None:
            unavailable.append("speaker: backend missing")
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
                        "inputSha256": input_digests(check),
                        "checkDigest": canonical_check_digest(check),
                        **outcome})
    overall = "fail" if any(r["status"] == "fail" for r in results) else (
        "warn" if any(r["status"] == "warn" for r in results) else "pass")
    environment = {
        "scriptSha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        "utmosSource": str(UTMOS_CACHE_DIR),
        "whisperModel": "kotoba-tech/kotoba-whisper-v2.0-faster",
        "speakerBackend": os.environ.get("VOICE_QA_SPEAKER_BACKEND", "resemblyzer"),
    }
    print(json.dumps({"overall": overall, "environment": environment, "checks": results}, ensure_ascii=False))
    sys.exit(0 if overall != "fail" else 3)


if __name__ == "__main__":
    main()
