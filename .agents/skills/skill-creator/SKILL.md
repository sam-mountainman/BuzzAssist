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
- Claude Code のproject adapter（`.claude/skills`）は、正本を読むことだけを指示する薄い文書にする。
  Codex はリポジトリの `.agents/skills` を直接読むので adapter は要らない。今ある `.codex/skills` は
  同じ Skill を一覧に重複して出すだけで、リポジトリの docs/skill-inventory-profiles-ja.md の手順でまとめて外す予定。
  外すまでは正本参照だけに保つ。
- plugin cache、`~/.codex/skills/.system/`、ユーザーのglobal Skill、global plugin設定は変更しない。
- 配布は正本 → build/stage → 署名Release → host update の一方向。cacheから正本へ逆輸入しない。
- Channel Packの秘密、未公開台本、運営者固有の承認記録を共通Skillへ入れない。

## 作成・改訂の流れ

1. `node scripts/skill-inventory.mjs --profile buzzassist-development` で同名実装、由来、SHA差を先に確認する。
2. 既存の正本へ吸収できるかを調べる。1件の指摘ごとにSkillを増やさない。
3. Skillの目的、発火条件、対象外、必要な証拠を決める。一般的な能力説明は省き、BuzzAssist固有の判断だけを書く。
4. `.agents/skills` の正本を日本語で変更する。条件別の詳細だけを `references/` へ分ける。
5. `evals/evals.json` に現実的な正例と近接した負例を置き、観測可能な不変条件をテストする。
6. Claude Code の adapter（と、外すまでの `.codex/skills`）は正本への相対参照だけに保ち、手順を複製しない。
7. inventory manifestのsemver、言語、owner、由来、対応host、内容SHAを更新する。
   semver は「配った版・承認の付いた版から中身が変わったら上げる」。まだ配っていない（Release に載って
   いない・承認の付いていない）版がすでに上がっているなら、同じ版のまま内容SHAだけ更新する——承認は版と
   内容SHAの両方に束縛されるので、承認済みの版を同じ番号のまま中身だけ変えることはしない。
   `plugins[].version` はリリースの版上げで `package.json` と各 plugin manifest と同じ値にそろえる
   （inventory の検査が照合する）。
8. focused testとSkill validatorを実行し、`skill inventory` のcollisionとdivergent hashを確認する。
9. 学習の提案を正本へ反映するときは、`harness-learn` の差分の承認キュー（`pending` → `approve`）で当てる。
   エージェントも当ててよく、変更前後の sha256・元の提案・時刻・当てた者（エージェントか人か）が残り、
   1件ずつ `rollback` できる。開発用チェックアウトの制作は承認前の正本でも止まらず、RunReceipt の
   `skillApproval` に残る。
10. 人の承認は、運営者へ配る版（GitHub Release）を出すときの1回。変更の要約と評価結果を人へ渡し、
    承認者本人が自分の端末で `node scripts/skill-inventory.mjs --approve <id> --reviewer <名前> --human-verified`
    を打つ。エージェントは代わりに打たない。承認の無い版は配らない（`npm run skills:check:release` が止める）。

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
- 配る版では、評価結果と人間承認が版・内容SHAへ拘束されている（リリースの関門）。

機械が自分でreviewer名を入力した記録は人間承認ではない。エージェントが当てた正本の変更は
「エージェントが当てた」と記録され、配る版の人の承認とは別物として扱う（`harness-self-improvement`
と同じ）。承認前の正本で作った成果物は、その事実を RunReceipt の `skillApproval` に残したまま扱い、
承認済みとして報告しない。

