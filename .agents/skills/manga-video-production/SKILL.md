---
name: manga-video-production
description: 対象チャンネル向け日本語漫画動画の台本設計、キャラクター、画像、ElevenLabs音声、吹き出し、カメラ、レンダー、修復、実MP4監査を行う。漫画動画を新規制作・変更・レビュー・監査するときは常に使い、旧version固有スクリプトを新作へ流用しない。
---

# 漫画動画動画制作

これはClaude CodeとCodexが共用する正本スキルである。作業開始時に本スキルを使うことを伝え、カメラを扱う場合は`../manga-page-camera/SKILL.md`も最後まで読む。

## 最初に読むもの

変更や有料生成の前に次を最後まで読む。

1. `../../../config/koya-manga-production-contract.json` — 実行可能な既定値と必須監査。全項目は隣接するJSON Schemaで閉じ、未知キーや型崩れを許さない
2. `../../../docs/koya-channel-requirements-ledger.md` — ユーザー要求の時系列。矛盾時は、明示されたエピソード例外を除き、後の要求を優先する
3. `../../../config/koya-manga-episode-overrides/<episode-id>.json` — 存在するときだけ読む凍結済み例外
4. `references/quality-contract-ja.md` — セッション横断で一般化した台本・絵・音声・編集品質
5. `references/final-review-ja.md` — 実MP4の知覚レビューと完了判定
6. `references/source-face-review-ja.md` — 自動顔検出の失敗、実MP4監査で判明した検出漏れ、重要小道具・証拠物の遮蔽を補うhash拘束付き手動領域レビュー
7. `../../../config/koya-manga-quality-incidents.json` — 新しい環境にも配布する一般化済み事故seed。実行時台帳とマージし、強い昇格状態を下げない
8. `../../../config/koya-show-bible.json` — 見本町、固定キャラの役割・口調、逆転型、最新の承認/保留状態。後日の明示修正が旧PDF指定を上書きする
9. `../../../config/koya-location-bible.json` — 小料理屋「山谷」と見本町の人物なし背景ボード仕様。承認画像がないlocationを登録しない
10. `../../../config/koya-thumbnail-contract.json` — 専用サムネ画像、中央帯、2/3コマ、文字数・具体名詞制約。pendingの色・書体を推測しない
11. `../../../docs/koya-channel-governance-ja.md` — 台本beat review、背景4視点review、サムネpreflight/finalの実行形式

JSON契約が実行設定の正本、要求台帳が理由の正本である。コード・本スキル・契約が食い違う場合は制作を止め、同じ変更内で整合させる。

## 唯一の制作入口

新規作品は必ず次だけを使う。

```bash
node scripts/koya-manga-video.mjs <action> ...
```

`scripts/build-manga-video.mjs`の`full`/`speech`、`apply-manga-v*`、`finalize-manga-v*`、`generate-manga-v*`は新規作品へ使用しない。これらは`config/koya-manga-legacy-migrations.json`に隔離されたベンチマーク移行である。

新規制作の基本形:

```bash
node scripts/koya-manga-video.mjs plan --script-path /absolute/script.txt --episode-id manga-<new-id> --protagonist-speaker-id <話者IDまたは完全一致名>
node scripts/koya-manga-video.mjs full --script-path /absolute/script.txt --episode-id manga-<new-id> --protagonist-speaker-id <話者IDまたは完全一致名>
```

`full`は再開可能である。終了コード2または3は完成ではない。`koya-production-state.json`を読み、承認待ち・利用上限・失敗箇所から、合格済み成果を再生成せず再開する。

## 品質ゲート（2026-08-28 追加。Claude Code / Codex 共通）

機械で測れるものは人間の目視より先に落とす。実行系はホストに依存しないため、
どちらのホストから起動しても同じ判定になる。

### 音声（台帳R194〜R195、R197、R199）

`speech`と`full`では音声品質ゲートが**既定でON**である。無効化するには
理由の明示が要る。

