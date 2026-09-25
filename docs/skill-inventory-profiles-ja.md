# Skill / Plugin Inventory と実行Profile

## 正本

- Skill/Plugin metadata: `.agents/skills/inventory.manifest.json`
- Profile policy: `.agents/skills/profiles.manifest.json`
- Inventory実装: `lib/skillInventory.mjs`
- CLI: `node scripts/skill-inventory.mjs`

inventoryはすべてのrecordへ次の4区分を明示する。

| 区分 | 意味 |
|---|---|
| `installed` | 端末のglobal/system/plugin cache、および `~/plugins/buzzassist/plugin` の配布コピーで実測した導入物 |
| `bundled` | BuzzAssist releaseに同梱するsource（このリポジトリの `.agents/skills` / `skills`） |
| `productionAllowed` | 正式Harnessが宣言した場合に本番候補になれる |
| `developmentOnly` | Skill管理・評価・benchmark等に限定 |

`installed` と `productionAllowed` は別物。端末に見えているだけのSkillを正式Harnessが
暗黙利用してはいけない。逆も同じで、**端末全体に導入されているplugin（Cowork、Vercel、
yt-analytics 等）は運営者ハーネスの同梱物ではない**。同梱物は `bundled: true` の30件だけで、
それ以外の `installed` はread-onlyの観測対象。

## Scopeと競合

同じfrontmatter名でもscopeを分ける。

- `buzzassist:<name>`: BuzzAssist正本またはplugin source
- `codex-system:<name>`: Codex内蔵。read-onlyの比較対象
- `user-global:<name>`: ユーザーglobal install
- `<plugin>:<name>`: plugin cache由来（`~/.codex/plugins/cache`、`~/.claude/plugins/cache`）
  および配布元 `~/plugins/buzzassist/plugin/skills`（`sourceRole: shipped-plugin-source`）

project adapterは実装ではなく `sourceRole: project-adapter` として正本へ結び付ける。
adapter本文のhashが正本と違うことはcollisionではない。正本参照が切れている、同じ
qualified IDに異なる実装hashがある、manifest SHAと実ファイルが違う場合は失敗。
別scopeの同名は `crossScopeSameNames`、global mirrorの内容差は
`externalDivergentHashes` として分離し、BuzzAssist正本の0-collisionを偽らない。端末側の
導入状態は `staleInstalledCopies`（存在するが違う）と `missingInstalledCopies`（無い）に分け、
`hostSyncOk` でまとめて判定する。

### 配布コピーの想定内の差

`setup-agents` は正本 `.agents/skills/<name>/` を配布物の `skills/<name>/` へ1階層浅く
コピーし、本文中の `../../../` を `../../` に書き換える（`harness-doctor` の
shipped-skill-drift も同じ正規化で比較する）。inventoryは正本側から配布形ハッシュ
（`shippedContentSha256`）を計算し、この書き換えだけの差は `exactMirrors` の
`depthRewriteEquivalents` として同一視する。これをcollisionと呼ばない。

正本同士（`project-canonical` と `plugin-runtime-source`）は一致しているのに、端末側の
cacheや配布コピーだけが違う場合は `staleInstalledCopies` に分ける。これは正本の欠陥では
なく「配布し直していない」状態で、対処は
`node scripts/setup-agents.mjs --agent <host> --project-dir <dir> --no-launch` の再実行
（host設定を書き換えるので、運営者が意図して実行する）。`--fail-on-external-divergence`
はこの区分も失敗として扱う。

### 端末側に Skill そのものが無い場合（missingInstalledCopies）

hash差は「存在するが古い」であり、**同梱 Skill が host cache にそもそも無い**状態は
別区分 `missingInstalledCopies` で報告する。host はその Skill を一切読み込めないので、
「両 host が同じ正本 Skill を使う」要件は hash が揃っていても満たされない。

- 同梱一覧 = `bundled: true` かつ `.agents/skills/<name>/` または `skills/<name>/` にある
  record（`setup-agents` が配布物 `skills/` へコピーするのはこの2系統。`.claude/skills` の
  host adapter は配布物に入らないので比較しない）
- 導入物（installation）= host cache の `<cache>/<ns>/<ns>/<semver>/` と、配布元
  `~/plugins/buzzassist/plugin/skills`。record の `installation.root / host / version` で束ねる
- 同梱 plugin と**同じ版**の導入物（または版が読めない導入物）で欠けているものだけを
  `missingInstalledCopies` に入れる。古い版の cache（例: 0.1.23 / 0.1.24 の残存）は新しい
  Skill を持たないのが当然なので `outdatedInstalledVersions` に分けて残存を見えるようにする
