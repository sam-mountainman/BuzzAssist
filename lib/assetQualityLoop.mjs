/**
 * 途中の成果物の品質ループ（genre 層の共通 Core。漫画動画とナレーション物語の両方が使う）。
 *
 * 対象は完成動画より前の成果物——人物の設定画（character）、背景・場所（location）、本編の画
 * （scene-image）、サムネ（thumbnail）、声のテイク（voice-take）。これまでは機械の検査と人の承認、
 * 画の QA の再試行、声の撮り直しで止めるか作り直すだけで、評価者つきのループにも学習の台帳にも
 * つながっていなかった。ここは台本の品質ループ（lib/scriptQualityLoop.mjs）と同じ作りで、
 * 成果物の「版」ごとに、作った文脈とは別の評価文脈の採点を1回として記録する。
 *
 * 中核（採点・下限・失敗指紋・止まる条件・作る係と評価する係の分離）は lib/qualityLoop.mjs の
 * 共通部品で、ここが決めるのは次だけ:
 *   - 工程ごとの既定の評価項目と下限（共有層なのでチャンネル固有の事実は書かない。重みと追加項目は
 *     Channel Pack の任意のファイル asset-quality.json から読む）
 *   - 機械ゲート（ファイル・参照の承認一覧・音声品質ゲートの報告だけから決まる）
 *   - 人の確認の欄（人物の同一性と、公開面に出る画の手指の安全）
 *   - 版を1回の採点へ結び付ける配線（成果物の SHA・作った文脈とホスト・生成の経路・参照の SHA・評価文脈）
 *
 * 守ること:
 *   - 採点は成果物ファイルの SHA に縛る。採点ファイルの assetSha256 が今のファイルと違えば記録しない
 *   - 作った文脈（start の文脈・この版と前の版を作った文脈）の採点は記録しない。前の回の評価文脈も使えない
 *   - 2回目以降は、前回の失敗指紋と直しの差分の両方が要る。無ければ例外ではなく人待ちで止める
 *   - 人物の同一性と、公開面に出る画（サムネ・人物）の手指の安全は、人の確認（human-verified）が
 *     無いとループは合格にならない。機械は自分で人の確認を記録できない（対話端末＋--human-verified の
 *     二手。判定は scripts/harness-learn.mjs の attestationFor と同じ一つの実装を使う）
 *   - 評価者に渡すシートには合格点・下限・重み・前の回の点数を載せない（ASSET_REVIEW_SHEET_FORBIDDEN_KEYS）
 *   - Channel Pack は下限を上げる・項目を足す・重みを変えることだけできる。下げる・消す・範囲外は blocker
 *   - 状態は成果物と同じ作業フォルダ（私有側）の quality/assets/ に原子的に書く。プロンプトや台本の本文は持たない
 */

import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { readJsonIfExists, writeJsonAtomic } from "./atomicJsonFile.mjs";
import { withCanvasFileLock } from "./canvasFileLock.mjs";
import { getImageDimensionsFromBuffer } from "./canvasScene.mjs";
import { trustedChannelPackKeyFromEnvironment, verifyChannelPackEnvelope } from "./channelPackEnvelope.mjs";
import {
  createQualityLoopState,
  normalizeQualityRubric,
  recordQualityRound,
  sanitizeEvidence,
} from "./qualityLoop.mjs";
import { voiceQualityPenalty } from "./voiceQualityGate.mjs";

export const ASSET_QUALITY_CONTRACT_VERSION = "buzzassist-asset-quality-contract-v1";
export const ASSET_QUALITY_STATE_VERSION = "buzzassist-asset-quality-loop-v1";
export const ASSET_QUALITY_CHANNEL_CONFIG_VERSION = "buzzassist-asset-quality-channel-v1";
/** Channel Pack の payload に置く任意のファイル（チャンネル固有の評価項目・下限・重み・上限）。 */
export const ASSET_QUALITY_CHANNEL_CONFIG_FILE = "asset-quality.json";
/** 参照に使ってよい承認済みの画（設定画・場所の基準画）の SHA 一覧の形。 */
export const APPROVED_REFERENCES_VERSION = "buzzassist-approved-references-v1";
export const ASSET_QUALITY_DIR = path.join("quality", "assets");
/** 作る係の役割 id。評価者がこれを名乗っても採点できない。 */
export const ASSET_GENERATOR_ID = "asset-maker";
/** 人の確認として数える印（scripts/harness-learn.mjs の HUMAN_VERIFIED と同じ値。試験が一致を見る）。 */
export const ASSET_HUMAN_VERIFIED = "human-verified";

export const ASSET_STAGES = Object.freeze(["character", "location", "scene-image", "thumbnail", "voice-take"]);

/** ハーネスごとに使える工程。場所（location）は漫画固有（下の STAGE_SPECS.location.genreOnly）。 */
export const ASSET_QUALITY_HARNESSES = Object.freeze({
  "koya-manga-video": Object.freeze({
    id: "koya-manga-video",
    genre: "manga",
    stages: Object.freeze(["character", "location", "scene-image", "thumbnail", "voice-take"]),
  }),
  "narrated-story-video": Object.freeze({
    id: "narrated-story-video",
    genre: "narrated-story",
    stages: Object.freeze(["character", "scene-image", "thumbnail", "voice-take"]),
  }),
});

/**
 * 生成の経路。版の記録はこの一覧から選ぶ（自由記述にすると、同じ経路が別名で数えられ、経路ごとの
 * 不合格率を後から比べられない）。足すときはここに1行足す。
 */
export const ASSET_GENERATION_ROUTES = Object.freeze({
  "chatgpt-web": "ChatGPT の web 画面で作った（ハーネスの外。プロンプトと会話の記録は作った側が別に残す）",
  codex: "Codex の組み込み画像生成で作った",
  "local-model": "自前の端末・サーバーのローカルモデルで作った",
  grok: "Grok Imagine で作った",
  broker: "BuzzAssist の有料 Media Job Broker（lib/paidMediaJobBroker.mjs）経由で作った",
  "human-edit": "人が作画・編集ソフトで作った・直した",
});

/** 機械ゲート。採点より前に、ファイル・参照の承認一覧・音声品質ゲートの報告だけから決まる。 */
export const ASSET_MACHINE_GATES = Object.freeze({
  "asset-readable": "成果物ファイルが空でなく、工程の種類（画像か音声か）の形式として読める",
  "reference-declared": "評価者が人物が写っていると答えた版に、参照した承認済みの設定画の SHA が付いている（参照なしで同一性の確認を逃れない）",
  "reference-approved": "参照した画の SHA が、承認済みの参照の一覧（buzzassist-approved-references-v1）に全部ある。一覧が無ければ落とす（ファイル名で参照を信用しない）",
  "human-rejection-absent": "この成果物（同じ SHA）に、人の確認で否とした記録が無い",
  "thumbnail-aspect-16x9": "サムネの画が 16:9 で、幅 1280px 以上（YouTube のサムネの原寸）。寸法を読めない形式も落とす",
  "voice-metrics-pass": "既存の音声品質ゲート（scripts/audit-voice-quality.py）の報告がこのテイクの SHA に結び付き、必須の指標（CER・UTMOS）が測れて hard fail が無い",
});

/** 人の確認の欄。ここに挙げた確認は、対話端末＋--human-verified の記録が無いと合格にならない。 */
export const ASSET_HUMAN_CHECKS = Object.freeze({
  identity: "人物の同一性（承認済みの設定画と並べて、顔・髪・体型が同じ人に見える）",
  "hand-safety": "手指・身ぶりの安全（猥褻・侮辱と読めるジェスチャーが無く、指の融合・欠損が無い）",
});

// ---------------------------------------------------------------------------------------------
// 工程ごとの既定の評価項目。重みと下限は実測から決めた閾値ではなく方針値で、下限はジャンルの
// 品質ループと同じ考え方にそろえる——同一性・意味（場面の意図）・声は 80、1つでもあれば致命的な
// 二値の安全項目（猥褻・侮辱のジェスチャー、実在ブランドのロゴ、写真調）は 100（該当が無ければ満点・
// あれば 0 点）、ほかは 60。出典: .agents/skills/manga-video-production/SKILL.md「絶対条件」
// （「下限は同一性・台本との意味の一致・声が80、ほかが60」）、.agents/skills/narrated-story-video/SKILL.md
// 「品質ループ」。Channel Pack は下限を上げられるが下げられない。
// ---------------------------------------------------------------------------------------------

// 手指・身ぶりの安全（人物・本編の画・サムネで共通）。
// 出典: .agents/skills/manga-video-production/references/quality-contract-ja.md「人物と絵」（手、指、腕…
// 指が融合、身体が欠損…なら不合格）、同 references/final-review-ja.md「レビュー項目」anatomyAndPropScale、
// 同 SKILL.md「絶対条件」（人体、手、指…を目視する。機械合格で代用しない）。
// 猥褻・侮辱のジェスチャーが全部の機械ゲートを通って公開面の画に出た事故は、リポジトリの正本に
// まだ節が無い（運営側の記録だけ）。正本へ足す文言は最終報告の SKILL.md の提案に含めた。
const HAND_SAFETY = Object.freeze({
  id: "hand-safety",
  label: "手指・身ぶりの安全",
  weight: 15,
  minimumScore: 100,
  description: "猥褻・侮辱と読める手や指のジェスチャーが無い。指の融合・欠損・本数の破綻、不自然な持ち方が無い。拡大して1本ずつ見る。該当が無ければ 100、1つでもあれば 0",
});

// 画風の一致（人物・背景・本編の画で共通）。
// 出典: quality-contract-ja.md「人物と絵」（背景密度と色は approved visual profile へ合わせる）、
// skills/excalidraw-benchmark-manga-style/references/style-rubric.md（写真のような見た目は致命的）。
const ART_STYLE = Object.freeze({
  id: "art-style-match",
  label: "画風の一致",
  weight: 20,
  minimumScore: 60,
  description: "チャンネルが宣言した画風（線・塗り・色・背景の密度）と揃っている。同じ回の他の画と並べて浮かない",
});

// 人物の同一性（本編の画・サムネ）。人物の設定画は identity-match（下）で見る。
// 出典: quality-contract-ja.md「人物と絵」（人物ごとに承認参照を固定し、年齢段階・髪・顔・体格・服・色・
// 装飾を連続させる／顔型・目・眉・髪シルエット・全身体格を比較する）、同 references/final-review-ja.md
// characterContinuity、config/harnesses/narrated-story-video.harness.json の保証 character-identity
// （機械の顔照合〔pHash など〕では合否を決めない）、lib/mangaCutVideoSubstitution.mjs の人の目視
// （顔の画素指標は本人性を見分けない）。小さく描き足した人物が設定画と別人になる事故は、正本にまだ
// 節が無い（運営側の記録だけ）ので、説明文に「顔が読める大きさ」を入れて採点させる。
const SCENE_IDENTITY = Object.freeze({
  id: "character-identity",
  label: "登場人物の同一性",
  weight: 30,
  minimumScore: 80,
  description: "写っている全員が、参照した承認済みの設定画と同じ人に見える（顔・髪・体型を並べて見る。髪色や服などの属性が合っているだけでは合格にしない）。小さく描かれた人物も顔が読める大きさで、別人になっていない",
});

