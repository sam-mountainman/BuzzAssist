---
name: harness-parallel-execution
description: 運営者の漫画動画ハーネスとナレーション物語の運営者の動画ハーネスで、複数の作業を並列に流して総時間を縮めるための正本。「並列でやって」「同時に走らせて」「一気に終わらせて」「最短で」「サブエージェントを立てて」「セッションを分けて」と言われたとき、また11人分のキャラゲート・30セグメントのTTS・複数エピソードの監査のように同種の作業が数多く並んでいるときは必ず読む。どこが並列にできてどこが直列必須か、実測した並列上限はいくつか、共有状態をどう壊さないかを定める。Claude Code と Codex のどちらから実行しても同じ結果になる。
---

# ハーネスの並列実行

## この文書の役割

同じ作業を何十件も回すとき、素直に直列で流すと待ち時間の大半が
ネットワーク待ちになる。一方で、何でも並列にすると共有台帳が壊れ、
「速く終わったが成果物が信用できない」状態になる。

ここでは **どこを並列にすると実際に速くなるか** と
**どこを並列にすると壊れるか** を、実測値と根拠つきで固定する。
推測で並列化しないこと。以下の数字は 2026-08-28 に実機で測ったもの。

## 大原則

並列化はゲートを緩めない。ここを踏み外すと全部無意味になる。

- **fail-closed を維持する**。依存する前工程が落ちたジョブは実行しない。
  「並列にしたら通った」を作らない。
- **共有状態への書き込みは1プロセスに限る**。同時書き込みで壊れる
  ファイルは後述の一覧にある。ワーカーからは書かせず、収集側が書く。
- **順序を持つ成果物は index で組み立てる**。完了順に push すると
  台本順が壊れる。並列にしても中身は逐次実行と1バイトも変わらないこと。
- **証跡を残す**。何を並列で流したか（計画ダイジェスト、各ジョブの
  終了コードと所要時間）をレポートJSONに残す。

## 実測した並列上限

| 実行方式 | 上限 | マシン依存 | 実測 |
|---|---|---|---|
| Claude Code のサブエージェント | `min(16, CPUコア数-2)` | **する** | 8コア機で6体 |
| `codex exec` のプロセス並列 | 設定なし。API側の制限が実質上限 | **しない** | 16体が同時完走（154秒） |
| ffmpeg のカットレンダー | 実質1本 | – | 単体でCPU 486%。6本並列でも短縮4% |
| Fish Audio TTS | 4本推奨 | しない | ネットワーク待ちが支配的 |

読み方:

- **Claude Code の並列数だけがPCスペックに縛られる**。4コア機なら2体、
  16コア機なら14体。運営者やナレーション物語の運営者のPCでは数が変わる。
- **`codex exec` はコア数に縛られない**。弱いPCでも同じ本数が出せる。
  ボトルネックはCPUではなくAPIのレート制限とネットワーク。
- **ffmpeg は並列にしても速くならない**。libx264 の内部スレッドが
  すでに約5コアを使い切っているため。8コア機で6本並列にしても
  実尺10秒×6本が28秒→27秒（4%）にしかならなかった。
  1本のffmpegが使い切れないコアが余る機械（目安24コア以上）でだけ
  `--render-concurrency` を上げる意味がある。

CPU律速の工程を並列にしても速くならない。**効くのはネットワーク律速の
工程だけ** で、そこが並列化の投資先になる。

## 2つの並列レイヤー

### ① 決定論層 — CLIコマンドの並列

ゲート・監査・レンダー・生成のようにコマンドで表せる作業。
**ホストに関係なく同じスクリプトを叩く**ので、Claude Code からでも
Codex からでも結果が完全に一致する。

```bash
node scripts/harness-parallel-run.mjs --plan <plan.json> \
  --concurrency auto --report <report.json>
```

計画JSONの形:

```json
{
  "planId": "koya-cast-gates-2026-08-28",
  "defaults": { "cwd": "/Users/higataiyu/Documents/Excalidraw" },
  "jobs": [
    {
      "id": "gate-horo",
      "title": "もも 属性ゲート",
      "command": "node",
      "args": ["scripts/koya-manga-video.mjs", "character-attribute-gate",
               "--inventory-path", "canvas/attribute-gates/horo-r1.json"],
      "needs": [],
      "locks": [],
      "timeoutMs": 600000
    }
  ]
}
```

