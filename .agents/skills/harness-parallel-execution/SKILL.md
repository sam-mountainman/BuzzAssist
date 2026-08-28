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

原証跡は `docs/measurements/parallel-limits-2026-08-28.json` にある。
以下は**1台（8コア/16GB）での観測値であって、測った上限ではない**。

| 実行方式 | 観測 | マシン依存 |
|---|---|---|
| Claude Code のサブエージェント | `min(16, CPUコア数-2)`（仕様値。8コア機で6体） | **する** |
| `codex exec` のプロセス並列 | 16体まで成功。コア数に比例しなかった | していない（ように見える） |
| ffmpeg のカットレンダー | 単体でCPU 486%。8コア機で6本並列でも短縮3.6% | する |
| Fish Audio TTS | 4本。ネットワーク待ちが支配的 | しない |

「codex はマシン非依存」は1台1回の観測からの推測でしかない。
弱いマシンで同じ本数が出るかは**未測定**。429の発生率も測っていない。

読み方:

- **Claude Code の並列数はPCスペックに縛られる**。4コア機なら2体、
  16コア機なら14体。運営者やナレーション物語の運営者のPCでは数が変わる。
- **`codex exec` はこの機械ではコア数に比例しなかった**。ボトルネックは
  CPUではなくAPIのレート制限とネットワークに見える。ただし他スペックの
  機械では未測定なので、「弱いPCでも同じ本数が出る」と決めてかからない。
- **ffmpeg はこの設定・この機械では並列にしても速くならない**。
  libx264 の内部スレッドがすでに約5コアを使っているため。
  1本のffmpegが使い切れないコアが余る機械では話が変わるので、
  `--render-concurrency` を上げる前に必ずその機械で測る。

CPU律速の工程は、CPUが余っていなければ並列にしても速くならない。
**投資先は基本的にネットワーク律速の工程**（TTS、LLM判断の扇形展開）。
ただしキャラの属性ゲートはローカルのPython・OpenCVでCPU律速なので、
「ネットワーク律速だけが効く」と単純化しないこと。

## 2つの並列レイヤー

### ① 決定論層 — CLIコマンドの並列

ゲート・監査・レンダー・生成のようにコマンドで表せる作業。
**ホストに関係なく同じスクリプトを叩く**ので、Claude Code からでも
Codex からでも同じ計画・同じ順序・同じ形式の結果になる。
（環境変数は親から継承するので、ホスト側の環境が違えば実行結果は
変わりうる。「完全に一致する」とまでは保証しない。）

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
- `locks` … 同じファイルを指すジョブは決して同時に走らない。値は
  `cwd` 起点の絶対パスへ正規化されるので、`state.json` と `./state.json`
  は同じロックになる。共有台帳を触るジョブにそのパスを書く。
  **排他はランナー1プロセス内でだけ効く**。ランナーを2つ同時に起動すれば
  排他されないので、同じ計画を二重に走らせないこと。
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
`codex exec` はプロセス並列でコア数に縛られなかった。両ホストから
同じ本数を出すには、両方が同じ外部CLIを呼ぶ形にするのが手堅い。

エンジンの選び方は `--engine auto`（通常実行時）が決める。**先に codex を
試し、通ればそこで確定する**ので、claude へ自動で切り替わることはない。
claude を使いたいときは `--engine claude` を明示する。
`--probe` は使えるエンジンを表示して終わるだけで、選択はしない。

> 現状 `claude` CLI は未ログインで、ヘッドレス起動ができない
> （`claude auth status` が `loggedIn:false`）。ログインしても `auto` は
> codex を優先するので、切り替えには `--engine claude` が要る。
> なお claude は read-only を保証できないため、`--read-only` 指定時は
> 候補から外れる。

### Codex のネイティブ並列を無視しないこと

Codex には**組み込みのサブエージェント**がある（`codex features list` で
`multi_agent stable true`）。`codex agents` や App Server 経由の並列も存在する。
つまり `codex exec` を16本並べると、各プロセスが内部でさらにスレッドを
起こし、実効並列度が16を大きく超えることがある。レート制限や共有ファイルの
衝突は、外側の本数だけを見ていると読み違える。

固定の扇形展開では、外側の本数で制御しきる前提を置かないこと。
必要なら `agents.max_concurrent_threads_per_session` で内側を絞る。

**CLIの版差にも注意**: このマシンには2つの codex がある。
`/Applications/ChatGPT.app/Contents/Resources/codex`（0.150.0-alpha.8、
`agents` サブコマンドあり）と PATH 上の 0.144.1（`agents` なし）。
ランナーは前者を優先する。手で試すときに別の版を引くと挙動が食い違う。

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
  マニフェストを書くのは収集側だけ（ワーカーは書かない）。書き込みは
  セグメント完了ごとに起きるが、常に台本順で並べ直すので、
  途中で落ちても順序は崩れない
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
既定は `floor(コア数/6)` で、**8コア機では1本（逐次）**。上の実測のとおり
ffmpeg が単体で約5コアを使うため、8コア機で並列にしても3.6%しか縮まらない。
12コア以上の機械では既定が2本以上になる。`--render-concurrency` を
手で上げる前に、その機械で逐次と比べて測ること。

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