- `analysis.ok` は正本の整合だけを見る（従来どおり）。端末側の導入状態は
  `analysis.hostSyncOk`（stale 0 かつ missing 0）で判定し、
  `--fail-on-external-divergence` は missing でも exit 3 にする

対処は stale と同じで `setup-agents` の再実行（Claude Code 側は plugin update まで行う）。
`harness-doctor` の shipped-skill-drift は `~/plugins/buzzassist/plugin/skills` だけを見て
host cache を見ないため、この欠落は inventory の `--include-plugin-cache` でしか見えない。

## 3つのProfile

### Operator Production

Canvas、Browser、platform craft、feedback captureをbaseにし、正式Harness/生成Skillは
Harness manifestで宣言されたものだけ許可する。

- `yt-analytics` / `yt-quality-loop`: hard deny
- Cowork、Office、Finance、HR、Legal、Sales: hard deny
- HyperFrames / Remotion / Fable / Grok / RunPod: manifestの明示宣言がある場合だけ許可
- `buzzassist:skill-creator`: 本番hot pathでは不許可。**削除対象ではない**——`developmentOnly`
  として同梱し続け、Skillの作成・承認済み更新・棚卸しに使う（下記 Skill Creator）

### BuzzAssist Development

Operatorの機能に `buzzassist:skill-creator`、Best-of-N、独立監査、engineeringを加える。
正本変更は評価を通す。エージェントも正本を直してよいが、変更前後の sha256・元の提案・時刻・
誰が当てたかを残し、1件ずつ巻き戻せる形にする（`harness-learn` の `pending` → `approve` / `rollback`）。
人の承認は、運営者へ配る版（GitHub Release）を出すときの1回（`npm run skills:check:release` と、
承認者本人の端末の `skill-inventory --approve`）。開発用チェックアウトの制作は承認前の正本でも止めず、
Job と RunReceipt の `skillApproval` に残す。配布された写しでは今までどおり未承認なら止める。
Operatorの動画生成hot pathへ管理権限を持ち込まない。

### General Work

Office、Finance、HR、Legal、Sales、Cowork系を置く。正式動画Harnessとは分離する。

## コマンド

project sourceだけを検査:

```bash
node scripts/skill-inventory.mjs --profile operator-production \
  --declared-skill buzzassist:manga-video-production \
  --declared-skill buzzassist:manga-page-camera
```

端末global Skillもread-onlyで比較:

```bash
node scripts/skill-inventory.mjs --include-global --profile buzzassist-development
```

plugin cacheを含める場合だけ `--include-plugin-cache` を追加する。CLIはglobal設定やcacheを
書き換えない。JSONを機械連携へ渡すときは `--json` を使う。

## 評価（evals）を両ホストで流す

件数を数えるだけの試験では「Claude Code と Codex で同じ品質か」は分からない。
`scripts/skill-evals.mjs`（本体 `lib/skillEvals.mjs`）は正本スキルの `evals/evals.json` を
両ホストで実際に流し、別の新しい文脈の採点者が確認項目を1つずつ判定する。

```bash
npm run skills:evals                         # 計画だけ（既定。モデルは呼ばない）
node scripts/skill-evals.mjs run --execute \
  --skill buzzassist:skill-creator --eval 3 \
  --claude-model <id> --codex-model <id>     # 実行（両ホストの利用枠を使う）
node scripts/skill-evals.mjs report          # 版ごと・ホストごとの合格率
```

- **実行者**: `claude -p`（`--safe-mode --restricted --disable-slash-commands --strict-mcp-config
  --no-session-persistence`、道具は `Read,Glob,Grep` だけ、出力は `stream-json`）と
  `codex exec`（`--sandbox read-only --ephemeral --ignore-user-config --ignore-rules`、
  `--disable plugins/multi_agent/hooks`、`--json`）。作業ディレクトリは一時ディレクトリへ写した
  正本スキルで、`evals/` は写さない。写しが書き換わった出力は採点しない
- **採点者**: 既定は相手側のホスト（Claude の出力は Codex、Codex の出力は Claude）。
  新しい文脈（Claude は道具なし、Codex は空のディレクトリで読み取り専用）で、渡すのは依頼・
  読んだファイル・応答・確認項目だけ。合格点・前回の結果・
  実行者のホスト名とモデル名は渡さない。`shouldTrigger` は採点者に任せず、SKILL.md を読んだかを
  作業の記録から機械で決める