- `needs` … 依存。指定したジョブが**成功**するまで走らない。
  失敗すれば下流は連鎖的に `skipped` になり、全体の終了コードは非0。
- `locks` … 同じ文字列を宣言したジョブは決して同時に走らない。
  共有台帳を触るジョブに、そのファイルパスを書く。
- `expectExitCode` … ゲートのように非0が正常な場合に指定する。
- `--dry-run` で実行せず計画の妥当性と順序だけ確認できる。

計画は実行前に丸ごと検証する（id重複・存在しない依存・循環依存）。
1件でも壊れていれば1つも実行しない。片方だけ走った状態の後始末は高くつく。

### ② LLM判断層 — レビュー・QA の並列

同一人物QA・混同防止レビュー・台本監査のように、モデルの判断が要る作業。

```bash
node scripts/harness-parallel-agents.mjs --tasks <tasks.json> \
  --concurrency 8 --report <report.json>
node scripts/harness-parallel-agents.mjs --probe   # 使えるエンジンを確認
```

```json
{ "tasks": [ { "id": "qa-horo-tatsu", "title": "もも×タツ 混同防止",
               "prompt": "...", "timeoutMs": 900000 } ] }
```

**なぜホスト内蔵のサブエージェントを直接使わないか**: Claude Code の
並列上限はコア数に縛られ、8コア機では6体で頭打ちになる。
`codex exec` はプロセス並列なのでコア数に縛られない。両ホストから
同じ本数を出すには、両方が同じ外部CLIを呼ぶ形にするしかない。
`--probe` が認証の通るエンジンを自動で選ぶので、呼ぶ側は意識しなくてよい。

> 現状 `claude` CLI は未ログインで、ヘッドレス起動ができない。
> `claude` にログインすれば Claude Code 側も同じ扇形展開が使えるようになる。
> それまでは両ホストとも `codex exec` 経由で動く。

MCPサーバの読み込みは並列度が上がるとタイムアウトしやすいので既定で切る。
必要なときだけ `--with-mcp` を付ける。

## 漫画動画ハーネスの並列粒度

**正しい粒度は1キャラ（castId）単位**。生成ロック・レビュー成果物・
styling シーケンス制約がすべて `<workflowId>/<castId>` で名前空間分離
されているため、11人を横に並べるのが最大の勝ち筋になる。

### 並列にしてよい

- `character-attribute-gate` … キャラ単位。書き込みは `--output-path` のみ
- `character-candidate-qa-sheet` / `character-style-qa-sheet` … キャラ単位。
  出力先が castId で分離、ワークフローストアは読むだけ
- `character-style-generate` / `character-style-select` / `character-approve`
  … **異なる castId 同士なら**並列可。`updateCharacterWorkflow` が
  read→mutate→write 全体をファイルロックで囲い、自分の cast エントリ
  だけを差し替えるため
- `audit` / `signoff` / `render` … **異なるエピソード同士なら**並列可。
  `render` は pid ロックがあり同一エピソードの二重起動は自動で落ちる
- 読み取り専用アクション（`contract` / `status` / `story-audit` /
  `location-*-review-draft` / `cast-readiness` / `handoff-verify` 等）
  … 何本でも同時可

### 直列必須

- **`images` はチャンネル全体で常に1本**。`prepareCharacterWorkflow` の
  read-modify-write がロックの外にあり、**別エピソード同士でも**
  同時起動すると片方が `Stale character workflow revision` で落ちる。
  加えて画像生成のレート制御（`lib/adaptiveConcurrency.mjs`）は
  プロセス内メモリで状態を持つので、プロセスを分けると制御が効かなくなる
- **同一エピソードの `plan` / `prepare` / `speech` / `adjust-gap` /
  `repair-*` / `refresh-bubbles`** … `koya-production-state.json` と
  `episode-manifest.json` が**ロックなしの** read-modify-write。
  別エピソード同士なら安全
