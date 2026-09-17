#!/usr/bin/env python3
"""
detect-composited-text.py

textRenderingPolicy (channel-packs/<channel>/config/<channel>-show-bible.json) の
detector を実行可能にしたもの。

判定の考え方
------------------------------------------------------------------
本編以外で文字が入る画像は、文字を含めてモデルに一発で描かせる決まりになった。
後乗せ合成かどうかは「同一構図の文字なし版」と「文字あり版」を画素比較すれば
機械的に分かる。合成は文字が乗った領域だけを書き換えるので、それ以外の画素は
バイト単位で完全に一致する。逆に本当に再生成した画像は、同じ指示でも
拡散過程が変わるためほぼ全画素が変わる。

  完全一致画素の割合 > 60%  → 後乗せ合成と判定して不合格
  完全一致画素の割合 <= 60% → 合格（再生成されている）

既知の不合格例（自己検証用）:
  canvas/channel-header-20260904-v3/selected/with-type/*-type-provisional-*.png
  を canvas/channel-header-20260904-v3/selected/banners/*.png と比べると
  6案すべて 91.43% で完全一致する。--self-test がこれを再現する。

使い方
------------------------------------------------------------------
  # 1組だけ
  python3 scripts/detect-composited-text.py \
      --text-image out/icon-a-with-text.png \
      --plain-image out/icon-a-no-text.png

  # ディレクトリ同士（stem の共通接頭辞で自動対応付け）
  python3 scripts/detect-composited-text.py \
      --text-dir out/with-type --plain-dir out/banners \
      --text-pattern=-with-text- \
      --json-out out/text-rendering-gate.json

  # --text-pattern の値が - で始まるときは = で繋ぐ（argparse がオプションと誤読するため）

  # 既知の不合格例で detector 自体を検証する
  python3 scripts/detect-composited-text.py --self-test

終了コード: 0=全件合格 / 1=不合格あり / 2=入力不正
出力: 標準出力に人が読む表、--json-out で機械可読な台帳。
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
import time
from typing import Dict, List, Optional, Tuple

import numpy as np
from PIL import Image

THRESHOLD = 0.60
POLICY_VERSION = "text-rendering-v1"
REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

SELF_TEST_TEXT_DIR = os.environ.get("COMPOSITE_SELFTEST_TEXT_DIR") or os.path.join(
    REPO_ROOT, "canvas/channel-header-20260904-v3/selected/with-type")
SELF_TEST_PLAIN_DIR = os.environ.get("COMPOSITE_SELFTEST_PLAIN_DIR") or os.path.join(
    REPO_ROOT, "canvas/channel-header-20260904-v3/selected/banners")
SELF_TEST_TEXT_PATTERN = "-type-provisional-"
SELF_TEST_EXPECTED_FRACTION = 0.9143
SELF_TEST_TOLERANCE = 0.0002


def sha256_prefix(path: str, n: int = 16) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()[:n]


def load_rgb(path: str) -> np.ndarray:
    """RGB で読む。アルファは合成判定のノイズになるので落とす（不透明部だけ比べる）。"""
    with Image.open(path) as im:
        if im.mode in ("RGBA", "LA", "P"):
            im = im.convert("RGBA")
            bg = Image.new("RGBA", im.size, (255, 255, 255, 255))
            im = Image.alpha_composite(bg, im).convert("RGB")
        else:
            im = im.convert("RGB")
        return np.asarray(im, dtype=np.uint8)


def compare(text_path: str, plain_path: str) -> Dict:
    a = load_rgb(text_path)
    b = load_rgb(plain_path)
    if a.shape != b.shape:
        return {
            "textImage": text_path,
            "plainImage": plain_path,
            "error": f"size mismatch {a.shape} vs {b.shape}",
            "verdict": "ERROR",
        }
    # 「完全一致画素」= RGB 3成分すべてが等しい画素
    identical = np.all(a == b, axis=-1)
    total = int(identical.size)
    same = int(identical.sum())
    fraction = same / total if total else 0.0

    # 参考値: 差分がどこに集中しているか（合成なら文字の外接矩形に収まる）
    diff_rows = np.where(~identical.all(axis=1))[0] if total else np.array([])
    diff_cols = np.where(~identical.all(axis=0))[0] if total else np.array([])
    if diff_rows.size and diff_cols.size:
        bbox = [int(diff_cols[0]), int(diff_rows[0]),
                int(diff_cols[-1]), int(diff_rows[-1])]
        bbox_area = (bbox[2] - bbox[0] + 1) * (bbox[3] - bbox[1] + 1)
        bbox_share = bbox_area / total
    else:
        bbox = None
        bbox_share = 0.0

    composited = fraction > THRESHOLD
    return {
        "textImage": os.path.relpath(text_path, REPO_ROOT),
        "plainImage": os.path.relpath(plain_path, REPO_ROOT),
        "textImageSha256Prefix": sha256_prefix(text_path),
        "plainImageSha256Prefix": sha256_prefix(plain_path),
        "width": int(a.shape[1]),
        "height": int(a.shape[0]),
        "totalPixels": total,
        "identicalPixels": same,
        "identicalPixelFraction": round(fraction, 6),
        "identicalPixelPercent": round(fraction * 100, 2),
        "changedRegionBBox": bbox,
        "changedRegionBBoxShare": round(bbox_share, 6),
        "threshold": THRESHOLD,
        "verdict": "FAIL_COMPOSITED" if composited else "PASS_REGENERATED",
    }


def stem_key(name: str) -> str:
    """ファイル名から対応付け用のキーを作る。

    header-a3-storefront-daylight-type-provisional-2560x1440.png
    header-a3-storefront-daylight-2560x1440.png
    のどちらも 'header-a3' を返す。オプション記号（英字+数字）を拾う。
    """
    base = os.path.splitext(os.path.basename(name))[0]
    m = re.match(r"^([a-z0-9]+-[a-z]\d+)", base)
    if m:
        return m.group(1)
    # フォールバック: 数値・既知サフィックスを剥がした語の並び
    parts = [p for p in base.split("-")
             if not re.fullmatch(r"\d+x\d+|\d+", p)
             and p not in ("type", "provisional", "reserved", "withtext", "text")]
    return "-".join(parts)


def collect(dirpath: str, pattern: Optional[str]) -> List[str]:
    if not os.path.isdir(dirpath):
        raise SystemExit(f"[入力不正] ディレクトリがない: {dirpath}")
    out = []
    for name in sorted(os.listdir(dirpath)):
        if not name.lower().endswith((".png", ".jpg", ".jpeg", ".webp")):
            continue
        if pattern and pattern not in name:
            continue
        out.append(os.path.join(dirpath, name))
    return out


def pair_dirs(text_dir: str, plain_dir: str,
              text_pattern: Optional[str],
              plain_pattern: Optional[str]) -> List[Tuple[str, str]]:
    text_files = collect(text_dir, text_pattern)
    plain_files = collect(plain_dir, plain_pattern)
    plain_by_key: Dict[str, str] = {}
    for p in plain_files:
        plain_by_key.setdefault(stem_key(p), p)
    pairs = []
    unmatched = []
    for t in text_files:
        k = stem_key(t)
        if k in plain_by_key:
            pairs.append((t, plain_by_key[k]))
        else:
            unmatched.append(t)
    if unmatched:
        for u in unmatched:
            print(f"[対応なし] {os.path.basename(u)} に対応する文字なし版が見つからない",
                  file=sys.stderr)
    return pairs


def run(pairs: List[Tuple[str, str]], label: str) -> Dict:
    results = [compare(t, p) for t, p in pairs]
    failed = [r for r in results if r["verdict"] != "PASS_REGENERATED"]
    return {
        "tool": "detect-composited-text.py",
        "policy": POLICY_VERSION,
        "policySource": "channel-packs/<channel>/config/<channel>-show-bible.json#textRenderingPolicy",
        "label": label,
        "ranAt": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "threshold": THRESHOLD,
        "pairsChecked": len(results),
        "failures": len(failed),
        "gate": "PASS" if not failed else "FAIL",
        "results": results,
    }


def print_table(report: Dict) -> None:
    print(f"\ntextRenderingPolicy detector — {report['label']}")
    print(f"  しきい値: 完全一致画素 > {int(THRESHOLD*100)}% で不合格")
    print(f"  {'一致率':>8}  {'判定':<18}  対象")
    for r in report["results"]:
        if r["verdict"] == "ERROR":
            print(f"  {'   -':>8}  {'ERROR':<18}  {r['textImage']}  ({r['error']})")
            continue
        mark = "NG 後乗せ合成" if r["verdict"] == "FAIL_COMPOSITED" else "OK 再生成"
        print(f"  {r['identicalPixelPercent']:>7.2f}%  {mark:<18}  "
              f"{os.path.basename(r['textImage'])}")
    print(f"  → {report['pairsChecked']}件中 {report['failures']}件が不合格 "
          f"/ gate={report['gate']}\n")


def self_test() -> int:
    pairs = pair_dirs(SELF_TEST_TEXT_DIR, SELF_TEST_PLAIN_DIR,
                      SELF_TEST_TEXT_PATTERN, None)
    if not pairs:
        print("[自己検証 失敗] 既知の不合格例が見つからない", file=sys.stderr)
        return 2
    report = run(pairs, "self-test / 既知の後乗せ合成6案（2026-09-04 ヘッダー）")
    print_table(report)
    ok = True
    for r in report["results"]:
        if r["verdict"] != "FAIL_COMPOSITED":
            print(f"[自己検証 失敗] {r['textImage']} が不合格にならなかった", file=sys.stderr)
            ok = False
            continue
        delta = abs(r["identicalPixelFraction"] - SELF_TEST_EXPECTED_FRACTION)
        if delta > SELF_TEST_TOLERANCE:
            print(f"[自己検証 失敗] {r['textImage']} 期待 "
                  f"{SELF_TEST_EXPECTED_FRACTION:.4f} 実測 "
                  f"{r['identicalPixelFraction']:.4f}", file=sys.stderr)
            ok = False
    if ok:
        print(f"[自己検証 合格] 6案すべてを後乗せ合成として検出し、"
              f"一致率が既知値 {SELF_TEST_EXPECTED_FRACTION*100:.2f}% を再現した。")
        return 0
    return 1


def main() -> int:
    ap = argparse.ArgumentParser(
        description="文字あり版と文字なし版の完全一致画素率を測り、後乗せ合成を落とす")
    ap.add_argument("--text-image")
    ap.add_argument("--plain-image")
    ap.add_argument("--text-dir")
    ap.add_argument("--plain-dir")
    ap.add_argument("--text-pattern", default=None,
                    help="文字あり版のファイル名に含まれる語。"
                         "値が - で始まるときは --text-pattern=-type-provisional- と書く")
    ap.add_argument("--plain-pattern", default=None)
    ap.add_argument("--json-out")
    ap.add_argument("--label", default="ad-hoc")
    ap.add_argument("--self-test", action="store_true",
                    help="既知の不合格例で detector 自体を検証する")
    args = ap.parse_args()

    if args.self_test:
        return self_test()

    if args.text_image and args.plain_image:
        pairs = [(args.text_image, args.plain_image)]
    elif args.text_dir and args.plain_dir:
        pairs = pair_dirs(args.text_dir, args.plain_dir,
                          args.text_pattern, args.plain_pattern)
    else:
        ap.error("--text-image/--plain-image か --text-dir/--plain-dir を指定する")
        return 2

    if not pairs:
        print("[入力不正] 比較対象が0件", file=sys.stderr)
        return 2

    report = run(pairs, args.label)
    print_table(report)
    if args.json_out:
        os.makedirs(os.path.dirname(os.path.abspath(args.json_out)), exist_ok=True)
        with open(args.json_out, "w", encoding="utf-8") as fh:
            json.dump(report, fh, ensure_ascii=False, indent=2)
        print(f"  台帳: {args.json_out}")
    return 0 if report["gate"] == "PASS" else 1


if __name__ == "__main__":
    sys.exit(main())
