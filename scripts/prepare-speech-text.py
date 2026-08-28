#!/usr/bin/env python3
"""Speech-text preflight for Japanese TTS (ledger R194 phase 4).

Analyzes each line before generation and reports:
  - appliedText: reading-dictionary substitutions applied (longest-first)
  - flags: tokens likely to be misread — homographs with multiple common
    readings, numbers with counters, latin/alphanumeric runs, and kanji
    tokens the analyzer itself could not produce a reading for
  - moraCount / estimatedSeconds (at 6.5 mora/sec narration pace)

Input JSON: {"texts": [{"id": "...", "text": "..."}],
             "dictionary": "config/koya-reading-dictionary.json"}  // optional
Output: single-line JSON on stdout. Flags are advisories for the reading
dictionary loop, not hard failures; exit is 0 unless the input is invalid.
"""
import json
import re
import sys
import unicodedata
from pathlib import Path

# sokuon (っ/ッ) and chouon (ー) COUNT as moras; only combining small kana do not.
COMBINING_KANA = set("ゃゅょぁぃぅぇぉャュョァィゥェォ")

# Surfaces with more than one common reading where TTS engines regularly
# guess wrong. The right fix is a per-channel dictionary entry, so these are
# flagged rather than auto-rewritten.
HOMOGRAPHS = [
    "行った", "行って", "方", "他", "辛い", "大人気", "人気", "上手", "下手",
    "一日", "二日", "今日", "明日", "昨日", "一人", "二人", "何で", "何だ",
    "大事", "見物", "生物", "風車", "礼拝", "施行", "早急", "代替",
]


def fail(message):
    print(f"ERROR: {message}", file=sys.stderr)
    sys.exit(1)


def load_dictionary(path):
    if not path:
        return []
    try:
        raw = Path(path).read_text(encoding="utf-8")
    except FileNotFoundError:
        return []
    # A corrupt dictionary must stop the preflight, not silently become empty
    # (fail-closed, matching lib/readingDictionary.mjs).
    data = json.loads(raw)
    entries = [e for e in data.get("entries", []) if e.get("status") == "active"]
    return sorted(entries, key=lambda e: -len(e.get("from", "")))


def apply_dictionary(text, entries):
    applied = []
    for entry in entries:
        if entry["from"] in text:
            text = text.replace(entry["from"], entry["to"])
            applied.append(entry["from"])
    return text, applied


def mora_count(reading):
    return sum(1 for ch in reading
               if ("ァ" <= ch <= "ヺ" or "ぁ" <= ch <= "ゔ" or ch == "ー") and ch not in COMBINING_KANA)


def analyze(text, tagger):
    flags = []
    for surface in HOMOGRAPHS:
        if surface in text:
            flags.append({"surface": surface, "reason": "homograph",
                          "hint": "複数の読みがある語。誤読したら読み辞書へ登録"})
    for match in re.finditer(r"[0-9０-９]+(?:[年月日円個人回本枚台歳割%％]|時間?|分|秒)?", text):
        flags.append({"surface": match.group(0), "reason": "number",
                      "hint": "数字＋助数詞は読み揺れしやすい。重要なら読みを明記"})
    for match in re.finditer(r"[A-Za-zＡ-Ｚａ-ｚ]{2,}", text):
        flags.append({"surface": match.group(0), "reason": "latin",
                      "hint": "英字は読み（カタカナ）指定を推奨"})
    reading_parts = []
    for word in tagger(text):
        kana = getattr(word.feature, "kana", None)
        if kana:
            reading_parts.append(kana)
        else:
            reading_parts.append(word.surface)
            if re.search(r"[㐀-鿿]", word.surface):
                flags.append({"surface": word.surface, "reason": "unknown-reading",
                              "hint": "解析器が読みを出せない語。固有名詞なら読み辞書へ"})
    reading = unicodedata.normalize("NFKC", "".join(reading_parts))
    return flags, reading


def main():
    if len(sys.argv) != 2:
        fail("usage: prepare-speech-text.py <input.json>")
    config = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    texts = config.get("texts", [])
    if not texts:
        fail("input.texts must not be empty")
    entries = load_dictionary(config.get("dictionary", ""))
    try:
        from fugashi import Tagger
    except ImportError:
        fail("prepare-speech-text.py requires fugashi (pip install fugashi unidic-lite)")
    tagger = Tagger()
    rows = []
    for item in texts:
        text = unicodedata.normalize("NFKC", str(item.get("text", "")))
        applied_text, applied = apply_dictionary(text, entries)
        flags, reading = analyze(applied_text, tagger)
        moras = mora_count(reading)
        rows.append({
            "id": item.get("id", ""),
            "appliedText": applied_text,
            "dictionaryApplied": applied,
            "flags": flags,
            # A flag-free line's analyzer reading is trustworthy enough to act
            # as the confirmed expectedReading for the CER gate; flagged lines
            # need a human or dictionary confirmation first (anti-circularity).
            "expectedReading": reading if not flags else "",
            "readingConfirmed": not flags,
            "moraCount": moras,
            "estimatedSeconds": round(moras / 6.5, 2),
        })
    print(json.dumps({"rows": rows}, ensure_ascii=False))


if __name__ == "__main__":
    main()
