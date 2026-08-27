# WD14 tagger (attribute gate用MLモデル)

`scripts/audit-koya-candidate-attributes.py` の `wd14Tags` チェックが使う。
モデル本体はサイズのためgit管理外。以下で取得し、SHA-256を必ず照合する。

```bash
curl -L -o models/wd14/model.onnx \
  "https://huggingface.co/SmilingWolf/wd-swinv2-tagger-v3/resolve/main/model.onnx"
curl -L -o models/wd14/selected_tags.csv \
  "https://huggingface.co/SmilingWolf/wd-swinv2-tagger-v3/resolve/main/selected_tags.csv"
shasum -a 256 models/wd14/model.onnx models/wd14/selected_tags.csv
```

- 一次資料: <https://huggingface.co/SmilingWolf/wd-swinv2-tagger-v3>
- model.onnx SHA-256: `e6774bff34d43bd49f75a47db4ef217dce701c9847b546523eb85ff6dbba1db1`
- selected_tags.csv SHA-256: `298633d94d0031d2081c0893f29c82eab7f0df00b08483ba8f29d1e979441217`
- ランタイム: `pip3 install onnxruntime`（1.19系で動作確認）。推論はローカルCPUのみ、外部送信なし。
- ライセンス: 配布ページの表記を利用前に確認すること（2026-08-28時点でリポジトリに明示ライセンスファイルなし。ローカルQA利用に留め、モデルの再配布はしない）。

## 2026-08-28 実資産での校正値

- 八重歯（顔ズーム領域 `[0.55,0.05,0.42,0.60]` 指定時）: あり0.43〜0.86 / なし0.0002 → `requireTags {"fang": 0.2}`
- ネックレス（全身シート）: あり0.79〜0.81 / なし0.001〜0.1 → `forbidTags {"necklace": 0.3, "jewelry": 0.3}`。
  決定論ゲートで検出不可だった明色ジャージ地でも分離できる
- hair_over_one_eye: 0.87〜0.93（タグ名はアンダースコア形式）
- 既知の限界: 細いチョーカー（髪に隠れる場合）は0.001前後で検出不可。目の左右（どちらの目か）は判定不可 — 幾何チェックと人間判定を維持（台帳R187）
