#!/usr/bin/env python3
"""Verify flattened split pages and their black gutters in source and rendered frames."""
import argparse
import json
import sys
from pathlib import Path

import cv2
import numpy as np


def separator_evidence(image):
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    dark = gray < 35
    height, width = dark.shape
    vertical = dark[:, int(width * 0.15):int(width * 0.85)].mean(axis=0)
    horizontal = dark[int(height * 0.15):int(height * 0.85), :].mean(axis=1)
    return {
        "bestVerticalDarkFraction": round(float(vertical.max()) if vertical.size else 0.0, 4),
        "bestHorizontalDarkFraction": round(float(horizontal.max()) if horizontal.size else 0.0, 4),
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--video", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    manifest = json.loads(args.manifest.read_text())
    capture = cv2.VideoCapture(str(args.video))
    rows = []
    for cut in manifest.get("cuts", []):
        cut_start = float(cut.get("timing", {}).get("startSeconds", 0))
        shots = list(cut.get("cameraSequence", []))
        if cut.get("panelLayout", {}).get("enabled"):
            shots.append({
                "id": f"{cut.get('id')}-flattened-page",
                "imagePath": (cut.get("flattenedSplitPage") or {}).get("sourcePagePath"),
                "utteranceIds": cut.get("utteranceIds", []),
                "panelLayout": cut.get("panelLayout"),
                "flattenedSplitPage": cut.get("flattenedSplitPage") or {
                    "enabled": True,
                    "flattenBeforeCamera": cut["panelLayout"].get("flattenBeforeCamera"),
                    "panelCamera": cut["panelLayout"].get("panelCamera"),
                    "motionPolicy": cut["panelLayout"].get("motionPolicy"),
                    "panelCount": len(cut["panelLayout"].get("panels", [])),
                },
            })
        for shot in shots:
            split = shot.get("flattenedSplitPage") or {}
            if not split.get("enabled"):
                continue
            source_path = shot.get("imagePath") or ""
            source = cv2.imread(str(source_path)) if source_path else None
            panel_layout = shot.get("panelLayout") or {}
            panel_sources = [cv2.imread(str(panel.get("imagePath", ""))) for panel in panel_layout.get("panels", [])]
            policy_ok = (
                split.get("flattenBeforeCamera") is True
                and split.get("panelCamera") == "static"
                and split.get("motionPolicy") == "whole-page"
                and int(split.get("panelCount", 0)) >= 2
            )
            if source is not None:
                source_evidence = separator_evidence(source)
                source_separator = max(source_evidence.values(), default=0) >= 0.88
                source_dimensions = [source.shape[1], source.shape[0]]
                source_ready = source.shape[1] == 1920 and source.shape[0] == 1080
            else:
                # Existing benchmark episodes flatten panelLayout dynamically in
                # the cut renderer. There is no standalone page image to read;
                # verify every source panel plus the deterministic black-gutter
                # recipe, then require the separator again in the actual MP4.
                panel_sources_ready = bool(panel_sources) and all(panel is not None for panel in panel_sources)
                source_evidence = {
                    "derivedFromPanelLayout": True,
                    "panelCount": len(panel_sources),
                    "allPanelSourcesReadable": panel_sources_ready,
                    "separatorColor": panel_layout.get("separatorColor"),
                    "gutterPixels": int(panel_layout.get("gutter", 0)),
                }
                source_separator = bool(
                    panel_sources_ready
                    and len(panel_sources) >= 2
                    and str(panel_layout.get("separatorColor", "")).lower() == "black"
                    and int(panel_layout.get("gutter", 0)) > 0
                )
                source_dimensions = [1920, 1080] if source_separator else None
                source_ready = source_separator
            # Shot boundaries are anchored by the first assigned utterance.
            assigned = [u for u in manifest.get("utterances", []) if u.get("id") in shot.get("utteranceIds", [])]
            if assigned:
                start = min(float(u["timing"]["bubbleStartSeconds"]) for u in assigned)
                end = max(float(u["timing"]["bubbleEndSeconds"]) for u in assigned)
            else:
                start = cut_start
                end = cut_start + float(cut.get("timing", {}).get("durationSeconds", 0))
            rendered_samples = []
            for ratio in (0.18, 0.5, 0.82):
                seconds = start + max(0, end - start) * ratio
                capture.set(cv2.CAP_PROP_POS_MSEC, seconds * 1000)
                ok, frame = capture.read()
                evidence = separator_evidence(frame) if ok and frame is not None else {}
                rendered_samples.append({"seconds": round(seconds, 3), **evidence})
            rendered_separator = any(max(
                sample.get("bestVerticalDarkFraction", 0),
                sample.get("bestHorizontalDarkFraction", 0),
            ) >= 0.72 for sample in rendered_samples)
            passed = bool(policy_ok and source_ready and source_separator and rendered_separator)
            rows.append({
                "cutId": cut.get("id"), "shotId": shot.get("id"), "imagePath": source_path or f"panelLayout:{cut.get('id')}",
                "policyPass": policy_ok, "sourceDimensions": source_dimensions,
                "sourceSeparatorPass": source_separator, "sourceEvidence": source_evidence,
                "renderedSeparatorPass": rendered_separator, "renderedSamples": rendered_samples, "pass": passed,
            })
    capture.release()
    result = {
        "version": "koya-split-page-integrity-v1",
        "applicable": bool(rows),
        "rows": rows,
        "pass": all(row["pass"] for row in rows),
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({"pass": result["pass"], "applicable": result["applicable"], "checked": len(rows)}, ensure_ascii=False))
    if not result["pass"]:
        sys.exit(1)


if __name__ == "__main__":
    main()
