# サムネの計画と検査（ナレーション物語）

`../SKILL.md` の「サムネ」の続き。サムネを計画・検査するときに読む。本体はジャンル共通の
`lib/thumbnailPlan.mjs`（漫画も同じ）、ハーネスごとの決まりの置き場は `lib/thumbnailPlanHarnesses.mjs`。
どちらも読むだけで、有料 API・画像生成・モデル呼び出しはしない。

## 決まりの置き場

- 署名済み Channel Pack の `narrated-story.json` の `thumbnail` 節（`rules`・`layouts`・`text`・
  `approvedReferences`）。`layouts` と `text` はチャンネルの決定なので必須
- 節が無い Pack ではサムネを計画しない。帯色・書体・文字数などチャンネル固有の値を推測で埋めない
- `--channel-pack` は署名済みの envelope（受領側が信頼した公開鍵で検証）。`--channel-config` は署名の
  無い `narrated-story.json` で、試行用。final は通らない。どちらも無ければ `--job-id` の Job の Pack を読む

## 手順

```bash
node scripts/thumbnail-plan.mjs draft --harness narrated-story-video --job-id <Job ID> [--layout ID]
node scripts/thumbnail-plan.mjs audit --harness narrated-story-video --plan-path <plan.json> [--plan-path <案2>]...
```

1. `draft` で下書きを作る。`--job-id` を付けると、Job の id・回の id（`episodeId`）・完成動画の SHA-256 が
   `jobBinding` に入る
2. preflight（`stage: "preflight"` の計画の `audit`）が通ってから専用画を作る
3. 文字を入れるなら、枠ごとに `lettering`（書体・抑揚・字間・色・担体）を書く。在り処だけの指定は
   既定のゴシックの仮看板で埋まる
4. 人が写るなら、承認済みの設定画の SHA-256 を `characterReferences` に書く
5. 案を並べるときは `--plan-path` を案の数だけ渡し、読める軸（吹き出しの数・場面・構図・ビート・
   載せ物＝`idea`）で違うことを確かめる。書体・帯色・寄り広めの差は別の案として数えない
6. final: 専用画（`artworkPaths`）と完成画（`compositePath`、原寸ぴったり）のそれぞれに、途中の
   成果物の品質ループの thumbnail 工程の合格が要る。完成画は決定サイズ（既定 320×180）で見てから、
   人の確認を `checks.compositeSha256` で完成画に結び付ける
7. final は `jobBinding` の Job が completed で、`videoSha256` がその Job の完成動画の SHA と一致する
   ときだけ通る。サムネは Job の成果物にも RunReceipt の保証にも入れない