const CHARACTER_RUBRIC = Object.freeze([
  {
    // 出典: SCENE_IDENTITY と同じ。加えて quality-contract-ja.md「人物と絵」の「variationAxis 文章だけで
    // 差を認定せず」（言葉の上の一致を同一性の根拠にしない）。設定画は以降の全部の画の参照になる。
    id: "identity-match",
    label: "承認済みの設定画との同一人物性",
    weight: 40,
    minimumScore: 80,
    description: "承認済みの設定画と並べて、顔（輪郭・目・眉・口）・髪（形・分け目・色）・体型（頭身・肩幅）が同じ人に見える。髪色や服などの属性が一致するだけでは合格にしない",
  },
  { ...ART_STYLE, weight: 20 },
  {
    // 出典: docs/manga-wardrobe-readiness-spec-ja.md（生成物は原寸 QA: 同一人物性・装飾/ブランド風金具・
    // 意図外変更）、.agents/skills/manga-video-production/SKILL.md「衣装」、quality-contract-ja.md
    // 「人物と絵」（衣装変更は採用顔＋該当衣装を参照にする）。
    id: "wardrobe-match",
    label: "衣装の設定との一致",
    weight: 20,
    minimumScore: 60,
    description: "衣装の設定（形・色・着方・左右・装飾）どおりで、別の服に変わっていない。実在ブランドの金具やロゴが無い",
  },
  { ...HAND_SAFETY, weight: 20 },
]);

const LOCATION_RUBRIC = Object.freeze([
  {
    // 出典: .agents/skills/manga-video-production/SKILL.md「制作手順」4（continuity は承認済み anchor
    // 1枚だけを参照し、建築連続性を別の文脈が原寸で見る）と「場所」（architectureLockPass を目視で判定）。
    id: "layout-match",
    label: "場所の配置表との一致",
    weight: 40,
    minimumScore: 80,
    description: "場所の配置表（入口・帳場・看板・窓・通りの向きなどの位置）と、承認済みの基準画のとおりに並んでいる。カメラを変えても同じ建物・同じ部屋に見える",
  },
  { ...ART_STYLE, weight: 30 },
  {
    // 出典: skills/excalidraw-benchmark-manga-style/references/style-rubric.md（致命的: 3D または写真の
    // ような見た目）、docs/lovart-fal-model-parity.md（モデル指定が効かず写真調で返った実測）。
    // 漫画のジャンルの項目なので、場所の工程は漫画固有として宣言している。
    id: "not-photographic",
    label: "写真調になっていない",
    weight: 30,
    minimumScore: 100,
    description: "写真・実写調・3D の見た目が無い（部分的にでもあれば 0、無ければ 100）",
  },
]);

const SCENE_IMAGE_RUBRIC = Object.freeze([
  {
    // 出典: quality-contract-ja.md「台本と編集」（動詞は主体・進行方向・残された人物が読める画にする、
    // 証拠が実画面にあること）、manga SKILL.md「制作手順」5（発話ごとの意味から構図を設計する）と
    // 「絶対条件」の下限（台本との意味の一致 80）。
    id: "scene-intent-match",
    label: "場面の意図との一致",
    weight: 30,
    minimumScore: 80,
    description: "場面の意図（誰が・どこで・何をしているか、話している人、見せるべき証拠や小道具）がこの1枚で読める。場所の種類や規模が台本とずれていない",
  },
  { ...SCENE_IDENTITY, weight: 30 },
  { ...HAND_SAFETY, weight: 15 },
  { ...ART_STYLE, weight: 25 },
]);

const THUMBNAIL_RUBRIC = Object.freeze([
  {
    // 出典: lib/koyaChannelGovernance.mjs auditKoyaThumbnailPlan の final の確認項目（mobile320x180・
    // primaryEmotionReadable・textCropZero・faceCropZero）。サムネにとっての「意味」なので下限 80。
    id: "readable-at-decided-size",
    label: "決定サイズで読める",
    weight: 20,
    minimumScore: 80,
    description: "チャンネルが決めた表示サイズ（スマホの一覧の小さい表示を含む）で、誰が何をしている絵か・主な感情・文字が読める。顔と文字が端で切れていない",
  },
  {
    // 出典: quality-contract-ja.md「判断ゲートと改善ループ」（2〜5候補へ異なる variationAxis を付ける／
    // variationAxis の文章だけで差を認定しない）、manga SKILL.md「制作手順」4（同じ設計の take 違いを
    // 候補数に数えない）。読める軸の一覧（吹き出し数・場面・構図・ビート・載せ物）は運営側の記録からで、
    // 正本にまだ節が無い。
    id: "distinct-idea-axes",
    label: "別アイデアとして読める差",
    weight: 15,
    minimumScore: 60,
    description: "並べる他の案と、吹き出しの数・場面・構図・ビート（話のどの瞬間か）・載せ物のどれかで差があり、決定サイズで別のアイデアとして読める。書体・帯色・寄り広めだけの差は差に数えない",
  },
  {
    // 出典: .agents/skills/manga-video-production/references/learned-auto.md の自動捕捉 id 86b858191c47
    // （文字の在り処だけを指示すると既定ゴシック・朱ベタ・薄枠の平板が出る）。overlay は証跡ではない
    // （補助指示）ので、正本へ上げる文言を最終報告の SKILL.md の提案に含めた。
    id: "lettering-design",
    label: "文字のレタリングの設計品質",
    weight: 15,
    minimumScore: 60,
    description: "文字入りなら、書体・太細の抑揚・字間・色・担体まで設計された文字になっている。既定のゴシック体を平板な帯や看板に置いただけの仮看板は 40 点以下。文字が無い案は 100",
  },
  { ...SCENE_IDENTITY, weight: 20 },
  { ...HAND_SAFETY, weight: 15 },
  {
    // 出典: lib/koyaChannelGovernance.mjs auditKoyaThumbnailPlan の realLogoZero、manga SKILL.md
    // 「制作手順」4（背景の review は文字/実在ロゴ0）、quality-contract-ja.md「台本と編集」、
    // final-review-ja.md generatedTextArtifacts。
    id: "no-real-brand-logo",
    label: "実在ブランドのロゴが無い",
    weight: 15,
    minimumScore: 100,
    description: "実在の企業・商品・作品のロゴや、それと分かる意匠（形・配色の組み合わせ）が無い。文字の無い意匠も拡大して見る。無ければ 100、あれば 0",
  },
]);

const VOICE_TAKE_RUBRIC = Object.freeze([
  {
    // 出典: .agents/skills/narrated-story-video/references/learned-auto.md の自動捕捉 id fcf0c3ff6772
    // （同じ声 ID でも台詞だけが地の文と違う声に聞こえることがある。overlay は証跡ではない）、
    // docs/koya-voice-quality-runbook-ja.md「⑤⑥ 選定と人間試聴」（UTMOS の順位と人の採用の一致は
    // 2/3 で自動採用の根拠に足りない）、manga SKILL.md「絶対条件」の下限（声 80）。
    id: "voice-continuity",
    label: "直前の地の文との声の連続",
    weight: 50,
    minimumScore: 80,
    description: "直前の地の文（採用済みのテイク）と続けて聞いて、同じ人の声・同じ録り方として続いて聞こえる。声の高さ・太さ・響きが途中で変わらない",
  },
  {
    // 出典: VOICE_TAKE_RUBRIC の voice-continuity と同じ。
    id: "line-fits-context",
    label: "台詞だけ浮いていない",
    weight: 50,
    minimumScore: 80,
    description: "台詞が前後の文から浮いていない（音量・速さ・間・語り口・感情の強さが前後と馴染み、別の場所で録った音に聞こえない）。読みと語尾が正しい",
  },
]);

/**
 * 工程の宣言。
 *   referencePolicy: required（参照必須）/ required-or-exempt（参照か、参照しない理由）/ optional
 *   referenceApproval: 参照を承認済みの一覧で照合するか（声のテイクの参照＝直前の地の文は照合しない）
 *   humanChecks: 人の確認の欄。when=always はいつも、when=references は人物の参照がある版だけ
 *   reviewRequirements: 採点ファイルに要る欄（無ければ記録しない）
 */
const STAGE_SPECS = Object.freeze({
  character: Object.freeze({
    id: "character",
    label: "人物の設定画",
    media: "image",
    rubric: CHARACTER_RUBRIC,
    referencePolicy: "required",
    referenceApproval: true,
    // 人物の設定画は公開面（アイコン・告知・サムネの素材）に出るので手指の安全も人が見る。
    humanChecks: Object.freeze([{ id: "identity", when: "always" }, { id: "hand-safety", when: "always" }]),
    reviewRequirements: Object.freeze(["comparedReferenceSha256s", "identityComparison"]),
    machineGates: Object.freeze(["asset-readable", "reference-approved", "human-rejection-absent"]),
  }),
  location: Object.freeze({
    id: "location",
    label: "背景・場所",
    media: "image",
    rubric: LOCATION_RUBRIC,
    // ナレーション物語には場所の登録簿（location bible）が無い。背景は本編の画の「場面の意図」で採点する。
    genreOnly: "manga",
    referencePolicy: "optional",
    referenceApproval: true,
    humanChecks: Object.freeze([]),
    reviewRequirements: Object.freeze([]),
    machineGates: Object.freeze(["asset-readable", "reference-approved"]),
  }),
  "scene-image": Object.freeze({
    id: "scene-image",
    label: "本編の画",
    media: "image",
    rubric: SCENE_IMAGE_RUBRIC,
    referencePolicy: "required-or-exempt",
    referenceApproval: true,
    humanChecks: Object.freeze([{ id: "identity", when: "references" }]),
    reviewRequirements: Object.freeze(["charactersVisible", "comparedReferenceSha256s", "identityComparison"]),
    machineGates: Object.freeze(["asset-readable", "reference-declared", "reference-approved", "human-rejection-absent"]),
  }),
  thumbnail: Object.freeze({
    id: "thumbnail",
    label: "サムネ",
    media: "image",
    rubric: THUMBNAIL_RUBRIC,
    referencePolicy: "required-or-exempt",
    referenceApproval: true,
    // サムネは公開面の画なので、手指の安全は人物が写っていなくても人が全数を見る。
    humanChecks: Object.freeze([{ id: "identity", when: "references" }, { id: "hand-safety", when: "always" }]),
    reviewRequirements: Object.freeze(["charactersVisible", "comparedReferenceSha256s", "identityComparison", "viewedAtDecidedSize"]),
    machineGates: Object.freeze(["asset-readable", "thumbnail-aspect-16x9", "reference-declared", "reference-approved", "human-rejection-absent"]),
  }),
  "voice-take": Object.freeze({
    id: "voice-take",
    label: "声のテイク",
    media: "audio",
    rubric: VOICE_TAKE_RUBRIC,
    // 参照は直前の地の文の採用テイク（続けて聞くため）。承認一覧の照合はしない。
    referencePolicy: "optional",
    referenceApproval: false,
    humanChecks: Object.freeze([]),
    reviewRequirements: Object.freeze([]),
    // 出典: docs/koya-voice-quality-runbook-ja.md「④ 品質ゲート」（CER fail>0.13、UTMOS fail<2.7、必須の
    // 指標が測れないテイクも hard fail）、lib/narratedStoryVoiceQuality.mjs（必須の指標 utmos・cer）。
    // 測定値はハード・ゲートで、聞いた印象だけを評価者が採点する。
    machineGates: Object.freeze(["asset-readable", "voice-metrics-pass"]),
  }),
});