- **記録**: `BUZZASSIST_LEARNING_DIR/evals`、開発用チェックアウトなら `docs/learning/evals/`、
  それ以外は `~/.buzzassist/learning/evals/` に、1回の eval 実行ごと1行（JSONL）。スキル ID・版・
  contentSha256・ホスト・モデル・eval ID・各確認項目の passed/evidence・所要時間を残す。
  evidence から一時ディレクトリ・端末のパス・鍵らしい文字列は消す
- **並列**: 既定 `auto`（claude は `min(10, max(2, コア-2))`、codex は 8）。
  `harness-parallel-execution` の観測値16を超える `--concurrency` は受けない。
  利用枠・認証で落ちたホストへは残りを投げない
- **モデル**: 未指定だと claude はアカウントの既定、codex は CLI の既定（`config.toml` は読まない）。
  ホスト間で比べるときは両方のモデルを明示する

`npm run skills:check:release`（`--require-approval`）は、承認しようとしている版
（manifest の版と `contentSha256`）について、本番の正本スキルごとに両ホストの結果がそろっているか、
片方のホストだけ落ちた eval が無いかを**警告として**出す。止めるかどうかは運営者が決めるので、
`--require-evals` を付けたときだけ exit 5 で止める。別の SHA の結果は数えない。

## Skill Creator

BuzzAssist版の正本は `.agents/skills/skill-creator/SKILL.md`。plugin配布時は
`buzzassist:skill-creator` になり、project上では衝突回避のため
`buzzassist-skill-creator` という薄いadapter（`.claude/skills` と、共有の
`.agents/skills/buzzassist-skill-creator`）から正本へ到達する。2つとも
`inventory.manifest.json` の `adapters` に登録し、正本参照が切れたら検査で落ちる。
Codex 用の `.codex/skills` の adapter は 2026-09-26 に外した（下の「`.codex/skills` を外した」）。
Codex system Skill、global Skill、Cowork版、plugin cacheは編集しない。

**制作中の依存**と**Skill改善用の機能**は別物として扱う。

| 区分 | 何か | Profile |
|---|---|---|
| 制作中の依存 | platform-craft、harness-*、manga-*、narrated-story-video、excalidraw-*（生成系） | Operator Production で base または Harness宣言により許可 |
| Skill改善用の機能 | `buzzassist:skill-creator`、`excalidraw-benchmark-manga-style`、Best-of-N、独立監査 | BuzzAssist Development のみ。Operator の hot path には出さない |

skill-creator は「不要だから外す」のではなく「本番動画Jobから隔離する」。正本を更新する
ときは skill-creator、eval、inventoryのversion/content SHA、adapter検査（Claude Code の `.claude/skills` と
共有の adapter）をまとめて行う。


## 同名 Skill の棚卸し（2026-09-25）

外部レビューで「`skill-creator` が複数系統あって衝突している」「`.codex/skills` のアダプターは
本当に要るのか」と指摘された。`node scripts/skill-inventory.mjs --include-global --include-plugin-cache`
（読むだけ）と、ホストが実際に何を一覧に出すかの実測、Codex の公式仕様とソースで確かめた。

### 各ホストが Skill を読む場所

| ホスト | リポジトリ内 | 端末全体 | 根拠 |
|---|---|---|---|
| Claude Code | `.claude/skills` | `~/.claude/skills`、plugin cache | `.agents/skills` は読まない |
| Codex | `.agents/skills`（作業フォルダーからリポジトリの根まで）**と** `.codex/skills` | `~/.agents/skills`、`~/.codex/skills`（旧来の置き場所。互換のため今も読む）、`~/.codex/skills/.system`、plugin cache | 公式文書は `.agents/skills` と `~/.agents/skills` だけを挙げる。ソース（codex-rs の skill root 解決）は、`.codex/` がある信頼済みプロジェクトの `.codex/skills` と `$CODEX_HOME/skills` も読む |

Codex は同じ `name` の Skill を統合しない（公式文書: 同名は両方が一覧に出る）。重複を取り除くのは
**実体の path が同じとき**（symlink の行き先が同じとき）だけ。

実測（Codex 0.144.1 の app-server に `skills/list` を1回聞いた。モデルは呼ばない）:

- このリポジトリの BuzzAssist Skill 7件は、それぞれ **3回** 出た（`.agents/skills` の正本・`.codex/skills` の
  アダプター・plugin cache）
- 端末全体では `~/.codex/skills`（中身は `~/.claude/skills` への symlink）と `~/.agents/skills`（別の実体）の
  両方にある Skill が **2回ずつ** 出た（30件前後）。`skill-creator` は Codex 内蔵と合わせて3回

### `skill-creator` の系統