```bash
node scripts/koya-manga-video.mjs speech --episode-id <id>
# 無効化する場合のみ（監査に残る）
node scripts/koya-manga-video.mjs speech --episode-id <id> \
  --no-voice-quality-gate --voice-quality-gate-override-reason "<理由>"
```

- hard failのテイクは選定の適格集合から除外される。全滅時は最大4テイクまで
  自動追加し、それでも全滅ならカットを停止して人間へ渡す。
- 必須メトリクス（UTMOS、全発話のCER）が測れなかったテイクもhard failとする。
  測れなかったものをpassにしない。
- Python実行系は`VOICE_QA_PYTHON`（既定`/usr/bin/python3`）で固定する。
  `python3`はホストや起動経路によって解決先が変わり、依存の無い実行系を引くと
  ゲートが黙って無効になる。
- 手順の詳細は`docs/koya-voice-quality-runbook-ja.md`。

### キャラクター（台帳R192、R196、R200）

候補・修正画像は人間の目視の前に属性ゲートを通す。

```bash
node scripts/koya-manga-video.mjs character-attribute-gate \
  --inventory-path canvas/attribute-gates/<cast>-<round>.json
```

- 髪色Δ、微差テイク（pHash）、意図外変更、装飾スクリーニング、目の左右（人手）。
- 被覆はasset単位で、別assetの同型チェックで代替できない。必須ゲートが1件でも
  未実行なら不合格。
- 目の左右は機械判定できないため、reviewer名付きのアテステーションが要る。
- 実行系は`KOYA_GATE_PYTHON`（既定`/usr/bin/python3`）。
- 不合格からのやり直しは`lib/characterRepairPlan.mjs`のrepair-planを作ってから。
  修正ROIが次ラウンドの許可領域になり、それ以外の変化は落とされる。
- 手順の詳細は`docs/koya-character-gate-runbook-ja.md`。

### 匿名比較（台帳R198）

人間が選ぶ場面では出所を伏せる。

```bash
# 公式blind packetを見る（閲覧用）
node scripts/koya-open-blind-arena.mjs --public <judge-packet.json>
# パケット外（音声テイク等）を匿名化して比較
node scripts/koya-blind-review.mjs open --set <spec.json>
node scripts/koya-blind-review.mjs record --set <spec.json> --winner A --reviewer <名前> --note "<理由>"
```

採用の記録は公式CLI（`character-approve`、`character-style-select`）に残す。
アリーナの選択は記録ではない。

## 制作手順