// 上限の既定（方針値）。
// - 目標 90: 台本の品質ループと同じ。完成動画（92）より低いのは、この後に編集と最終監査がある
// - 回数 4: 漫画の声は全滅時に最大4テイクまで撮る（manga SKILL.md「品質ゲート」音声）。画の QA も
//   初回＋再試行3回で4回。同じ回数で人へ渡す
// - 時間 72 時間: ハーネスの外（web の画像生成）の利用枠が切れると戻るまで待つことがある
// - 停滞 2: 1回の停滞で止めると、別の項目を直す回で止まる
export const ASSET_QUALITY_LIMIT_DEFAULTS = Object.freeze({
  targetScore: 90,
  maximumReviewRounds: 4,
  maximumElapsedMs: 72 * 60 * 60 * 1_000,
  maximumCost: 100,
  minimumImprovement: 1,
  maximumStagnantRounds: 2,
});

const LIMIT_FIELDS = Object.freeze({
  targetScore: { key: "targetScore", minimum: 80, maximum: 100, integer: false },
  maximumReviewRounds: { key: "maximumReviewRounds", minimum: 1, maximum: 10, integer: true },
  maximumElapsedMinutes: { key: "maximumElapsedMs", minimum: 1, maximum: 14 * 24 * 60, integer: false, scale: 60_000 },
  maximumCostUnits: { key: "maximumCost", minimum: 0, maximum: Number.MAX_SAFE_INTEGER, integer: false },
  minimumImprovementPoints: { key: "minimumImprovement", minimum: 0, maximum: 100, integer: false },
  maximumStagnantRounds: { key: "maximumStagnantRounds", minimum: 1, maximum: 5, integer: true },
});

/**
 * 評価者に渡すシートに載せてはいけない項目（合否の判定の材料と、前の回の点数への手がかり）。
 * 評価者に合格点や前回の点を見せると、採点がそれに寄る（合格点のすぐ上に集まる、前回から少しだけ
 * 上げる）。lib/narratedStoryQualityLoop.mjs の NARRATED_REVIEW_SHEET_FORBIDDEN_KEYS と同じ考え方。試験が見る。
 */
export const ASSET_REVIEW_SHEET_FORBIDDEN_KEYS = Object.freeze([
  "targetScore", "minimumScore", "weight", "weights", "floors", "limits", "score", "scores", "bestScore",
  "improvement", "stagnantRounds", "rounds", "floorFailures", "failedGateIds", "failureFingerprint",
  "previousFailureFingerprint", "revisionDelta", "statePath", "revisionDeltaPath", "versions",
  "humanVerifications",
]);

const LABEL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const CONTEXT_ID = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/u;
const CRITERION_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const VOICE_REQUIRED_METRICS = Object.freeze(["utmos", "cer"]);

function nonEmpty(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (plainObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const entry of Object.values(value)) deepFreeze(entry);
  return value;
}

function lastOf(list) {
  return Array.isArray(list) && list.length > 0 ? list[list.length - 1] : null;
}

function boundedNumber(value, minimum, maximum) {
  return typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum;
}

export function assetQualityHarness(harnessId) {
  const spec = ASSET_QUALITY_HARNESSES[String(harnessId || "")];
  if (!spec) throw new Error(`未知のハーネス: ${harnessId}（${Object.keys(ASSET_QUALITY_HARNESSES).join(" / ")}）`);
  return spec;
}

/** 工程の宣言。ハーネスを渡すと、そのハーネスで使えない工程（漫画固有の工程など）を拒否する。 */
export function assetQualityStage(stage, harnessId = "") {
  const spec = STAGE_SPECS[String(stage || "")];
  if (!spec) throw new Error(`未知の工程: ${stage}（${ASSET_STAGES.join(" / ")}）`);
  if (harnessId) {
    const harness = assetQualityHarness(harnessId);
    if (!harness.stages.includes(spec.id)) {
      throw new Error(`工程 ${spec.id}（${spec.label}）は ${harness.id} では使えない`
        + `${spec.genreOnly ? `（${spec.genreOnly} ジャンル固有の工程）` : ""}。使える工程: ${harness.stages.join(" / ")}`);
    }
  }
  return spec;
}

/**
 * Channel Pack の asset-quality.json を検査する。直せない値は blocker にする
 * （黙って既定へ戻すと、Pack の作者は効いているつもりになる）。
 *
 * 形:
 * {
 *   "version": "buzzassist-asset-quality-channel-v1",
 *   "stages": {
 *     "<工程>": {
 *       "criteria": [{ "id", "label", "weight", "minimumScore", "description" }],  // 足す項目
 *       "floors": { "<既定の項目 id>": 下限 },                                        // 上げるだけ
 *       "weights": { "<既定の項目 id>": 重み },
 *       "limits": { "targetScore", "maximumReviewRounds", "maximumElapsedMinutes", ... }
 *     }
 *   }
 * }
 * このハーネスで使えない工程（ナレーション物語の location など）の設定も blocker。
 */
export function normalizeAssetChannelConfig(source, { harnessId } = {}) {
  const harness = assetQualityHarness(harnessId);
  const empty = { stages: {}, blockers: [] };
  if (source === undefined || source === null) return empty;
  if (!plainObject(source)) return { ...empty, blockers: ["asset-quality"] };
  const blockers = [];
  for (const key of Object.keys(source)) {
    if (!["version", "stages"].includes(key)) blockers.push(`asset-quality.${key}-unknown`);
  }
  if (source.version !== ASSET_QUALITY_CHANNEL_CONFIG_VERSION) blockers.push("asset-quality.version");
  const stages = {};
  if (source.stages !== undefined && !plainObject(source.stages)) blockers.push("asset-quality.stages");
  for (const [stageId, stageSource] of Object.entries(plainObject(source.stages) ? source.stages : {})) {
    const prefix = `asset-quality.stages.${stageId}`;
    if (!STAGE_SPECS[stageId]) { blockers.push(`${prefix}-unknown`); continue; }
    if (!harness.stages.includes(stageId)) { blockers.push(`${prefix}-not-in-harness`); continue; }
    if (!plainObject(stageSource)) { blockers.push(prefix); continue; }
    const result = normalizeStageConfig(stageSource, STAGE_SPECS[stageId], prefix);
    blockers.push(...result.blockers);
    stages[stageId] = result.config;
  }
  return { stages, blockers };
}

function normalizeStageConfig(source, spec, prefix) {
  const blockers = [];
  for (const key of Object.keys(source)) {
    if (!["criteria", "floors", "weights", "limits"].includes(key)) {
      blockers.push(key === "rubric" ? `${prefix}.rubric-not-replaceable` : `${prefix}.${key}-unknown`);
    }
  }
  const baseIds = new Set(spec.rubric.map((row) => row.id));
  const baseFloors = new Map(spec.rubric.map((row) => [row.id, row.minimumScore]));
  const criteria = [];
  if (source.criteria !== undefined) {
    if (!Array.isArray(source.criteria) || source.criteria.length > 8) blockers.push(`${prefix}.criteria`);
    else {
      const seen = new Set();
      for (const [index, row] of source.criteria.entries()) {
        const id = nonEmpty(row?.id);
        if (!plainObject(row) || !CRITERION_ID.test(id) || id.length > 48) { blockers.push(`${prefix}.criteria[${index}].id`); continue; }
        if (baseIds.has(id)) { blockers.push(`${prefix}.criteria.${id}-collides-with-default`); continue; }
        if (seen.has(id)) { blockers.push(`${prefix}.criteria.${id}-duplicated`); continue; }
        seen.add(id);
        const label = nonEmpty(row.label);
        const description = nonEmpty(row.description);
        if (!label || Array.from(label).length > 60) blockers.push(`${prefix}.criteria.${id}.label`);
        if (Array.from(description).length < 4 || Array.from(description).length > 300) blockers.push(`${prefix}.criteria.${id}.description`);
        if (!boundedNumber(row.weight, 1, 100)) blockers.push(`${prefix}.criteria.${id}.weight`);
        if (!boundedNumber(row.minimumScore, 0, 100)) blockers.push(`${prefix}.criteria.${id}.minimumScore`);
        criteria.push({ id, label, weight: row.weight, minimumScore: row.minimumScore, description });
      }
    }
  }
  const floors = {};
  if (source.floors !== undefined) {
    if (!plainObject(source.floors)) blockers.push(`${prefix}.floors`);
    else {
      for (const [id, value] of Object.entries(source.floors)) {
        if (!baseIds.has(id)) { blockers.push(`${prefix}.floors.${id}-unknown`); continue; }
        if (!boundedNumber(value, 0, 100)) { blockers.push(`${prefix}.floors.${id}`); continue; }
        // 既定の足切りを番組ごとに緩められると、この保証の意味が無くなる。
        if (value < baseFloors.get(id)) { blockers.push(`${prefix}.floors.${id}-cannot-lower`); continue; }
        floors[id] = value;
      }
    }
  }
  const weights = {};
  if (source.weights !== undefined) {
    if (!plainObject(source.weights)) blockers.push(`${prefix}.weights`);
    else {
      for (const [id, value] of Object.entries(source.weights)) {
        if (!baseIds.has(id)) { blockers.push(`${prefix}.weights.${id}-unknown`); continue; }
        if (!boundedNumber(value, 1, 100)) { blockers.push(`${prefix}.weights.${id}`); continue; }
        weights[id] = value;
      }
    }
  }
  const limits = {};
  if (source.limits !== undefined) {
    if (!plainObject(source.limits)) blockers.push(`${prefix}.limits`);
    else {
      for (const [field, value] of Object.entries(source.limits)) {
        const limit = LIMIT_FIELDS[field];
        if (!limit) { blockers.push(`${prefix}.limits.${field}-unknown`); continue; }
        if (!boundedNumber(value, limit.minimum, limit.maximum) || (limit.integer && !Number.isInteger(value))) {
          blockers.push(`${prefix}.limits.${field}`);
          continue;
        }
        limits[limit.key] = limit.scale ? Math.round(value * limit.scale) : value;
      }
    }
  }
  return { config: { criteria, floors, weights, limits }, blockers };
}

function normalizeChannelSource(source = {}, stageConfig = null) {
  const kind = nonEmpty(source?.kind) || "none";
  // 契約（digest）に入れるのは、この工程の採点に効く設定の指紋と Pack の id だけ。Pack の版や payload
  // 全体の SHA を入れると、声の承認を足しただけで走っている全部の成果物のループが「契約が変わった」で
  // 止まる。版と payload の SHA は状態の provenance に別に残す。
  const stageConfigSha256 = stageConfig ? sha256(canonicalJson(stageConfig)) : null;
  if (kind === "signed-channel-pack") return { kind, packId: nonEmpty(source.packId), stageConfigSha256 };
  if (kind === "unsigned-file") return { kind, stageConfigSha256 };
  return { kind: "none" };
}

/**
 * 成果物の品質契約。走行中は変えない（digest が変われば同じループを続けない）。
 */