- **`character-register` / `location-register`** … レジストリを
  revision 比較つきで書く。並列にすると後発が必ず落ちる。1件ずつ
- **同一キャラの styling ラウンド** … 髪型→髪色→服色の宣言順が
  強制されている。1キャラ内は必ず直列

### 同時書き込みで壊れるファイル（`locks` に書く）

```
canvas/character-workflows.json            チャンネル全体で単一
canvas/characters.json                     レジストリ
canvas/channel-visual-profiles.json
canvas/manga-videos/<ep>/koya-production-state.json    ロックなし
canvas/manga-videos/<ep>/episode-manifest.json         ロックなし
canvas/assets/<ep>/script-image-*.json
```

## マイクハーネスの並列粒度

### 並列にしてよい

- **Fish TTS のセグメント単位（既定4並列）**。
  `generate-fish-audio-full-v1.mjs --tts-concurrency 4`。
  raw も納品WAVも指紋つきの固有パスなので衝突しない。
  マニフェストは収集側が台本順で1回だけ書く
- ボイス候補 A/B/C の合成、レビュー用ナレーション3行
- 計測系（ffprobe / RMS / 無音検出）… 読み取り専用

### 直列必須

- **`finalize-*` 全般** … 既存JSONの read-modify-write。
  同時実行すると片方の更新が消える
- **xfade 連結・voice stem の amix・2パス loudnorm** …
  単一のフィルタグラフ、または1パス目の測定値を2パス目へ渡す構造
- **`regenerate-fish-audio-segments-v1.mjs`** … 違うセグメントを
  指定しても、最後に生成レポート全体を読んで書き戻すため2本同時は不可
- **工程間の依存**: TTS実尺 → retime計画 → 画の尺 → 画レンダー。
  **音声30本が揃って測定されるまで画のレンダーは始められない**
- **BGM承認・目視サインオフ** … 人を挟む同期点

### 画のレンダーは並列化しない

`render-picture-lock-v2.mjs` はカット単位のワーカープールを持つが、
**既定は1本（逐次）**。上の実測のとおり ffmpeg が単体でCPUを
使い切っているので、8コア機で並列にしても4%しか縮まらない。
`--render-concurrency` は多コア機のための逃げ道であって、
既定を上げる根拠は今のところない。

### 同時書き込みで壊れるファイル

```
audits/audio/fish-audio-full-generation-v1.json    generate/regenerate/finalize が触る
audits/audio/fish-audio-picture-retime-plan-v1.json
audits/audio/bgm-allocation-approval-v1.json
audits/audio/fish-av-master-v1/*.json
.media/fish-audio/full-v1/private-state.json       mode 0600
episodes/mike-fish-av-v1/input.json
production/work-fish-av-v1/                        rmSync で丸ごと消える
```

`render-picture-lock-v2.mjs` は起動時に work ディレクトリを
無条件で `rmSync` する（`--reuse-segments` 時を除く）。同じ
`--work-dir` で2本走らせると互いの中間成果を消し合う。

## 手順

1. **粒度を決める**。上の表で並列にしてよいか確認する。
   書いていないアクションは、共有台帳への書き込みを実装で確認するまで
   直列に置く。推測で並列にしない。
2. **計画JSONを書く**。共有ファイルを触るジョブには `locks` を必ず付ける。
3. **`--dry-run` で順序を確認する**。
4. **実行してレポートを残す**。`--report` を必ず付ける。
5. **失敗を確認する**。`skipped` があれば、その原因のジョブを直してから
   計画ごと再実行する。個別に手で流し直さない（依存の検証が飛ぶ）。

## やってはいけないこと

- 共有台帳を触るジョブに `locks` を付けずに並列へ入れる
- CPU律速の工程（ffmpeg・libx264）を並列にして「速くなった」と報告する。
  実測しないまま台数を増やしても総時間は縮まない
- 並列にしたうえで、失敗したジョブを飛ばして後工程を続ける
- ワーカーの中から共有マニフェストを書く
- 有償APIの呼び出しをリトライ無しで並列度だけ上げる。
  429を踏む確率が上がるので、上限つきの指数バックオフを先に入れる