1. 台本を省略・要約せず解析し、時系列、人物、読み、感情曲線、発話、画面上の証拠を固定する。`koya-story-review-v1`へ攻撃1/2/3、イブキの号砲、証拠、主人公本人のとどめ、登場時だけタツの退路封鎖1行を実発話IDで記録し、実在地名/ブランド、暴力美化、悪役コメディ、酒語彙抑制を確認する。`story-audit`合格後の同じreviewを`plan/full --story-review-path`へ渡す。台本変更後の古いreviewは使わない。
2. 有料生成前に主人公を一意に決め、`--protagonist-speaker-id`を渡す。複数候補なら推測せず停止する。
3. 判断を`機械で一意に検証可能 / 単一案へ赤入れ / 複数軸から選択`へ分類する。機械判定可能なことを人へ聞かない。単一案の曖昧点は3±1問、複数案は2〜5個の異なる軸を匿名比較し、高コスト・ブランド・好みの判断は人間が理由付きで決める。公開packetにはA〜E、匿名化した実artifact、SHA-256だけを置き、provider・内部ID・生成順・variationAxisの対応表は別のprivate mappingへ隔離する。
4. 年齢段階、顔、髪、体格、服、色、装飾、感情域、禁止差分を持つキャラクターバイブルを作る。新キャラクターは候補承認まで停止し、`character-approve`へ`--candidate-label`と具体的な`--approval-reason`を渡す。内部candidate IDやindexでの承認は禁止する。
   公開済み旧候補シートを正式匿名工程へ移すときは、A〜Eの公開ラベルを保存したまま`character-candidate-migrate-blind --generator-host legacy-migration`を使い、activeラベル、retiredラベル、具体的理由、移行contextを明示する。旧private mappingと公開シートが食い違う場合は衝突記録を残し、ラベルを振り直したり契約上限外の案を黙って昇格したりしない。
   固定キャラは`koya-show-bible.json`の`designStatus`を先に確認し、`pending`/`on-hold`を自動確定しない。人間が選んだ人物でも、実ターンアラウンド・表情セル・必要な衣装/開眼セルのv2レビューが終わるまで台帳へ登録しない。
   `character-approve`のidentity pack生成は人物単位checkpointへ候補SHA、生成context、prompt/model/size、参照SHA、各出力SHAを保存する。停止後は同じ入力と同じcontextで再実行し、digestが一致する生成済み画像だけを再利用する。出所不明の既存画像、入力変更、SHA変異を再開扱いにしない。生成完了後も別contextの原寸セル別reviewが通るまで登録しない。
   固定キャラ準備中は`character-bootstrap-status`でshow bible、既存workflow、選択ラベル、候補review、styling順序、identity pack、台帳を横断し、各人物の次の合法な工程を確認する。新作episodeの前には`cast-readiness`も通す。show bible固定人物が台帳未登録、identity-face/turnaround/expression/指定されたeye-open/outfitのどれか欠落、identity review SHA欠落、またはon-holdなら、その回だけの代替候補を作らず停止する。ももは無言出演でもcharacter bibleへ毎話宣言し、エマ登場回は`episodeRole=ally|antagonist`を明記する。
   採用候補の髪型・髪色・衣装・体格・細部を選び直す場合は、三面図へ直行せず`character-style-generate`→別contextによる各案の原寸QA→`character-style-compose`→人間選択→`character-style-select`を挟む。画像モデルへ横並び比較表を直接生成させない。各optionは採用顔1枚だけを身元参照にした独立の完全シートとして生成し、合格optionだけを決定論的に比較シートへ合成する。styling review v2では、合格optionの全ペアについて指定軸の可視差、重複takeでないこと、同一人物性、変更対象外の一致、原寸確認を必須にし、同じ設計のtake違いを候補数へ数えない。既存作品人物への非類似が要件なら、比較参照を`canvas/`へ保存し`--styling-comparison-reference-paths`でSHA拘束する。比較参照は生成モデルへ渡さず、各候補の独立QAだけで輪郭・髪・目元・全体印象を原寸比較する。比較シート自体は台帳へ登録せず、選ばれた個別assetだけを三面図・表情シートの唯一の人物参照にする。`--styling-round-id`を安定IDとして指定し、セッション制限や停止後はround/spec/generator contextを変えず同じコマンドを再実行する。各optionは生成入力SHA・出力path・画像SHAを即時checkpointし、完了済みbytesを再生成しない。公式工程外ですでに生成済みのsheetは捨てたり自動承認したりせず、source manifestと人間作成option mapが出力・入力元・prompt・model・時刻をSHA拘束でき、現specの最低比較数を満たす場合だけ`character-style-import --generator-host legacy-migration`で未承認roundへ取り込む。取り込み後も別contextの原寸QAは省略しない。複数属性を決める場合は1roundへ混ぜず、show bibleのspec path順に前roundの人間選択assetを次roundの唯一の基準にする（ももは全体修正→髪色→ジャージ色）。各roundはspec path/SHA/characterIdを保存し、全宣言roundが選択済みになるまで三面図へ進まない。エマは選択後もoffice/private-casual/private-dressyの3衣装シートを作る。
   山谷・見本町の背景は`location-plan`→`location-generate --location-stage anchor`→`location-anchor-review-draft`→別contextの原寸review→`location-anchor-audit`→そのreview pathを渡した`location-generate --location-stage continuity`で4個別jobを作る。`--location-stage all`は禁止する。continuityはgeneration manifestへSHA拘束された承認済みanchor候補1枚だけを参照し、各boardの生成context、prompt SHA、anchor SHA、画像SHAを保存する。再利用だけの呼出しでmanifestを書き換えず、新規生成は各boardごとにcheckpointする。全生成contextと異なるreviewerによる原寸・人物0・文字/実在ロゴ0・建築連続性review後にだけ`location-register`する。サムネは`thumbnail-audit`のpreflightが通ってから専用画像を生成し、本編frameとのSHA比較を含むfinal auditを通す。pendingの帯色・書体を推測しない。