export function createAssetQualityContract({ harnessId, stage, channelConfig = null, channelSource = { kind: "none" } } = {}) {
  const harness = assetQualityHarness(harnessId);
  const spec = assetQualityStage(stage, harness.id);
  const channel = normalizeAssetChannelConfig(channelConfig, { harnessId: harness.id });
  if (channel.blockers.length > 0) return { contract: null, blockers: channel.blockers };
  const stageConfig = channel.stages[spec.id] || null;
  const rows = [
    ...spec.rubric.map((row) => ({
      ...row,
      weight: stageConfig?.weights[row.id] ?? row.weight,
      minimumScore: stageConfig?.floors[row.id] ?? row.minimumScore,
      origin: "default",
    })),
    ...(stageConfig?.criteria || []).map((row) => ({ ...row, origin: "channel" })),
  ];
  const rubric = normalizeQualityRubric(rows).map((row, index) => ({ ...row, origin: rows[index].origin }));
  const body = {
    version: ASSET_QUALITY_CONTRACT_VERSION,
    harnessId: harness.id,
    stage: spec.id,
    media: spec.media,
    universalRules: {
      generatorEvaluatorSeparation: true,
      producerContextsExcludedFromEvaluation: true,
      distinctEvaluatorContextRequired: true,
      reviewBoundToAssetSha256: true,
      referencesBoundBySha256: true,
      deterministicGatesBeforeJudgment: true,
      completeRubricRequired: true,
      rubricFloorsRequired: true,
      failureFingerprintRequired: true,
      revisionDeltaRequired: true,
      humanVerificationRequiredForIdentityAndPublicHandSafety: true,
      reviewSheetOmitsTargetFloorsAndPreviousScores: true,
      channelMayOnlyTightenFloors: true,
      immutableDuringRun: true,
    },
    machineGates: [...spec.machineGates],
    humanChecks: spec.humanChecks.map((row) => ({ ...row })),
    referencePolicy: spec.referencePolicy,
    referenceApproval: spec.referenceApproval,
    rubric,
    limits: { ...ASSET_QUALITY_LIMIT_DEFAULTS, ...(stageConfig?.limits || {}) },
    channelSource: normalizeChannelSource(channelSource, stageConfig),
  };
  return { contract: deepFreeze({ ...body, digest: sha256(canonicalJson(body)) }), blockers: [] };
}

/**
 * チャンネル固有の設定の読み込み元を解決する。
 * - channelPack: 署名済み Channel Pack（envelope）。受領側が信頼した公開鍵
 *   （BUZZASSIST_CHANNEL_PACK_PUBLIC_KEY）で検証し、payload/asset-quality.json を読む（無ければ既定だけ）
 * - channelConfig: 署名の無い設定ファイル（手元の試行用）。契約に unsigned-file と刻まれる
 */
