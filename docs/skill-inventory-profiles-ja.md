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
  record（`setup-agents` が配布物 `skills/` へコピーするのはこの2系統。`.claude/skills` /
  `.codex/skills` の host adapter は配布物に入らないので比較しない）
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
正本変更は評価と人間承認を通す。Operatorの動画生成hot pathへ管理権限を持ち込まない。

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

## Skill Creator

BuzzAssist版の正本は `.agents/skills/skill-creator/SKILL.md`。plugin配布時は
`buzzassist:skill-creator` になり、project上では衝突回避のため
`buzzassist-skill-creator` という薄いadapter（`.claude/skills`、`.codex/skills`、共有の
`.agents/skills/buzzassist-skill-creator`）から正本へ到達する。3つとも
`inventory.manifest.json` の `adapters` に登録し、正本参照が切れたら検査で落ちる。
Codex system Skill、global Skill、Cowork版、plugin cacheは編集しない。

**制作中の依存**と**Skill改善用の機能**は別物として扱う。

| 区分 | 何か | Profile |
|---|---|---|
| 制作中の依存 | platform-craft、harness-*、manga-*、narrated-story-video、excalidraw-*（生成系） | Operator Production で base または Harness宣言により許可 |
| Skill改善用の機能 | `buzzassist:skill-creator`、`excalidraw-benchmark-manga-style`、Best-of-N、独立監査 | BuzzAssist Development のみ。Operator の hot path には出さない |

skill-creator は「不要だから外す」のではなく「本番動画Jobから隔離する」。正本を更新する
ときは skill-creator、eval、inventoryのversion/content SHA、両host adapter検査をまとめて行う。