5. 発話ごとの意味から構図を設計する。カット見出しだけを全発話へ誤適用しない。人物、背景、証拠、吹き出し余白を同時に設計する。
6. 独立画像jobを適応並列で生成し、技術・意味QAを行う。合格済みhashを再利用し、不合格だけを修正する。利用上限ではcheckpointを書いて停止する。
7. 承認済み日本語ネイティブ音声を人物ごとに固定する。声も最低2候補をA〜Eだけで全件実聴し、provider・voice ID・声名・sourceを伏せたまま`winnerLabel`と理由を先に保存してからprivate mappingを開く。新規作品の四角いナレーション枠は視覚様式を保ち、音声は主人公の承認済みVoice ID/Profile/設定/モデルと完全一致させる。専用ナレーターを作らない。
8. ElevenLabs `eleven_v3`のカット単位text-to-dialogue-with-timestampsで最低2テイクを作り、完全性と自然さで選ぶ。BGM・環境音・信号処理は使わない。

手動顔注釈は人物単位で使い回さず、元画像SHA-256ごとに原寸再計測する。別カットで同人物を注釈済みでも、新しい元画像を保護済みと推測しない。窓反射、鏡像、写真・端末画面内の可視顔も、手前の本人顔とは別ID・別矩形のhard faceとして同一画像内に全件在庫化する。
検出コマンドが失敗したのに安定出力パスへ前回の合格レポートが残っている状態を成功としない。source-face配置は今回呼び出しが新しく生成した証拠だけを受理し、失敗時は例外停止する。
9. 実素材上で顔・手・小道具・重要証拠を測り、吹き出しを配置する。検出した人物顔は発話者か否かを問わず全件を`face + hardProtection=true`の0px回避領域にする。自動顔検出が停止した場合、独立した実MP4監査が元画像側の検出漏れ・人物取り違えを示した場合、またはスマホ画面・地図・賞状など台詞理解に不可欠な証拠物が隠れた場合は対象画像を原寸目視し、`koya-source-region-review-v2`へ発話ID、`kind`（`face/hand/prop/evidence/text`）、顔だけは話者ID、正規化領域、画像SHA-256、具体的根拠を記録して`--source-face-review-path`で再開する。同じ画像の全人物頭部を在庫化し、発話者と同じ`speakerId`の手動顔は自動検出が存在してもprimaryを上書きする。特に`thought`は明部の中心そのものがprimaryへ依存するため、群衆・同窓会・複数人物画面では自動最大顔を信用せず、主人公頭部を原寸確認してhash拘束する。自動検出顔は非話者のhard obstacleとして残す。顔と`hardProtection=true`付き重要領域はいずれもカメラ全区間で0px保護する。旧`koya-source-face-review-v1`は顔だけの互換入力として受理するが、新規レビューはv2を使う。検出失敗を無条件承認しない。分割ページは個別素材ではなく黒ガター合成後の実ファイルを原寸で確認し、同じ発話IDでも固有`id`を持つ注釈を全顔ぶん記録する。正規化領域の展開には固定1920x1080ではなく、そのoverlay specの実`imageSize`を使う。顔在庫が0件の分割ページは停止する。画像変更後は同じ変更内で注釈を再計測する。契約移行や表示句読点規則の変更後は、旧SVGを流用せず`node scripts/koya-manga-video.mjs refresh-bubbles --episode-id <episode-id>`で全吹き出しを再生成してから再レンダーする。
10. 連続ナレーションを同一画像へ統合する前に、各文の意味を担う専用画像があるか比較する。「結婚した」の次に「子供が二人」のように可視事実が変わる場合は、同じナレーターでも画像を共有せず、該当文の実画像へ切り替える。長いholdは意味一致を犠牲にして作らない。
10. `manga-page-camera`の3系統を意味に合わせて混在させ、レンダーする。3倍oversampleの長尺レンダーは公式CLIのメモリ連動並列数を使い、16GiB級端末で4並列を強制しない。明示overrideがない限り、1ジョブ約6GiBとして物理メモリとCPUの小さい方へ制限し、swap増加時は同時実行数を下げる。部分修復は`render --cut-ids cut-XX`を使うが、これは再構築する最小集合の指定であって、入力が変わった選択外cutを古いMP4のまま残す許可ではない。選択外cutも、前回の`complete` checkpoint、現在と一致するimage/audio/overlay/camera入力hash、ffprobe実decodeの3条件を満たす場合だけ再利用する。prepareや`refresh-bubbles`が選択外のSVG・配置・cameraを更新した場合は、そのcutも安全に再構築集合へ追加する。旧MP4を現在入力へ再bindingしてはならない。
11. 実MP4から全必須監査と知覚レビューを行う。不合格なら該当範囲だけ修復し、最終監査をやり直す。