export async function loadAssetChannelConfig({
  channelPack = "",
  channelConfig = "",
  env = process.env,
  expectedHarnessId = "",
  verifyEnvelope = verifyChannelPackEnvelope,
  trustedKey = trustedChannelPackKeyFromEnvironment,
} = {}) {
  if (nonEmpty(channelPack) && nonEmpty(channelConfig)) {
    throw new Error("--channel-pack と --channel-config はどちらか1つにしてください。");
  }
  if (nonEmpty(channelPack)) {
    const bundleDir = path.resolve(channelPack);
    const verified = await verifyEnvelope({ bundleDir, ...(await trustedKey(env)), expectedHarnessId });
    let bytes = null;
    try {
      bytes = await readFile(path.join(verified.payloadDir, ASSET_QUALITY_CHANNEL_CONFIG_FILE));
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    return {
      config: bytes ? JSON.parse(bytes.toString("utf8")) : null,
      source: { kind: "signed-channel-pack", packId: verified.id },
      provenance: {
        kind: "signed-channel-pack",
        packId: verified.id,
        packVersion: verified.packVersion,
        payloadSha256: verified.payloadSha256,
        configSha256: bytes ? sha256(bytes) : null,
      },
      spec: { kind: "signed-channel-pack", bundleDir },
    };
  }
  if (nonEmpty(channelConfig)) {
    const file = path.resolve(channelConfig);
    const bytes = await readFile(file);
    return {
      config: JSON.parse(bytes.toString("utf8")),
      source: { kind: "unsigned-file" },
      provenance: { kind: "unsigned-file", configSha256: sha256(bytes) },
      spec: { kind: "unsigned-file", file },
    };
  }
  return { config: null, source: { kind: "none" }, provenance: { kind: "none" }, spec: { kind: "none" } };
}

function channelArgsFromSpec(spec = {}) {
  if (spec.kind === "signed-channel-pack") return { channelPack: spec.bundleDir };
  if (spec.kind === "unsigned-file") return { channelConfig: spec.file };
  return {};
}

/**
 * 作業フォルダの中のファイルだけを受け、フォルダからの相対パス（/ 区切り）を返す。
 * pathApi を差し替えると Windows の区切り（path.win32）でも同じ判定になる（試験が見る）。
 */
export function workDirRelative(workDir, file, label = "ファイル", { pathApi = path } = {}) {
  if (!nonEmpty(file)) throw new Error(`${label} が要ります。`);
  const full = pathApi.resolve(workDir, file);
  const rel = pathApi.relative(workDir, full);
  if (rel === "" || rel === ".." || rel.startsWith(`..${pathApi.sep}`) || pathApi.isAbsolute(rel)) {
    throw new Error(`${label} は成果物の作業フォルダの中に置いてください（状態は作業フォルダからの相対パスで残します）。`);
  }
  return { full, rel: rel.split(pathApi.sep).join("/") };
}

export function assetQualityPaths(workDir, stage = "", subjectId = "") {
  if (!nonEmpty(workDir)) throw new Error("--work-dir に成果物の作業フォルダが要ります。");
  const root = path.resolve(workDir);
  const dir = path.join(root, ASSET_QUALITY_DIR);
  if (!stage && !subjectId) return { workDir: root, dir };
  assetQualityStage(stage);
  const subject = nonEmpty(subjectId);
  if (!LABEL.test(subject)) {
    throw new Error("--subject に成果物の対象 id（英数字と . _ -、64文字まで。人物 id・場所 id・カット id など）が要ります。");
  }
  const base = `${stage}--${subject}`;
  return {
    workDir: root,
    dir,
    statePath: path.join(dir, `${base}.json`),
    revisionDeltaPath: path.join(dir, `${base}.revision-delta.json`),
  };
}

function detectMedia(bytes) {
  if (!bytes || bytes.length === 0) return { media: "empty", format: "" };
  const ascii = (from, to) => bytes.toString("ascii", from, to);
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return { media: "image", format: "png" };
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return { media: "image", format: "jpeg" };
  if (bytes.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return { media: "image", format: "webp" };
  if (bytes.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WAVE") return { media: "audio", format: "wav" };
  if (bytes.length >= 4 && ascii(0, 4) === "fLaC") return { media: "audio", format: "flac" };
  if (bytes.length >= 4 && ascii(0, 4) === "OggS") return { media: "audio", format: "ogg" };
  if (bytes.length >= 3 && ascii(0, 3) === "ID3") return { media: "audio", format: "mp3" };
  if (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) return { media: "audio", format: "mp3" };
  if (bytes.length >= 12 && ascii(4, 8) === "ftyp" && ascii(8, 11) === "M4A") return { media: "audio", format: "m4a" };
  return { media: "unknown", format: "" };
}

async function inspectAsset(file) {
  const bytes = await readFile(file);
  const detected = detectMedia(bytes);
  let dimensions = null;
  if (detected.media === "image") {
    try {
      dimensions = getImageDimensionsFromBuffer(bytes);
    } catch {
      dimensions = null;
    }
  }
  return { sha256: sha256(bytes), bytes: bytes.length, ...detected, dimensions };
}

/** --reference の値（SHA-256 か、ファイル）を SHA の一覧にする。パスは残さない。 */
export async function resolveReferenceSha256s(values = []) {
  const out = [];
  for (const raw of Array.isArray(values) ? values : []) {
    const value = nonEmpty(raw);
    if (!value) continue;
    const sha = SHA256.test(value.toLowerCase()) ? value.toLowerCase() : sha256(await readFile(path.resolve(value)));
    if (!out.includes(sha)) out.push(sha);
  }
  return out;
}

/**
 * 承認済みの参照の一覧（buzzassist-approved-references-v1）。
 * { "version": "buzzassist-approved-references-v1", "references": [{ "sha256": "...", "kind": "..." } | "<sha256>"] }
 * チャンネルの登録簿（承認済みの設定画・場所の基準画）から書き出す。ファイル名では参照を信用しない。
 */
async function loadApprovedReferences(file) {
  if (!nonEmpty(file)) return null;
  const bytes = await readFile(path.resolve(file));
  let body = null;
  try {
    body = JSON.parse(bytes.toString("utf8"));
  } catch {
    return { valid: false, sha256: sha256(bytes), set: new Set() };
  }
  const rows = Array.isArray(body?.references) ? body.references : [];
  const values = rows.map((row) => String(typeof row === "string" ? row : row?.sha256 || "").toLowerCase());
  const valid = body?.version === APPROVED_REFERENCES_VERSION && values.every((value) => SHA256.test(value));
  return { valid, sha256: sha256(bytes), set: new Set(valid ? values : []) };
}

/** 声のテイク: 既存の音声品質ゲートの報告から、このテイクの SHA に結び付いた判定を取り出す。 */
async function voiceMetricsVerdict(file, assetSha) {
  if (!file) return { pass: false, reason: "measurement-missing", metrics: {} };
  let report;
  let reportSha256 = "";
  try {
    const bytes = await readFile(file);
    reportSha256 = sha256(bytes);
    report = JSON.parse(bytes.toString("utf8"));
  } catch {
    return { pass: false, reason: "measurement-unreadable", metrics: {}, reportSha256 };
  }
  const check = (Array.isArray(report?.checks) ? report.checks : [])
    .find((row) => Object.values(row?.inputSha256 || {}).map((value) => String(value).toLowerCase()).includes(assetSha));
  if (!check) return { pass: false, reason: "measurement-not-bound-to-take", metrics: {}, reportSha256 };
  let verdict;
  try {
    verdict = voiceQualityPenalty(check, { requiredMetrics: [...VOICE_REQUIRED_METRICS] });
  } catch {
    return { pass: false, reason: "measurement-invalid", metrics: {}, reportSha256 };
  }
  const metrics = Object.fromEntries(["utmos", "cer"]
    .filter((name) => Number.isFinite(Number(check.metrics?.[name])))
    .map((name) => [name, Number(check.metrics[name])]));
  return {
    pass: verdict.hardFail === false,
    reason: verdict.hardFail === false ? "" : (verdict.missingRequiredMetrics.length > 0 ? "required-metric-missing" : "hard-fail"),
    metrics,
    missingRequiredMetrics: [...verdict.missingRequiredMetrics],
    checkDigest: nonEmpty(check.checkDigest),
    reportSha256,
  };
}

/**
 * この版に要る人の確認（欄の id）。欄はコードの工程の宣言から読む（Channel Pack からも状態ファイルの
 * 写しからも変えられない。状態ファイルを書き換えて欄を消す道を残さないため）。
 */
export function requiredHumanChecks(stage, version) {
  const spec = assetQualityStage(stage);
  const hasReferences = (version?.referenceSha256s || []).length > 0;
  return spec.humanChecks
    .filter((row) => row.when === "always" || (row.when === "references" && hasReferences))
    .map((row) => row.id);
}

/**
 * 成果物の SHA ごとの、人の確認の欄の最新の判定（human-verified の記録だけ。後の記録が前の記録を
 * 上書きする——確認した人が自分の判定を改めることはある）。
 */
function latestHumanVerdicts(state, assetSha256) {
  const latest = new Map();
  for (const row of state?.asset?.humanVerifications || []) {
    if (row.assetSha256 === assetSha256 && row.attestedBy === ASSET_HUMAN_VERIFIED) latest.set(row.check, row);
  }
  return latest;
}

/** 人の確認の欄ごとの状態（その成果物の SHA に結び付いた、human-verified の最新の記録で決める）。 */
export function humanVerificationSummary(state, version) {
  const required = version && state?.asset?.stage ? requiredHumanChecks(state.asset.stage, version) : [];
  const latest = version ? latestHumanVerdicts(state, version.assetSha256) : new Map();
  const verified = required.filter((id) => latest.get(id)?.verdict === "pass");
  const rejected = [...latest.values()].filter((row) => row.verdict === "reject").map((row) => row.check).sort();
  const missing = required.filter((id) => !verified.includes(id) && !rejected.includes(id));
  const rows = (state?.asset?.humanVerifications || []).filter((row) => version && row.assetSha256 === version.assetSha256);
  const uncounted = [...new Set(rows.filter((row) => row.attestedBy !== ASSET_HUMAN_VERIFIED).map((row) => `${row.check}:${row.attestedBy}`))].sort();
  return { required, verified, missing, rejected, uncounted };
}

function effectiveStatus(state, version) {
  if (!state) return "not-started";
  if (state.status !== "passed") return state.status;
  const human = humanVerificationSummary(state, version);
  if (human.rejected.length > 0) return "human-rejected";
  if (human.missing.length > 0) return "awaiting-human-verification";
  return "passed";
}

/**
 * 評価者へ渡す評価シート。何を採点するか（評価項目の id・名前・説明）、点数の尺度、採点を結び付ける
 * 契約の digest、採点する成果物と参照の SHA、採点ファイルに要る欄だけを載せる。合格点・下限・重み・
 * 前の回の点数（とそれが書かれた状態の置き場）は載せない（ASSET_REVIEW_SHEET_FORBIDDEN_KEYS）。
 */
export function assetQualityReviewSheet(contract, { assetSha256 = "", referenceSha256s = [] } = {}) {
  const spec = assetQualityStage(contract.stage);
  const hasReferences = referenceSha256s.length > 0;
  const requirements = spec.reviewRequirements.filter((id) => (
    !["comparedReferenceSha256s", "identityComparison"].includes(id) || hasReferences || spec.referencePolicy === "required"
  ));
  return {
    contractVersion: contract.version,
    contractDigest: contract.digest,
    harnessId: contract.harnessId,
    stage: contract.stage,
    stageLabel: spec.label,
    media: contract.media,
    scale: { minimum: 0, maximum: 100 },
    rubric: contract.rubric.map((row) => ({ id: row.id, label: row.label, description: row.description })),
    asset: { sha256: assetSha256 },
    referenceSha256s: [...referenceSha256s],
    reviewRequirements: requirements.map((id) => ({ id, description: REVIEW_REQUIREMENT_TEXT[id] })),
    independence: "この成果物を作った文脈（作った会話・タスク）と、前の回で採点した文脈では採点できない。新しい文脈で、成果物を原寸で見て（声は聞いて）採点する",
  };
}

const REVIEW_REQUIREMENT_TEXT = Object.freeze({
  charactersVisible: "charactersVisible: 人物が写っているか（true / false）。自分の目で見て答える",
  comparedReferenceSha256s: "comparedReferenceSha256s: 並べて見た参照の SHA（referenceSha256s の全部）",
  identityComparison: "identityComparison: { face, hair, body } それぞれ、参照と並べて何を見たか（属性の一致だけで済ませない）",
  viewedAtDecidedSize: "viewedAtDecidedSize: チャンネルが決めた表示サイズ（スマホの一覧の小さい表示を含む）に縮めて見たか（true）",
});

function issuesFromState(state, version) {
  if (!state) return ["asset-quality-loop-not-started"];
  const status = effectiveStatus(state, version);
  if (status === "passed") return [];
  const round = lastOf(state.rounds);
  const issues = [];
  if (state.status === "passed") {
    const human = humanVerificationSummary(state, version);
    for (const id of human.rejected) issues.push(`asset-quality-human-rejected:${id}`);
    for (const id of human.missing) issues.push(`asset-quality-human-verification-required:${id}`);
    return issues;
  }
  const target = state.asset?.contract?.limits?.targetScore;
  if (round) {
    issues.push(`asset-quality-round-${round.index}-not-passed:${round.failureFingerprint}`);
    for (const id of round.floorFailures || []) issues.push(`asset-quality-floor-failed:${id}`);
    if (Number.isFinite(target) && round.score < target) issues.push(`asset-quality-below-target:${round.score}<${target}`);
    for (const id of round.failedGateIds || []) issues.push(`asset-quality-machine-gate-failed:${id}`);
  }
  if (state.status === "active") issues.push(round ? "asset-quality-revision-and-fresh-review-required" : "asset-quality-first-review-required");
  else issues.push(`asset-quality-stopped:${state.status}:${state.stopReason || "unknown"}`);
  return issues;
}

function nextStepDetail(state, paths, version = lastOf(state?.asset?.versions)) {
  if (!state) return "先に start でループを始める";
  const status = effectiveStatus(state, version);
  if (status === "passed") return "合格した（評価者の採点と、要る人の確認が揃った）。成果物をこの後で変えたら、その合格は今のファイルを保証しない";
  if (status === "awaiting-human-verification") {
    const human = humanVerificationSummary(state, version);
    return `評価者の採点は通った。人の確認（${human.missing.join(", ")}）が要る。確認した人が自分の端末から`
      + " verify --check <欄> --pass --reviewer <名前> --note \"何を見たか\" --human-verified を打つ（機械は人の確認を記録できない）";
  }
  if (status === "human-rejected") {
    return "人の確認で否とされた。この版は合格にならない。直した版で続けるには start --restart --reason \"何を直すか\" で新しいループを始める（前の状態と人の確認の記録は残る）";
  }
  if (state.status !== "active") return `品質ループは ${state.status}（${state.stopReason}）で止まった。続けるかどうかは人が決める`;
  const round = lastOf(state.rounds);
  if (!round) return "最初の版を、作った文脈とは別の評価文脈で採点して record する";
  return `次の版には、前回の失敗指紋（${round.failureFingerprint}）と、それをどう直したかの両方が要る。`
    + ` --previous-failure ${round.failureFingerprint} --revision-delta "直した内容" を付けるか、`
    + `${paths.revisionDeltaPath} に { "previousFailureFingerprint": "${round.failureFingerprint}", "revisionDelta": "直した内容" } を書く。`
    + "採点は、前の回で使っていない評価文脈で行う";
}

function checkFor(state, extra = {}) {
  const round = lastOf(state?.rounds);
  const version = lastOf(state?.asset?.versions);
  const status = effectiveStatus(state, version);
  return {
    pass: status === "passed",
    status,
    loopStatus: state?.status || "not-started",
    stopReason: state?.stopReason || "",
    harnessId: state?.asset?.harnessId || "",
    stage: state?.asset?.stage || "",
    subjectId: state?.asset?.subjectId || "",
    rounds: state?.rounds?.length || 0,
    score: round ? round.score : null,
    targetScore: state?.asset?.contract?.limits?.targetScore ?? null,
    floorFailures: round ? [...(round.floorFailures || [])] : [],
    failedGateIds: round ? [...(round.failedGateIds || [])] : [],
    failureFingerprint: round?.failureFingerprint || "",
    versionLabel: version?.label || "",
    assetSha256: version?.assetSha256 || "",
    contractDigest: state?.contractDigest || "",
    humanVerification: state ? humanVerificationSummary(state, version) : { required: [], verified: [], missing: [], rejected: [], uncounted: [] },
    ...extra,
  };
}

function waiting(state, issues, detail) {
  return { recorded: false, state, issues, detail, check: checkFor(state) };
}

/**
 * ループを始める。既に状態があれば始め直さない（restart は、止まったループと人の確認で否とされた
 * ループだけ。続いているループを始め直せると、回数・停滞の上限を消せてしまう）。始め直しても前の
 * 状態は history に残し、人の確認の記録（成果物の SHA に結び付いた事実）は引き継ぐ。
 */
export async function startAssetQualityLoop({
  workDir,
  harnessId,
  stage,
  subjectId,
  generatorContextId,
  generatorHost = "",
  channelPack = "",
  channelConfig = "",
  restart = false,
  restartReason = "",
  env = process.env,
  now = () => new Date().toISOString(),
  loadChannel = loadAssetChannelConfig,
} = {}) {
  const harness = assetQualityHarness(harnessId);
  const spec = assetQualityStage(stage, harness.id);
  const paths = assetQualityPaths(workDir, spec.id, subjectId);
  const context = nonEmpty(generatorContextId);
  if (!CONTEXT_ID.test(context)) {
    throw new Error("--generator-context に成果物を作る会話・タスクの ID が要ります（英数字と . _ : @ -）。この文脈は採点できない。");
  }
  const channel = await loadChannel({ channelPack, channelConfig, env, expectedHarnessId: harness.id });
  const { contract, blockers } = createAssetQualityContract({
    harnessId: harness.id, stage: spec.id, channelConfig: channel.config, channelSource: channel.source,
  });
  if (!contract) {
    return {
      started: false,
      state: null,
      issues: blockers.map((blocker) => `asset-quality-channel-config-invalid:${blocker}`),
      detail: "Channel Pack の asset-quality.json に直せない値がある。黙って既定へ戻さないので、Pack を直してから始める",
    };
  }
  return withCanvasFileLock(paths.statePath, async () => {
    const existing = await readJsonIfExists(paths.statePath, null);
    let history = [];
    let humanVerifications = [];
    if (existing) {
      if (!restart) {
        return { started: false, state: existing, issues: ["asset-quality-loop-already-started"], detail: "この成果物のループは始まっている。record で回を足すか、止まった後に --restart で始め直す" };
      }
      if (existing.status === "active") {
        return {
          started: false,
          state: existing,
          issues: ["asset-quality-loop-active-cannot-restart"],
          detail: "続いているループは始め直せない（回数と停滞の上限を消せてしまう）。合格・人待ち・上限で止まってから始め直す",
        };
      }
      const reason = sanitizeEvidence(restartReason, 500);
      if (Array.from(reason).length < 4) throw new Error("--restart には --reason で始め直す理由が要ります（何が変わったか）。");
      const { asset: previousAsset, ...previousCore } = existing;
      humanVerifications = [...(previousAsset?.humanVerifications || [])];
      history = [
        ...(previousAsset?.history || []),
        {
          archivedAt: new Date(now()).toISOString(),
          reason,
          status: existing.status,
          effectiveStatus: effectiveStatus(existing, lastOf(previousAsset?.versions)),
          stopReason: existing.stopReason || "",
          contractDigest: existing.contractDigest,
          state: { ...previousCore, asset: { ...previousAsset, history: [], humanVerifications: [] } },
        },
      ];
    }
    const core = createQualityLoopState({
      contract,
      episodeId: `asset-quality:${harness.id}:${spec.id}:${nonEmpty(subjectId)}`,
      generatorHost: nonEmpty(generatorHost),
      generatorId: ASSET_GENERATOR_ID,
      generatorContextId: context,
      startedAt: now(),
    });
    const state = {
      ...core,
      asset: {
        version: ASSET_QUALITY_STATE_VERSION,
        harnessId: harness.id,
        stage: spec.id,
        subjectId: nonEmpty(subjectId),
        contract,
        channelSource: contract.channelSource,
        channelProvenance: channel.provenance || { kind: channel.source?.kind || "none" },
        channelSpec: channel.spec,
        versions: [],
        humanVerifications,
        history,
      },
    };
    await writeJsonAtomic(paths.statePath, state);
    return { started: true, state, issues: [], detail: nextStepDetail(state, paths), check: checkFor(state) };
  });
}

function validateReviewScores(review, contract) {
  const scores = review?.rubricScores;
  if (!plainObject(scores)) return ["rubricScores-missing"];
  const ids = contract.rubric.map((row) => row.id);
  const problems = [];
  for (const id of ids) {
    const value = scores[id];
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100) problems.push(`score-invalid:${id}`);
  }
  for (const id of Object.keys(scores)) if (!ids.includes(id)) problems.push(`score-unknown:${id}`);
  return problems;
}

/** 採点ファイルに要る欄（工程ごと）。足りなければ記録しない（例外ではなく人待ち）。 */
function reviewRequirementProblems(review, spec, referenceSha256s) {
  const problems = [];
  const hasReferences = referenceSha256s.length > 0;
  for (const id of spec.reviewRequirements) {
    if (id === "charactersVisible" && typeof review?.charactersVisible !== "boolean") problems.push("characters-visible-missing");
    if (id === "viewedAtDecidedSize" && review?.viewedAtDecidedSize !== true) problems.push("decided-size-not-viewed");
    if (id === "comparedReferenceSha256s" && hasReferences) {
      const compared = new Set((Array.isArray(review?.comparedReferenceSha256s) ? review.comparedReferenceSha256s : []).map((value) => String(value).toLowerCase()));
      if (referenceSha256s.some((sha) => !compared.has(sha))) problems.push("references-not-compared");
    }
    if (id === "identityComparison" && hasReferences) {
      const comparison = review?.identityComparison;
      const complete = plainObject(comparison) && ["face", "hair", "body"].every((key) => Array.from(sanitizeEvidence(comparison[key], 500)).length >= 4);
      if (!complete) problems.push("identity-comparison-missing");
    }
  }
  return problems;
}

/**
 * 1つの版を、品質ループの1回として記録する。例外は入力の形が壊れているときだけで、人の判断や
 * 直しが要る状態は issues で返す（recorded: false）。
 */
export async function recordAssetQualityRound({
  workDir,
  stage,
  subjectId,
  assetPath,
  versionLabel,
  reviewPath,
  producerContexts = [],
  producerHost = "",
  generationRoute = "",
  references = [],
  referenceExemptReason = "",
  approvedReferencesPath = "",
  measurementPath = "",
  revisionDelta = "",
  previousFailureFingerprint = "",
  blockingCondition = "",
  cost = 0,
  env = process.env,
  now = () => new Date().toISOString(),
  loadChannel = loadAssetChannelConfig,
  captureLearning = null,
} = {}) {
  const spec = assetQualityStage(stage);
  const paths = assetQualityPaths(workDir, spec.id, subjectId);
  const label = nonEmpty(versionLabel);
  if (!LABEL.test(label)) throw new Error("--version に版の名前（英数字と . _ -、64文字まで）が要ります。");
  const asset = workDirRelative(paths.workDir, assetPath, "--asset");
  const reviewFile = workDirRelative(paths.workDir, reviewPath, "--review");
  const measurementFile = nonEmpty(measurementPath) ? workDirRelative(paths.workDir, measurementPath, "--measurement") : null;
  const producers = [...new Set((Array.isArray(producerContexts) ? producerContexts : [producerContexts]).map((value) => nonEmpty(value)).filter(Boolean))];
  if (producers.length === 0) throw new Error("--producer-context にこの版を作った会話・タスクの ID が要ります（この文脈は採点できない）。");
  for (const producer of producers) {
    if (!CONTEXT_ID.test(producer)) throw new Error("--producer-context は会話・タスクの ID（英数字と . _ : @ -）にしてください。");
  }
  const host = nonEmpty(producerHost);
  if (!LABEL.test(host)) throw new Error("--producer-host にこの版を作ったホスト（claude-code / codex / human など）が要ります。");
  const route = nonEmpty(generationRoute);
  if (!Object.hasOwn(ASSET_GENERATION_ROUTES, route)) {
    throw new Error(`--route は宣言した生成の経路から選んでください: ${Object.keys(ASSET_GENERATION_ROUTES).join(" / ")}`);
  }
  const referenceSha256s = await resolveReferenceSha256s(references);
  const exemptReason = sanitizeEvidence(referenceExemptReason, 300);

  return withCanvasFileLock(paths.statePath, async () => {
    const existing = await readJsonIfExists(paths.statePath, null);
    if (!existing?.asset) return waiting(null, ["asset-quality-loop-not-started"], "先に start でループを始める");
    if (existing.asset.stage !== spec.id) throw new Error("状態ファイルの工程が --stage と違います。");

    // 契約は走行中に変えない。採点に使うのは状態ファイルの写しではなく、いま作り直した契約
    // （digest が一致したもの）。状態ファイルの写しを書き換えて評価項目や下限を緩める道を残さないため。
    let contract = null;
    try {
      const channel = await loadChannel({ ...channelArgsFromSpec(existing.asset.channelSpec), env, expectedHarnessId: existing.asset.harnessId });
      contract = createAssetQualityContract({
        harnessId: existing.asset.harnessId, stage: spec.id, channelConfig: channel.config, channelSource: channel.source,
      }).contract;
    } catch (error) {
      return waiting(existing, ["asset-quality-channel-config-unavailable"], `始めたときの Channel Pack の設定を読み直せない: ${sanitizeEvidence(error?.message || String(error), 300)}`);
    }
    if (!contract || contract.digest !== existing.contractDigest) {
      return waiting(existing, ["asset-quality-contract-changed"], "このループは別の契約（評価項目・下限・上限・Pack の設定）で始まっている。続けるか始め直すかは人が決める");
    }

    const assetInfo = await inspectAsset(asset.full);
    const reviewBytes = await readFile(reviewFile.full);
    const reviewSha256 = sha256(reviewBytes);
    let review;
    try {
      review = JSON.parse(reviewBytes.toString("utf8"));
    } catch {
      return waiting(existing, ["asset-quality-review-unreadable"], "採点ファイルが JSON として読めない");
    }
    const versions = existing.asset.versions || [];
    const previousVersion = lastOf(versions);

    // 同じ採点で既に記録した回なら、記録し直さずにその結果を返す（再実行・二重起動）。
    if (previousVersion && previousVersion.reviewSha256 === reviewSha256 && previousVersion.assetSha256 === assetInfo.sha256) {
      return { recorded: false, alreadyRecorded: true, state: existing, issues: issuesFromState(existing, previousVersion), detail: nextStepDetail(existing, paths), check: checkFor(existing) };
    }
    if (existing.status === "passed") {
      const changed = previousVersion && previousVersion.assetSha256 !== assetInfo.sha256;
      return waiting(
        existing,
        ["asset-quality-loop-already-passed", ...(changed ? ["asset-quality-asset-changed-after-pass"] : [])],
        "このループは評価者の採点で合格して止まっている。成果物を変えたなら、start --restart --reason \"何を変えたか\" で新しいループを始める",
      );
    }
    if (existing.status !== "active") return waiting(existing, issuesFromState(existing, previousVersion), nextStepDetail(existing, paths));
    if (versions.some((row) => row.label === label)) {
      return waiting(existing, [`asset-quality-version-label-reused:${label}`], "版の名前は回ごとに変える（同じ名前の版は既に採点した）");
    }
    const sameBytes = versions.find((row) => row.assetSha256 === assetInfo.sha256);
    if (sameBytes) {
      return waiting(existing, [`asset-quality-asset-unchanged:${sameBytes.label}`], `この成果物は版 ${sameBytes.label} と同じバイト列。直していない版を別の評価者に採点し直させない`);
    }
    if (String(review?.assetSha256 || "").toLowerCase() !== assetInfo.sha256) {
      return waiting(existing, ["asset-quality-review-asset-mismatch"], "採点ファイルの assetSha256 が今の成果物と違う。今の成果物を採点し直す");
    }

    // 参照の宣言（工程ごと）。人物の設定画は参照が必須、本編の画とサムネは参照か参照しない理由。
    if (spec.referencePolicy === "required" && referenceSha256s.length === 0) {
      return waiting(existing, ["asset-quality-reference-required"], "この工程は、参照に使った承認済みの画を --reference で渡す（SHA かファイル）");
    }
    if (spec.referencePolicy === "required-or-exempt" && referenceSha256s.length === 0 && Array.from(exemptReason).length < 4) {
      return waiting(existing, ["asset-quality-reference-required-or-exempt"], "人物が写るなら --reference で承認済みの設定画を渡す。写らないなら --reference-exempt-reason で理由を書く");
    }

    const evaluatorId = nonEmpty(review?.evaluatorId);
    const evaluatorContextId = nonEmpty(review?.evaluatorContextId);
    if (!evaluatorId || !CONTEXT_ID.test(evaluatorContextId)) {
      return waiting(existing, ["asset-quality-review-evaluator-missing"], "採点ファイルに evaluatorId と evaluatorContextId（評価した会話・タスクの ID）が要る");
    }
    // 作った文脈: start の文脈・この版を作った文脈・前の版を作った文脈（作り手の系列は全部）。
    const producerSet = new Set([
      existing.generatorContextId,
      ...producers,
      ...versions.flatMap((row) => row.producerContexts || []),
    ]);
    if (evaluatorId === ASSET_GENERATOR_ID || producerSet.has(evaluatorContextId)) {
      return waiting(existing, ["asset-quality-evaluator-not-independent"], "この成果物を作った文脈は採点できない（同じなら記録しない）。別の文脈で採点する");
    }
    const usedContexts = new Set((existing.rounds || []).flatMap((round) => (round.reviews || []).map((row) => row.evaluatorContextId)));
    if (usedContexts.has(evaluatorContextId)) {
      return waiting(existing, ["asset-quality-fresh-review-required"], "この評価文脈は前の回で採点している。回ごとに新しい文脈で採点する");
    }
    const scoreProblems = validateReviewScores(review, contract);
    if (scoreProblems.length > 0) {
      return waiting(existing, scoreProblems.map((problem) => `asset-quality-review-${problem}`), `採点ファイルの rubricScores は全項目（${contract.rubric.map((row) => row.id).join(", ")}）を 0〜100 で埋める`);
    }
    const requirementProblems = reviewRequirementProblems(review, spec, referenceSha256s);
    if (requirementProblems.length > 0) {
      return waiting(existing, requirementProblems.map((problem) => `asset-quality-review-${problem}`), "採点ファイルに、この工程で要る欄（sheet の reviewRequirements）を埋める");
    }
    const notes = sanitizeEvidence(review.notes);
    if (Array.from(notes).length < 4) return waiting(existing, ["asset-quality-review-notes-required"], "採点ファイルの notes に、何を見て（聞いて）どう判断したかを書く");

    // 2回目以降は、前回の失敗指紋と直しの差分の両方が要る。
    let revision = {};
    if ((existing.rounds || []).length > 0) {
      const expected = lastOf(existing.rounds).failureFingerprint;
      let text = sanitizeEvidence(revisionDelta);
      let fingerprint = nonEmpty(previousFailureFingerprint);
      if (!text || !fingerprint) {
        const delta = await readJsonIfExists(paths.revisionDeltaPath, null).catch(() => null);
        if (!text) text = sanitizeEvidence(delta?.revisionDelta);
        if (!fingerprint) fingerprint = nonEmpty(delta?.previousFailureFingerprint);
      }
      if (Array.from(text).length < 4) {
        return waiting(existing, [`asset-quality-revision-delta-required:${expected}`], nextStepDetail(existing, paths));
      }
      if (fingerprint !== expected) {
        return waiting(existing, [`asset-quality-previous-failure-mismatch:${expected}`], `直しの差分は、直前の回の失敗指紋（${expected}）を指す。${nextStepDetail(existing, paths)}`);
      }
      revision = { previousFailureFingerprint: expected, revisionDelta: text };
    }

    // 機械ゲート（ファイル・承認一覧・音声品質ゲートの報告だけから決まる）。
    const approved = spec.referenceApproval && referenceSha256s.length > 0 ? await loadApprovedReferences(approvedReferencesPath) : null;
    const voice = spec.machineGates.includes("voice-metrics-pass") ? await voiceMetricsVerdict(measurementFile?.full || "", assetInfo.sha256) : null;
    const humanRejected = [...latestHumanVerdicts(existing, assetInfo.sha256).values()].some((row) => row.verdict === "reject");
    const dimensions = assetInfo.dimensions;
    const gates = {
      "asset-readable": assetInfo.media === spec.media,
      "reference-declared": !(review?.charactersVisible === true && referenceSha256s.length === 0),
      "reference-approved": !spec.referenceApproval || referenceSha256s.length === 0
        || Boolean(approved?.valid && referenceSha256s.every((sha) => approved.set.has(sha))),
      "human-rejection-absent": !humanRejected,
      "thumbnail-aspect-16x9": Boolean(dimensions && dimensions.width >= 1280 && dimensions.height > 0
        && Math.abs(dimensions.width / dimensions.height - 16 / 9) <= 0.01 * (16 / 9)),
      "voice-metrics-pass": voice?.pass === true,
    };
    const machineGates = Object.fromEntries(contract.machineGates.map((id) => [id, gates[id] === true]));
    const failedGateIds = contract.machineGates.filter((id) => gates[id] !== true).sort();

    const observedAt = now();
    const assetRow = { path: asset.rel, sha256: assetInfo.sha256, note: `この回に採点した成果物（${spec.label}・版 ${label}）` };
    const evidence = [
      assetRow,
      { path: reviewFile.rel, sha256: reviewSha256, note: "別の評価文脈の採点ファイル（評価項目の点数つき）" },
      ...referenceSha256s.map((sha) => ({ path: `reference:${sha.slice(0, 12)}`, sha256: sha, note: "参照に使った画（承認済みの一覧で照合する）" })),
      ...(approved ? [{ path: "approved-references", sha256: approved.sha256, note: "承認済みの参照の一覧" }] : []),
      ...(measurementFile && voice?.reportSha256 ? [{ path: measurementFile.rel, sha256: voice.reportSha256, note: "音声品質ゲートの報告（CER・UTMOS）" }] : []),
    ];
    let recorded;
    try {
      recorded = recordQualityRound({
        contract,
        state: existing,
        hardGateReport: { pass: failedGateIds.length === 0, failedGateIds, contractDigest: contract.digest },
        reviews: [{
          evaluatorId,
          evaluatorContextId,
          evaluatorHost: nonEmpty(review.evaluatorHost),
          scores: review.rubricScores,
          notes,
          evidence: [assetRow],
        }],
        evidence,
        reviewDigest: reviewSha256,
        cost: Math.max(0, Number(cost) || 0),
        observedAt,
        blockingCondition: nonEmpty(blockingCondition) || nonEmpty(review.blockingCondition),
        ...revision,
      });
    } catch (error) {
      return waiting(existing, ["asset-quality-round-rejected"], `この採点は品質ループの回として記録できない: ${sanitizeEvidence(error?.message || String(error), 300)}`);
    }
    const version = {
      round: recorded.rounds.length,
      label,
      assetPath: asset.rel,
      assetSha256: assetInfo.sha256,
      assetBytes: assetInfo.bytes,
      media: assetInfo.media,
      format: assetInfo.format,
      ...(dimensions ? { dimensions: { width: dimensions.width, height: dimensions.height } } : {}),
      producerContexts: producers,
      producerHost: host,
      generationRoute: route,
      referenceSha256s,
      ...(referenceSha256s.length === 0 && exemptReason ? { referenceExemptReason: exemptReason } : {}),
      ...(approved ? { approvedReferencesSha256: approved.sha256 } : {}),
      ...(typeof review.charactersVisible === "boolean" ? { charactersVisible: review.charactersVisible } : {}),
      ...(voice ? { voiceMetrics: voice.metrics, voiceMetricsReason: voice.reason } : {}),
      reviewPath: reviewFile.rel,
      reviewSha256,
      evaluatorId,
      evaluatorContextId,
      evaluatorHost: nonEmpty(review.evaluatorHost),
      machineGates,
      // 項目ごとの点。学習の自動捕捉が「どの項目が低かったか」を本文なしで言うのに使う。
      rubricScores: Object.fromEntries(contract.rubric.map((row) => [row.id, review.rubricScores[row.id]])),
      findings: (Array.isArray(review.findings) ? review.findings : []).map((entry) => sanitizeEvidence(entry, 500)).filter(Boolean).slice(0, 50),
      recordedAt: new Date(observedAt).toISOString(),
    };
    const next = { ...recorded, asset: { ...recorded.asset, versions: [...versions, version] } };
    await writeJsonAtomic(paths.statePath, next);
    const stateSha256 = sha256(await readFile(paths.statePath));
    const round = lastOf(next.rounds);
    let learning = null;
    if (next.status !== "passed" && typeof captureLearning === "function") {
      // 学習の捕捉に失敗しても、回の記録は変えない。
      try {
        learning = await captureLearning({ event: "round", state: next, round, version, contract });
      } catch (error) {
        learning = { captured: 0, skippedReason: "capture-failed", detail: sanitizeEvidence(error?.message || String(error), 200) };
      }
    }
    const status = effectiveStatus(next, version);
    return {
      recorded: true,
      state: next,
      round,
      version,
      issues: issuesFromState(next, version),
      detail: next.status === "passed"
        ? `品質ループ ${next.rounds.length} 回目（版 ${label}）で評価者の採点が合格（${round.score} ≥ ${contract.limits.targetScore}、下限割れなし、機械ゲート全通過）。`
          + `${status === "passed" ? "人の確認も揃っている" : nextStepDetail(next, paths, version)}`
        : `品質ループ ${next.rounds.length} 回目（版 ${label}）は不合格（${round.score}/${contract.limits.targetScore}`
          + `${round.floorFailures.length ? `、下限割れ: ${round.floorFailures.join(", ")}` : ""}`
          + `${round.failedGateIds.length ? `、落ちた機械ゲート: ${round.failedGateIds.join(", ")}` : ""}）。${nextStepDetail(next, paths, version)}`,
      check: checkFor(next, { stateSha256 }),
      learning,
    };
  });
}

/**
 * 人の確認を記録する（人物の同一性・手指の安全）。成果物の SHA に結び付ける。
 * 人の確認として数えるのは、対話端末から --human-verified を付けた記録（human-verified）だけ。
 * --agent-attested は agent-self-attested として残るが数えない。判定は scripts/harness-learn.mjs の
 * attestationFor（harness-learn の promote/apply と同じ一つの実装）を使う。
 */
export async function recordAssetHumanVerification({
  workDir,
  stage,
  subjectId,
  assetPath,
  checks = [],
  verdict = "",
  reviewer = "",
  note = "",
  humanVerified = false,
  agentAttested = false,
  isInteractive = false,
  now = () => new Date().toISOString(),
  captureLearning = null,
  attest = null,
} = {}) {
  const spec = assetQualityStage(stage);
  const paths = assetQualityPaths(workDir, spec.id, subjectId);
  if (spec.humanChecks.length === 0) throw new Error(`工程 ${spec.id}（${spec.label}）には人の確認の欄が無い。`);
  const allowed = spec.humanChecks.map((row) => row.id);
  const wanted = [...new Set((Array.isArray(checks) ? checks : [checks]).map((value) => nonEmpty(value)).filter(Boolean))];
  if (wanted.length === 0) throw new Error(`--check に確認した欄を1つ以上（${allowed.join(" / ")}）。`);
  for (const id of wanted) if (!allowed.includes(id)) throw new Error(`--check ${id} はこの工程の欄に無い（${allowed.join(" / ")}）。`);
  if (!["pass", "reject"].includes(verdict)) throw new Error("--pass か --reject のどちらかが要ります。");
  const text = sanitizeEvidence(note, 500);
  if (Array.from(text).length < 4) throw new Error("--note に、何を見てどう判断したかを書いてください。");
  const attestationFor = attest || (await import("../scripts/harness-learn.mjs")).attestationFor;
  const verdictOfAttestation = attestationFor({ reviewer, isInteractive, agentAttested, humanVerified });
  if (!verdictOfAttestation.ok) throw new Error(verdictOfAttestation.message);
  const attestation = verdictOfAttestation.attestation;
  const asset = workDirRelative(paths.workDir, assetPath, "--asset");
  const assetSha256 = sha256(await readFile(asset.full));
  return withCanvasFileLock(paths.statePath, async () => {
    const existing = await readJsonIfExists(paths.statePath, null);
    if (!existing?.asset) return waiting(null, ["asset-quality-loop-not-started"], "先に start でループを始める");
    const recordedAt = new Date(now()).toISOString();
    const rows = wanted.map((check) => ({
      check,
      verdict,
      assetSha256,
      assetPath: asset.rel,
      reviewer: attestation.reviewer,
      attestedBy: attestation.attestedBy,
      ...(attestation.claimedReviewer ? { claimedReviewer: attestation.claimedReviewer } : {}),
      note: text,
      recordedAt,
    }));
    const next = { ...existing, asset: { ...existing.asset, humanVerifications: [...(existing.asset.humanVerifications || []), ...rows] } };
    await writeJsonAtomic(paths.statePath, next);
    const counted = attestation.attestedBy === ASSET_HUMAN_VERIFIED;
    let learning = null;
    if (counted && verdict === "reject" && typeof captureLearning === "function") {
      try {
        const version = (next.asset.versions || []).find((row) => row.assetSha256 === assetSha256) || null;
        learning = await captureLearning({ event: "human-rejection", state: next, version, verifications: rows, contract: next.asset.contract });
      } catch (error) {
        learning = { captured: 0, skippedReason: "capture-failed", detail: sanitizeEvidence(error?.message || String(error), 200) };
      }
    }
    const version = lastOf(next.asset.versions);
    return {
      recorded: true,
      counted,
      verifications: rows,
      state: next,
      issues: counted ? issuesFromState(next, version) : [`asset-quality-human-verification-not-counted:${attestation.attestedBy}`, ...issuesFromState(next, version)],
      detail: counted
        ? `人の確認（${wanted.join(", ")}: ${verdict === "pass" ? "可" : "否"}）を成果物 ${assetSha256.slice(0, 12)} に記録した。${nextStepDetail(next, paths, version)}`
        : `記録は ${attestation.attestedBy} として残したが、人の確認には数えない。確認した人が自分の端末から --human-verified を付けて打つ`,
      check: checkFor(next),
      learning,
    };
  });
}

/**
 * 今の状態。pass は「評価者の採点で合格し、要る人の確認が揃い、合格した版の成果物ファイルが今も
 * 同じバイト列」のときだけ true。assetPath を渡すと、そのファイルが合格した版と同じかも見る
 * （使おうとしている成果物が、合格した版そのものであることを呼び出し側が確かめるため）。
 */
export async function assetQualityStatus({ workDir, stage, subjectId, assetPath = "" } = {}) {
  const spec = assetQualityStage(stage);
  const paths = assetQualityPaths(workDir, spec.id, subjectId);
  const state = await readJsonIfExists(paths.statePath, null);
  if (!state?.asset) {
    return { started: false, pass: false, issues: ["asset-quality-loop-not-started"], detail: nextStepDetail(null, paths), check: checkFor(null) };
  }
  const version = lastOf(state.asset.versions);
  let currentSha256 = "";
  if (version) {
    try {
      currentSha256 = sha256(await readFile(path.resolve(paths.workDir, version.assetPath)));
    } catch {
      currentSha256 = "";
    }
  }
  const unchanged = Boolean(version) && currentSha256 === version.assetSha256;
  const issues = issuesFromState(state, version);
  if (version && !unchanged) issues.push(currentSha256 ? "asset-quality-asset-changed-after-review" : "asset-quality-asset-missing");
  let candidateMatches = true;
  let candidateSha256 = "";
  if (nonEmpty(assetPath)) {
    const candidate = path.resolve(paths.workDir, assetPath);
    try {
      candidateSha256 = sha256(await readFile(candidate));
    } catch {
      candidateSha256 = "";
    }
    candidateMatches = Boolean(version) && candidateSha256 === version.assetSha256;
    if (!candidateMatches) issues.push(candidateSha256 ? "asset-quality-candidate-not-reviewed-version" : "asset-quality-candidate-missing");
  }
  const pass = effectiveStatus(state, version) === "passed" && unchanged && candidateMatches;
  return {
    started: true,
    pass,
    deliverable: pass,
    state,
    issues,
    detail: nextStepDetail(state, paths, version),
    check: checkFor(state, {
      pass,
      currentAssetSha256: currentSha256,
      assetUnchangedSinceReview: unchanged,
      ...(nonEmpty(assetPath) ? { candidateAssetSha256: candidateSha256, candidateIsReviewedVersion: candidateMatches } : {}),
    }),
    rounds: (state.rounds || []).map((round, index) => ({
      index: round.index,
      version: state.asset.versions[index]?.label || "",
      route: state.asset.versions[index]?.generationRoute || "",
      score: round.score,
      floorFailures: round.floorFailures,
      failedGateIds: round.failedGateIds,
      failureFingerprint: round.failureFingerprint,
      evaluatorContextId: round.reviews?.[0]?.evaluatorContextId || "",
    })),
  };
}

/**
 * assetQualityStatus の結果を理由コードへ写す対応（ジャンル共通の1か所）。照合する側（使う前の照合
 * lib/assetQualityUseGate.mjs、ナレーション物語の関門 lib/narratedStoryAssetLoops.mjs）は、ここで決めた理由を
 * 語彙で選ぶだけで、ループの issues や状態名を自分では読まない（試験が見る）。
 *
 * 2つの語彙は、一本化する前にそれぞれの照合が外へ出していた文字列そのもの（Job・監査・試験が見ている）:
 *   before-use  使う前の照合（漫画の全工程・ナレーション物語のサムネ）。使うファイルの食い違い（無い・
 *               合格した版と違う）を先に言い、ループの状態は not-passed にまとめる
 *               loop-not-started / not-passed / asset-sha-mismatch / asset-missing
 *   loop-state  ナレーション物語の関門。ループの状態を細かく言い（次に何をすれば進むか）、使うファイルの
 *               食い違いはループが合格しているときだけ言う
 *               loop-not-started / review-required / revision-required / human-verification-required:<欄>
 *               / human-rejected:<欄> / loop-stopped:<状態> / sha256-mismatch / asset-missing
 * 合格（pass === true）はどちらも passed。
 *
 * 状態を読めなかった（loop-unreadable）・作業フォルダの外（outside-work-dir）・取り込みの記録が無い
 * （record-required）のような、状態を得る前に照合側が止める理由は、その照合の理由であってここでは写さない。
 */
export const ASSET_QUALITY_REASON_VOCABULARIES = Object.freeze({
  "before-use": Object.freeze({
    reasons: Object.freeze(["loop-not-started", "not-passed", "asset-sha-mismatch", "asset-missing"]),
    precedence: "asset",
    asset: Object.freeze({ missing: "asset-missing", mismatch: "asset-sha-mismatch" }),
  }),
  "loop-state": Object.freeze({
    reasons: Object.freeze([
      "loop-not-started", "review-required", "revision-required", "human-verification-required:<欄>",
      "human-rejected:<欄>", "loop-stopped:<状態>", "sha256-mismatch", "asset-missing",
    ]),
    precedence: "loop",
    asset: Object.freeze({ missing: "asset-missing", mismatch: "sha256-mismatch" }),
  }),
});

// 使うファイルの食い違い（assetQualityStatus の issues）。無い方を先に見る。
function assetDiscrepancy(issues) {
  if (issues.includes("asset-quality-asset-missing") || issues.includes("asset-quality-candidate-missing")) return "missing";
  if (issues.includes("asset-quality-candidate-not-reviewed-version") || issues.includes("asset-quality-asset-changed-after-review")) return "mismatch";
  return "";
}

// ループの状態（effectiveStatus）から、次に要ることを言う理由。
function loopStateReason(check) {
  const human = check?.humanVerification || {};
  switch (check?.status) {
    case "passed":
      return "passed";
    case "awaiting-human-verification":
      return `human-verification-required:${(human.missing || []).join("+") || "unknown"}`;
    case "human-rejected":
      return `human-rejected:${(human.rejected || []).join("+") || "unknown"}`;
    case "active":
      return Number(check.rounds) > 0 ? "revision-required" : "review-required";
    default:
      return `loop-stopped:${check?.status || "unknown"}`;
  }
}

/** assetQualityStatus の結果 → 理由コード（上の語彙から選ぶ。既定は loop-state）。 */
export function assetQualityReasonCode(status, { vocabulary = "loop-state" } = {}) {
  const spec = ASSET_QUALITY_REASON_VOCABULARIES[vocabulary];
  if (!spec) throw new Error(`未知の理由の語彙: ${vocabulary}（${Object.keys(ASSET_QUALITY_REASON_VOCABULARIES).join(" / ")}）`);
  if (status?.pass === true) return "passed";
  if (!status?.started) return "loop-not-started";
  const asset = assetDiscrepancy(Array.isArray(status.issues) ? status.issues : []);
  const loop = loopStateReason(status.check || {});
  if (spec.precedence === "asset") return asset ? spec.asset[asset] : "not-passed";
  // ループは合格しているのに使えない＝使うファイルが合格した版ではない（食い違いの記録が無くても版違いとして言う）。
  if (loop === "passed") return spec.asset[asset || "mismatch"];
  return loop;
}

/** 作業フォルダの全部の成果物のループ（stage で絞れる）。pass は1件以上あって全部が合格のときだけ。 */
export async function listAssetQualityStatus({ workDir, stage = "" } = {}) {
  const paths = assetQualityPaths(workDir);
  if (stage) assetQualityStage(stage);
  let names = [];
  try {
    names = await readdir(paths.dir);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const entries = [];
  for (const name of names.sort()) {
    if (!name.endsWith(".json") || name.endsWith(".revision-delta.json")) continue;
    // 工程名で前方一致させる（対象 id に "--" が入っていても工程と取り違えない）。
    const stageId = ASSET_STAGES.find((id) => name.startsWith(`${id}--`));
    if (!stageId || (stage && stageId !== stage)) continue;
    const subjectId = name.slice(stageId.length + 2, -".json".length);
    if (!LABEL.test(subjectId)) continue;
    const status = await assetQualityStatus({ workDir: paths.workDir, stage: stageId, subjectId });
    entries.push({ stage: stageId, subjectId, pass: status.pass, status: status.check.status, issues: status.issues });
  }
  return {
    started: entries.length > 0,
    pass: entries.length > 0 && entries.every((entry) => entry.pass),
    entries,
    issues: entries.length === 0 ? ["asset-quality-loop-not-started"] : entries.filter((entry) => !entry.pass).map((entry) => `asset-quality-not-passed:${entry.stage}:${entry.subjectId}:${entry.status}`),
  };
}

/** 評価者へ渡す評価シートと、採点ファイルの雛形。assetSha256 はここで計算して埋める。 */
export async function assetQualityReviewTemplate({ workDir, stage, subjectId, assetPath, references = [] } = {}) {
  const spec = assetQualityStage(stage);
  const paths = assetQualityPaths(workDir, spec.id, subjectId);
  const state = await readJsonIfExists(paths.statePath, null);
  if (!state?.asset) throw new Error("先に start でループを始めてください。");
  const asset = workDirRelative(paths.workDir, assetPath, "--asset");
  const info = await inspectAsset(asset.full);
  const referenceSha256s = await resolveReferenceSha256s(references);
  const sheet = assetQualityReviewSheet(state.asset.contract, { assetSha256: info.sha256, referenceSha256s });
  const requirement = new Set(sheet.reviewRequirements.map((row) => row.id));
  return {
    sheet,
    template: {
      evaluatorId: `<評価者の名前（作る係の ${ASSET_GENERATOR_ID} は不可）>`,
      evaluatorContextId: "<この採点をする会話・タスクの ID（作った文脈・前の回の文脈は不可）>",
      evaluatorHost: "<claude-code|codex|human>",
      assetSha256: info.sha256,
      ...(requirement.has("charactersVisible") ? { charactersVisible: null } : {}),
      ...(requirement.has("viewedAtDecidedSize") ? { viewedAtDecidedSize: null } : {}),
      ...(requirement.has("comparedReferenceSha256s") ? { comparedReferenceSha256s: [] } : {}),
      ...(requirement.has("identityComparison") ? { identityComparison: { face: "", hair: "", body: "" } } : {}),
      rubricScores: Object.fromEntries(state.asset.contract.rubric.map((row) => [row.id, null])),
      notes: "<何を見て（聞いて）、どう判断したか>",
      findings: [],
    },
  };
}
