---
name: skill-creator
description: BuzzAssistのSkillを新規作成・改訂・棚卸し・配布するときの管理用正本。`.agents/skills`の正本、ホスト用アダプター、Skill manifest、評価、人間承認を一貫させる。通常の動画制作やCanvas操作では使わず、Skill自体を保守するときだけ使う。
---

# BuzzAssist Skill Creator

## 役割

これは `buzzassist:skill-creator` の日本語正本であり、Skillの管理・curation専用。
Operator Production の動画生成経路からは呼ばない。端末にある汎用
`skill-creator`、Codexのsystem Skill、plugin cacheは比較対象であって編集元ではない。

## 所有境界

- BuzzAssist共通正本は `.agents/skills/<name>/` に置く。
- Claude Code / Codexのproject adapterは、正本を読むことだけを指示する薄い文書にする。
- plugin cache、`~/.codex/skills/.system/`、ユーザーのglobal Skill、global plugin設定は変更しない。
- 配布は正本 → build/stage → 署名Release → host update の一方向。cacheから正本へ逆輸入しない。
- Channel Packの秘密、未公開台本、運営者固有の承認記録を共通Skillへ入れない。

## 作成・改訂の流れ

1. `node scripts/skill-inventory.mjs --profile buzzassist-development` で同名実装、由来、SHA差を先に確認する。
2. 既存の正本へ吸収できるかを調べる。1件の指摘ごとにSkillを増やさない。
3. Skillの目的、発火条件、対象外、必要な証拠を決める。一般的な能力説明は省き、BuzzAssist固有の判断だけを書く。
4. `.agents/skills` の正本を日本語で変更する。条件別の詳細だけを `references/` へ分ける。
5. `evals/evals.json` に現実的な正例と近接した負例を置き、観測可能な不変条件をテストする。
6. Claude/Codex adapterは正本への相対参照だけに保ち、手順を複製しない。
7. inventory manifestのsemver、言語、owner、由来、対応host、内容SHAを更新する。
8. focused testとSkill validatorを実行し、`skill inventory` のcollisionとdivergent hashを確認する。
9. 変更案と評価結果を人へ渡す。人間承認前にproduction-allowedへ昇格せず、正本反映済みとも数えない。

## プロファイル境界

- `operator-production`: 正式Harnessが宣言した本番Skillだけ。skill-creatorは不可。
- `buzzassist-development`: skill-creator、評価、独立監査、開発補助を利用可。
- `general-work`: Office、Finance、HR、Legal、Sales、Cowork系。動画制作経路から分離する。

HyperFrames / Remotion / Fable / Grok / RunPodは、正式Harness manifestの明示宣言なしに
Operator Productionへ入れない。`yt-analytics`、`yt-quality-loop`、Cowork系は
Operator Productionでは常に候補外にする。

## 合否

次を満たすまで配布可能としない。

- 正本の内容SHAがmanifestと一致する。
- project adapterが同じ正本を指し、独自手順を持たない。
- 同じ解決scopeの同名Skillに異なる実装が無い。
- Operator Productionで目的外Skillが暗黙選択されない。
- 評価結果と人間承認が版・差分SHAへ拘束されている。

機械が自分でreviewer名を入力した記録は人間承認ではない。`harness-self-improvement`
と同じく、未承認案は提案として残し、監査・合否の証拠には使わない。

