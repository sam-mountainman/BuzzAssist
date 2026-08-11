#!/usr/bin/env python3
"""Generate stable, expressive Japanese episode dialogue with Style-Bert-VITS2."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import time
from pathlib import Path

import numpy as np
import torch
from huggingface_hub import hf_hub_download
from scipy.io import wavfile

from style_bert_vits2.constants import Languages
from style_bert_vits2.nlp import bert_models
from style_bert_vits2.tts_model import TTSModel


VOICE_MODELS = {
    "narration": {
        "folder": "jvnv-F1-jp",
        "model": "jvnv-F1-jp_e160_s14000.safetensors",
        "name": "JVNV F1 JP-Extra",
    },
    "mio": {
        "folder": "jvnv-F2-jp",
        "model": "jvnv-F2_e166_s20000.safetensors",
        "name": "JVNV F2 JP-Extra",
    },
    "ren": {
        "folder": "jvnv-M1-jp",
        "model": "jvnv-M1-jp_e158_s14000.safetensors",
        "name": "JVNV M1 JP-Extra",
    },
    "reiji": {
        "folder": "jvnv-M2-jp",
        "model": "jvnv-M2-jp_e159_s17000.safetensors",
        "name": "JVNV M2 JP-Extra",
    },
}


PERFORMANCE = {
    "[calm]": ("Neutral", 0.85, 0.98),
    "[reflective]": ("Neutral", 1.00, 0.94),
    "[quietly]": ("Neutral", 0.80, 0.93),
    "[warmly]": ("Happy", 0.34, 1.02),
    "[softly]": ("Neutral", 0.82, 0.95),
    "[surprised]": ("Surprise", 0.48, 1.12),
    "[sad]": ("Sad", 0.52, 0.92),
    "[concerned]": ("Fear", 0.26, 1.00),
    "[controlled]": ("Neutral", 1.00, 0.96),
    "[firmly]": ("Angry", 0.25, 1.05),
    "[coldly]": ("Disgust", 0.24, 0.97),
    "[uneasy]": ("Fear", 0.34, 1.04),
    "[determined]": ("Angry", 0.22, 1.04),
    "[hopeful]": ("Happy", 0.33, 1.04),
    "[tenderly]": ("Happy", 0.24, 0.96),
}


def atomic_json(path: Path, payload: dict) -> None:
    temporary = path.with_name(f"{path.name}.{os.getpid()}.tmp")
    temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(path)


def voice_key(utterance: dict) -> str:
    override = str(utterance.get("styleBertVoiceKey") or "")
    if override in VOICE_MODELS:
        return override
    if utterance.get("speakerId") == "narration":
        return "narration"
    name = str(utterance.get("speakerName") or "")
    if "神谷" in name:
        return "reiji"
    if "澪" in name:
        return "mio"
    return "ren"


def apply_pronunciations(text: str, rules: list[dict]) -> str:
    spoken = text
    for rule in rules:
        source = str(rule.get("from") or "")
        replacement = str(rule.get("to") or "")
        if source and replacement:
            spoken = spoken.replace(source, replacement)
    return spoken


def download_voice_model(voice: dict) -> tuple[Path, Path, Path]:
    folder = voice["folder"]
    repo = "litagin/style_bert_vits2_jvnv"
    model_path = Path(hf_hub_download(repo, f"{folder}/{voice['model']}"))
    config_path = Path(hf_hub_download(repo, f"{folder}/config.json"))
    style_path = Path(hf_hub_download(repo, f"{folder}/style_vectors.npy"))
    return model_path, config_path, style_path


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("manifest")
    parser.add_argument("--device", choices=["cpu", "mps"], default="cpu")
    parser.add_argument("--utterance-ids", default="")
    args = parser.parse_args()

    manifest_path = Path(args.manifest).expanduser().resolve()
    project_dir = manifest_path.parents[3]
    canvas_dir = project_dir / "canvas"
    audio_dir = canvas_dir / "assets" / "audio" / "raw-v11-stylebert"
    alignment_dir = canvas_dir / "audio-alignments"
    requested_ids = {value.strip() for value in args.utterance_ids.split(",") if value.strip()}
    report_path = manifest_path.with_name(
        "v11-stylebert-correction-report.json" if requested_ids else "v11-stylebert-generation-report.json"
    )
    audio_dir.mkdir(parents=True, exist_ok=True)
    alignment_dir.mkdir(parents=True, exist_ok=True)

    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    pronunciation_rules = manifest.get("speech", {}).get("pronunciations", [])

    print(json.dumps({"stage": "load-japanese-bert", "device": args.device}), flush=True)
    # The current Hugging Face checkpoint is stored in FP16. Style-Bert-VITS2's
    # JP-Extra projection weights are FP32, so make the interface dtype
    # explicit on both CPU and Apple MPS instead of relying on transformers'
    # version-dependent auto dtype.
    bert_model = bert_models.load_model(
        Languages.JP,
        "ku-nlp/deberta-v2-large-japanese-char-wwm",
    )
    bert_model.float()
    bert_models.load_tokenizer(Languages.JP, "ku-nlp/deberta-v2-large-japanese-char-wwm")

    utterances_by_voice: dict[str, list[dict]] = {key: [] for key in VOICE_MODELS}
    for utterance in manifest.get("utterances", []):
        if requested_ids and utterance.get("id") not in requested_ids:
            continue
        utterances_by_voice[voice_key(utterance)].append(utterance)

    rows: list[dict] = []
    for key, utterances in utterances_by_voice.items():
        if not utterances:
            continue
        voice = VOICE_MODELS[key]
        print(json.dumps({"stage": "load-voice", "voice": key, "name": voice["name"]}), flush=True)
        model_path, config_path, style_path = download_voice_model(voice)
        model = TTSModel(
            model_path=model_path,
            config_path=config_path,
            style_vec_path=style_path,
            device=args.device,
        )
        for utterance in utterances:
            started_at = time.time()
            text = str(utterance.get("text") or "").strip()
            speech_text = str(utterance.get("speechOverride") or "").strip()
            if not speech_text:
                speech_text = apply_pronunciations(text, pronunciation_rules)
            prompt = str(utterance.get("performancePrompt") or "[calm]")
            style, style_weight, intonation_scale = PERFORMANCE.get(prompt, PERFORMANCE["[calm]"])
            tuning = utterance.get("speechTuning") or {}
            effective_intonation_scale = float(tuning.get("intonationScale", intonation_scale))
            seed_salt = str(tuning.get("seedSalt") or "base")
            seed = int(hashlib.sha256(f"v11:{utterance['id']}:{seed_salt}".encode()).hexdigest()[:8], 16)
            np.random.seed(seed)
            torch.manual_seed(seed)
            pitch_scale = 1.0
            if utterance.get("speakerName") == "少女の澪":
                pitch_scale = 1.035
            elif utterance.get("speakerName") == "少年の蓮":
                pitch_scale = 1.025
            default_length = 1.07 if key == "narration" else 1.04 if key == "reiji" else 1.05
            length = float(tuning.get("length", default_length))
            sample_rate, audio = model.infer(
                text=speech_text,
                language=Languages.JP,
                speaker_id=0,
                sdp_ratio=float(tuning.get("sdpRatio", 0.22)),
                noise=float(tuning.get("noise", 0.55)),
                noise_w=float(tuning.get("noiseW", 0.75)),
                length=length,
                line_split=False,
                style=style,
                style_weight=style_weight,
                pitch_scale=pitch_scale,
                intonation_scale=effective_intonation_scale,
            )
            audio = np.asarray(audio)
            if audio.dtype.kind == "f":
                audio = np.clip(audio, -1.0, 1.0)
                pcm = (audio * 32767.0).astype(np.int16)
            else:
                pcm = audio.astype(np.int16)
            file_name = f"{manifest['id']}-{utterance['id']}-v11-stylebert-raw.wav"
            file_path = audio_dir / file_name
            wavfile.write(file_path, sample_rate, pcm)
            duration = len(pcm) / sample_rate
            input_hash = hashlib.sha256(json.dumps({
                "provider": "style-bert-vits2",
                "voice": voice["name"],
                "text": speech_text,
                "performancePrompt": prompt,
                "style": style,
                "styleWeight": style_weight,
                "intonationScale": effective_intonation_scale,
                "pitchScale": pitch_scale,
                "length": length,
                "speechTuning": tuning,
                "seed": seed,
                "seedSalt": seed_salt,
            }, ensure_ascii=False, sort_keys=True).encode()).hexdigest()
            sidecar_name = f"{file_name}.json"
            sidecar_path = alignment_dir / sidecar_name
            sidecar = {
                "version": 3,
                "inputHash": input_hash,
                "utteranceId": utterance["id"],
                "provider": "style-bert-vits2",
                "model": voice["folder"],
                "voiceId": voice["folder"],
                "voiceName": voice["name"],
                "text": text,
                "displayText": text,
                "speechText": speech_text,
                "providerText": speech_text,
                "performancePrompt": prompt,
                "style": style,
                "styleWeight": style_weight,
                "intonationScale": effective_intonation_scale,
                "pitchScale": pitch_scale,
                "durationSeconds": duration,
                "speechStartSeconds": 0,
                "speechEndSeconds": duration,
                "characterCount": len(speech_text),
                "characterCost": 0,
                "elapsedMs": round((time.time() - started_at) * 1000),
                "requestId": "",
                "outputFormat": f"pcm_s16le_{sample_rate}_mono",
                "alignment": {"characters": [], "characterStartTimesSeconds": [], "characterEndTimesSeconds": []},
                "rawAlignment": {"characters": [], "characterStartTimesSeconds": [], "characterEndTimesSeconds": []},
                "seed": seed,
                "seedSalt": seed_salt,
            }
            atomic_json(sidecar_path, sidecar)
            utterance["speechText"] = speech_text
            utterance["provider"] = "style-bert-vits2"
            utterance["model"] = voice["folder"]
            utterance["voiceId"] = voice["folder"]
            utterance["voiceName"] = voice["name"]
            utterance["audio"] = {
                **sidecar,
                "fileName": file_name,
                "filePath": str(file_path),
                "assetUrl": f"/excalidraw-assets/audio/raw-v11-stylebert/{file_name}",
                "alignmentFileName": sidecar_name,
                "alignmentPath": str(sidecar_path),
                "mimeType": "audio/wav",
            }
            utterance["timing"] = None
            row = {
                "utteranceId": utterance["id"],
                "speakerName": utterance.get("speakerName"),
                "voice": voice["name"],
                "style": style,
                "styleWeight": style_weight,
                "durationSeconds": round(duration, 4),
                "elapsedMs": sidecar["elapsedMs"],
                "filePath": str(file_path),
            }
            rows.append(row)
            print(json.dumps(row, ensure_ascii=False), flush=True)
        del model

    report = {
        "version": 1,
        "provider": "Style-Bert-VITS2 JP-Extra",
        "repository": "https://github.com/litagin02/Style-Bert-VITS2",
        "modelRepository": "https://huggingface.co/litagin/style_bert_vits2_jvnv",
        "device": args.device,
        "utteranceCount": len(rows),
        "requestedUtteranceIds": sorted(requested_ids),
        "voiceCount": len({row["voice"] for row in rows}),
        "rows": rows,
    }
    atomic_json(report_path, report)
    manifest["model"] = "style-bert-vits2-jp-extra"
    manifest.setdefault("speech", {}).setdefault("performancePromptPolicy", {})[
        "provider"
    ] = "style-bert-vits2-jp-extra-style-vectors"
    manifest["status"] = "speech-ready-v11-stylebert"
    manifest["outputs"] = {}
    manifest.setdefault("audioQuality", {})[
        "correctionReportPath" if requested_ids else "generationReportPath"
    ] = str(report_path)
    manifest["audioQuality"]["providerFallbackReason"] = "Stored ElevenLabs key is an unsupported legacy format; local Japanese OSS inference used."
    manifest["updatedAt"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    atomic_json(manifest_path, manifest)
    print(json.dumps({"reportPath": str(report_path), "utteranceCount": len(rows)}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
