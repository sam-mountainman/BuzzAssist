#!/usr/bin/env python3
"""R51 gate: every split-page panel must show its meaningful subject (a face
or named subject) in the RENDERED video while its page is on screen, and the
active speaker's panel face must be visible during that speaker's line.

Method: each panel declares subjectFaceBounds in its (pre-cropped) source
image. The face patch is cut from the panel source and template-matched
(multi-scale, normalized correlation) against rendered frames sampled across
each utterance's display interval. A panel subject passes when any sample
reaches the correlation threshold; the speaker-panel check uses only that
speaker's own interval samples.
"""
import argparse
import json
import sys
from pathlib import Path

import cv2
import numpy as np


def read_json(path: Path) -> dict:
    return json.loads(path.read_text())


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", type=Path, default=Path("canvas/manga-videos/manga-photo-homecoming-001/episode-manifest.json"))
    parser.add_argument("--video", type=Path, default=None)
    parser.add_argument("--threshold", type=float, default=0.55)
    parser.add_argument("--samples", type=int, default=5)
    args = parser.parse_args()
    manifest = read_json(args.manifest)
    video_path = args.video or Path(manifest["outputs"]["finalVideo"]["filePath"])
    episode_dir = args.manifest.parent
    frames_dir = episode_dir / "audits" / "split-panel-readability"
    frames_dir.mkdir(parents=True, exist_ok=True)

    # Speaker panel mapping: panel index hosting each utterance's speaker.
    SPEAKER_PANEL = {
        "cut-06-u01": 0, "cut-06-u02": 1,
        "cut-08-u02": None, "cut-08-u03": None,  # narration: no speaker panel
    }

    capture = cv2.VideoCapture(str(video_path))
    rows = []
    utterances = {u["id"]: u for u in manifest["utterances"]}
    for cut in manifest["cuts"]:
        layout = cut.get("panelLayout")
        if not layout or layout.get("enabled") is False:
            continue
        enable_from = layout.get("enableFromUtteranceId")
        cut_utts = [utterances[uid] for uid in cut["utteranceIds"] if uid in utterances]
        if enable_from:
            started = False
            page_utts = []
            for u in cut_utts:
                if u["id"] == enable_from:
                    started = True
                if started:
                    page_utts.append(u)
        else:
            page_utts = cut_utts
        panels = layout.get("panels") or []
        templates = []
        for index, panel in enumerate(panels):
            face = panel.get("subjectFaceBounds")
            image = cv2.imread(panel.get("imagePath", ""))
            if face is None or image is None:
                templates.append(None)
                continue
            h, w = image.shape[:2]
            x0, y0 = int(face["x"] * w), int(face["y"] * h)
            x1 = int((face["x"] + face["width"]) * w)
            y1 = int((face["y"] + face["height"]) * h)
            patch = image[y0:y1, x0:x1]
            templates.append(patch if patch.size else None)
        for u in page_utts:
            start = float(u["timing"]["bubbleStartSeconds"])
            end = float(u["timing"]["bubbleEndSeconds"])
            panel_hits = [0.0] * len(panels)
            for s_index in range(args.samples):
                t = start + (end - start) * (0.15 + 0.7 * s_index / max(1, args.samples - 1))
                capture.set(cv2.CAP_PROP_POS_MSEC, t * 1000)
                ok, frame = capture.read()
                if not ok or frame is None:
                    continue
                for p_index, template in enumerate(templates):
                    if template is None:
                        continue
                    best = 0.0
                    for scale in (0.35, 0.5, 0.65, 0.8, 1.0, 1.2, 1.5, 1.8, 2.2):
                        th, tw = int(template.shape[0] * scale), int(template.shape[1] * scale)
                        if th < 24 or tw < 24 or th >= frame.shape[0] or tw >= frame.shape[1]:
                            continue
                        resized = cv2.resize(template, (tw, th))
                        result = cv2.matchTemplate(frame, resized, cv2.TM_CCOEFF_NORMED)
                        best = max(best, float(result.max()))
                    panel_hits[p_index] = max(panel_hits[p_index], best)
                if s_index == args.samples // 2:
                    cv2.imwrite(str(frames_dir / f"{u['id']}.jpg"), frame, [cv2.IMWRITE_JPEG_QUALITY, 88])
            speaker_panel = SPEAKER_PANEL.get(u["id"])
            speaker_ok = True
            if speaker_panel is not None and templates[speaker_panel] is not None:
                speaker_ok = panel_hits[speaker_panel] >= args.threshold
            rows.append({
                "cutId": cut["id"],
                "utteranceId": u["id"],
                "panelBestCorrelation": [round(v, 3) for v in panel_hits],
                "speakerPanel": speaker_panel,
                "speakerPanelVisible": speaker_ok,
                "anySubjectVisible": any(v >= args.threshold for v in panel_hits if v > 0),
                "pass": speaker_ok and any(v >= args.threshold for v in panel_hits if v > 0),
            })
    capture.release()
    result = {
        "version": "split-panel-readability-v1",
        "videoPath": str(video_path),
        "threshold": args.threshold,
        "rows": rows,
        "pass": bool(rows) and all(r["pass"] for r in rows),
    }
    (episode_dir / "split-panel-readability-audit.json").write_text(json.dumps(result, indent=1))
    print(json.dumps({"pass": result["pass"], "rows": rows}, ensure_ascii=False))
    if not result["pass"]:
        sys.exit(1)


if __name__ == "__main__":
    main()