| 系統 | 置き場所 | ホストでの名前 | 扱い |
|---|---|---|---|
| BuzzAssist 正本 | `.agents/skills/skill-creator` | `buzzassist:skill-creator`（plugin として。Codex はリポジトリ内でも同じ名前空間で出す） | BuzzAssist Skill の管理・curation 用。`developmentOnly` |
| BuzzAssist のアダプター | `.claude/skills` / `.agents/skills` の `buzzassist-skill-creator`（`.codex/skills` の分は 2026-09-26 に外した） | `buzzassist-skill-creator` | 正本へ案内するだけ |
| Anthropic の汎用版 | `~/.claude/skills`、Claude の plugin（anthropic-skills）、Cowork の同期コピー | `skill-creator` / `anthropic-skills:skill-creator` | 汎用。BuzzAssist は編集しない |
| Codex 内蔵版 | `~/.codex/skills/.system/skill-creator` | `skill-creator` | 汎用。変更しない |
| 端末全体の写し | `~/.agents/skills/skill-creator` | `skill-creator` | Anthropic 版を「Claude→Codex」で機械置換した写しで、`Codex -p`・`Codex.ai` のような存在しない記述が入っている |

結論:

- **BuzzAssist の正本は衝突していない。** plugin では `buzzassist:` の名前空間が付き、汎用の
  `skill-creator` と区別できる。名前の変更は要らない
- 衝突しているのは端末全体の汎用 `skill-creator`（Anthropic 版・Codex 内蔵版・機械置換の写し）同士で、
  BuzzAssist の配布物の外にある。直し方は端末側の整理（Codex では `~/.agents/skills` を1つの正本にし、
  `~/.codex/skills` 側の同名を消す）で、BuzzAssist のコードでは直さない
- **`.codex/skills` のアダプターは、Codex が正本へ届くためには要らない。** Codex はリポジトリの
  `.agents/skills` を直接読む。アダプターがあると、同じ Skill が一覧に2回（plugin を入れた開発機では3回）
  出るだけになる（2026-09-26 に外した）。`.claude/skills` のアダプターは要る（Claude Code は `.agents/skills` を読まない）
- inventory の「project collisions 0」は実装の同一性（正本が1つ）を数えたもので、ホストの一覧に
  同じ名前が何回出るかは数えていない。上の重複は `crossScopeSameNames` にも出ない

### `.codex/skills` を外した（2026-09-26 運営者決定）

2026-09-25 の提案の手順で外した。Claude Code は `.agents/skills` を読まないので、`.claude/skills` のアダプターは残す。

1. `.codex/skills` の7件（と `agents/openai.yaml` の写し）を消し、`.agents/skills/inventory.manifest.json` の各 Skill の
   `adapters` から `.codex/skills/...` を外した。`.gitignore` は `.codex/` を丸ごと無視に戻し、`package.json` の
   `files` から `.codex/skills/` を外した（`setup-agents` の配布物はもともと `.codex` を写していない）。
   manifest と正本スキルの版は 0.1.28 のために上げてあってまだ配っていない・承認も付いていないので、
   skill-creator の決まりどおり同じ版のまま内容 SHA だけ更新した。人の承認は配る版を出すときの1回
   （承認者本人の端末の `skill-inventory --approve`）
2. 開発用チェックアウトの判定（`lib/hostSkillSync.mjs` の `readsCanonicalDirectly`）を
   `.git`・`.claude/skills`・`.agents/skills` の3つに変えた。学習の置き場（`lib/harnessLearningState.mjs`）、
   制作の承認の扱い（`lib/videoHarnessProductionProfile.mjs`）、doctor の host-skill-sync、skill evals の置き場が
   この判定を使う。配布された写しは `.git` を持たない（`setup-agents` の写しは `.agents` を含むが `.git` も
   `.claude` も含まない。npm の tarball も `.git` を含まない）ので、配布された写しの判定は変わらない。
   古いチェックアウトに `.codex/skills` が残っていても判定には使わない
3. アダプターの存在を前提にした試験（`test/koyaHostSkills.test.mjs`・`test/skillInventory.test.mjs` など）と、
   合成の開発用チェックアウトの印を直した。`.codex/skills` のアダプターが在庫やリポジトリへ戻れば試験が落ちる
4. 正本の `skill-creator`・`platform-craft`・`harness-self-improvement` の記述を「Claude Code は `.claude/skills` の
   アダプター、Codex は `.agents/skills` を直接読む」「開発用チェックアウトの印は3つ」に直した
5. 未実施: Codex の app-server の `skills/list` で、BuzzAssist Skill が1回（開発機では plugin と合わせて2回）だけ
   出ることを運営者の端末で確かめる