## 絶対条件

- 表示文は縦書き明朝、通常ウェイト、最大3列、自然な文節改行、末尾`。`なし。長文は意味の切れ目で分割し、同時表示せず1個ずつ切り替える。文字数だけで切らず、固有名詞・複合語・活用語の途中、助詞・助動詞の直前では分割しない。空白だけのtimed segmentを作らない。音声・台本の原文は改変せず、表示用文字列では**全文末尾の句点だけ**を除く。読点、疑問符、感嘆符、文中の`。`は各timed segmentにも保持し、セグメント単位の末尾処理で消さない。通常の1列配置を先に試し、顔0px回避または組版hard gateに失敗した場合だけ、同時表示の自然な2〜3列へ退避する。複数列化を全セグメントへ先回り適用しない。`bubble-typography.json.terminalPunctuation.pass=true`、`naturalSegmentation.pass=true`、全行`terminalPeriodFound=false`を必ず確認する。
- 表示中は発話者だけでなく画面内の全人物の顔・頭と吹き出しの重なりを、カメラ移動中を含め0pxにする。配置座標と最終監査の顔検出を共有しない。最終監査の吹き出し領域は配置計画の矩形ではなく、実際に合成したrasterized overlay PNGのalpha非透明bboxから測る。alpha bboxの正規化には元SVGやoverlay specの寸法ではなく、そのPNGを原寸でdecodeした実pixel幅・高さを使う。実ラスターがあるのに計画座標へ戻して判定しない。独立cascadeの候補は検出confidenceを保存し、校正済み閾値未満の低信頼候補だけを除外する。合格閾値を超えて吹き出しに覆われたcascade候補は、直前直後のbubble-clear frameへ分割ページ全体のカメラ変換を反映して同一物を再探索する。そこにも顔がなければ腕時計・文字・輪郭等のoverlay起因候補として除外し、再投影後にも存在する実顔はconfidenceの高低にかかわらず消さない。
- 思考場面の暗部と顔中心の明部は、カメラ前の元ページへ焼き込む。実MP4監査で顔を画面へ投影するときは、manifestの生focus座標を直接使わず、レンダーと同じcamera mode正規化・終端zoom基準のsafe focus clamp・keyframe再構築を適用する。生座標と実cropが違う状態で明部不合格を出さない。
- 人体、手、指、小道具、遠近、服装段階、人物同一性、背景密度、疑似文字を目視する。機械合格で代用しない。
- 一つの画像に複数発話を自然に保持できる場合、発話ごとに画像を乱造しない。場面転換と因果が読める編集連続性を優先する。
- 承認済み発話WAVを、画像・吹き出し・カメラ修正のついでに再生成しない。
- cut単位ダイアログの分割点は、プロバイダ申告の`start_time_seconds`中点ではなく、文字単位アライメントで囲んだ区間の実測持続無音に置く。申告終端は語尾リリースを含まず実際より約200ms早いので、そこで切ると前話者の残響が次発話の先頭に残る。話者交代の境界で別人の声が混入していないことを`audio-speaker-continuity`で検証する。承認済みテイクからの再分割は再生成ではないので、この修復に有料呼び出しは不要。
- 音声の話者同一性判定に基本周波数を使わない。語頭の弱い基音で男性声が2〜3倍に測定され、オクターブ補正を入れると女性声が副次調波へ落ちて全話者が潰れる。log-melスペクトル包絡＋ケプストラム平均正規化の距離で判定し、同一声（ナレーション=主人公）は参照間距離が小さいことをもって判別不能として明示的にskipする。
- 縦組みのラテン文字・数字は正立させる。`vrt2`（縦組み代替＋回転）はかな・漢字・約物にだけ適用し、ラテン文字へ適用しない。`T大`は倒したTではなく正立Tを縦に積む。
- 吹き出しの表示テキストに読み仮名の括弧注記を残さない（`荒野（あらの）`は`荒野`と表示）。読みは音声テキスト側にだけ持たせる。通常の括弧台詞は消さない。
- 吹き出し分割セグメントの表示タイミングは文字数比例で推定せず、sidecarの`characterTimeline`（プロバイダの文字単位タイムスタンプ）に従う。話速一定の仮定は、間や強調のある長い台詞で後続セグメントを全部ずらす。
- STT結果は、認識時に保存したdecoded PCM SHA-256と順序付き発話本文digestが現在値へ完全一致するときだけ再利用する。同じMP4パスを再抽出して旧STT結果を正当化しない。
- ユーザーの実聴・目視指摘は機械監査より上位。同型不具合を既知のまま再提出しない。
- generator自身、同じ会話contextの別名reviewer、rubricの一部だけの採点、hashのない証拠で品質合格を出さない。generatorとreviewerは実Codex task IDまたはClaude session IDを記録し、別contextでなければ停止する。品質閾値、最大2round、最大時間、最大費用、停滞上限を別々に判定する。

## 最終監査

```bash
node scripts/koya-manga-video.mjs audit --episode-id <episode-id>
```

監査で作った実MP4由来contact sheet、代表フレーム、音声区間、全編MP4を実際に確認し、`references/final-review-ja.md`の形式でレビュー記録JSONを作る。契約digest、実MP4/contact sheet/代表フレームのSHA-256、全編確認範囲、冒頭・中盤・終端の音声確認範囲を実値で記録した後だけ署名する。

```bash
node scripts/koya-manga-video.mjs signoff --episode-id <episode-id> --reviewer claude --reviewer-context-id <実Claude-session-id> --review-notes-path /absolute/review.json --pass
# または --reviewer codex
node scripts/koya-manga-video.mjs audit --episode-id <episode-id>
```

完了は、契約の完了status、全必須監査PASS、`knownRemainingIssues=[]`、実MP4の全デコード、MP4 hashに結び付いたClaude/Codex署名がすべて揃ったときだけ宣言する。報告には絶対MP4パス、尺、解像度、fps、容量、主要監査、残課題0件を含める。
`quality-harness-final`は空の品質ループ状態や事前ゲートだけでは合格しない。独立contextの全rubric採点を含む完了roundが最低1回必要である。自分自身を除く全必須監査の結果・実在証拠SHA-256・契約digest・実MP4 SHA-256・証拠Merkle rootを集約した`final-decision.json`が`passed`であることを確認する。失敗監査は永続incident ledgerへ記録し、再発時の指示/hard-gate昇格を次の新規台本へ引き継ぐ。

## 自動で積み上がった指摘

<!-- LEARNED:BEGIN — この節は harness-learn が自動で書く。手で編集しない -->

_まだ自動反映された項目はありません。_

<!-- LEARNED:END -->
