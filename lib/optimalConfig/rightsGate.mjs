// 権利の関門（6層）——構成表のモデルを、使い方と実行場所ごとに機械的に止める。
//
// 層は調査の権利表と同じ A〜F:
//   A コード / B 重みと全依存 / C 出力 / D ホスト・再販 / E 素材と人物 / F データの扱い
//
// 機械的に止めるもの（blocks）:
//   - 重みが非商用・研究用なのに、運営者の本番（収益のあるチャンネル）で使う
//   - 生成物まで非商用（NoobAI）
//   - 地域の制限が出力にまで及び、全世界の YouTube に出す（HunyuanImage、MiniMax H3）
//   - 顔の重みが非商用（InstantID／PuLID の InsightFace）
//   - プロのアニメ制作は売上に関係なく別許諾（Pony V7）、派生の条件が重い（Illustrious v0）
//   - サービスとしての提供が禁止されたモデルを、オトシゴのサーバーで動かす
//     （運営者の手元で使う分には止めない）
//   - オトシゴのサーバーで画像・動画を生成・中継する（方針として常に止める）
//   - 外に出せない素材があるのに、外部へ送る経路を使う
// 確定できないもの（unverified・conditional）は止めずに warnings に出す。黙って通さない。
//
// これは法的助言ではない。調査資料（2026-10-22 時点、公式資料を読んだだけ）の記載を
// 機械的な判定に写したもので、最終的な利用形態は権利者や専門家と確認する。

import { findModel, findRuntimePlace } from "./catalog.mjs";

export const RIGHTS_GATE_VERSION = "optimal-config-rights-gate-v1";

export const RIGHTS_BLOCK_CODES = Object.freeze({
  WEIGHTS_NON_COMMERCIAL: "WEIGHTS_NON_COMMERCIAL",
  RESEARCH_LICENSE: "RESEARCH_LICENSE",
  OUTPUTS_NON_COMMERCIAL: "OUTPUTS_NON_COMMERCIAL",
  REGION_RESTRICTS_OUTPUTS: "REGION_RESTRICTS_OUTPUTS",
  FACE_ID_WEIGHTS_NON_COMMERCIAL: "FACE_ID_WEIGHTS_NON_COMMERCIAL",
  PROFESSIONAL_ANIMATION_LICENSE: "PROFESSIONAL_ANIMATION_LICENSE",
  DERIVATIVE_TERMS_RESTRICTIVE: "DERIVATIVE_TERMS_RESTRICTIVE",
  REVENUE_THRESHOLD_EXCEEDED: "REVENUE_THRESHOLD_EXCEEDED",
  HOSTING_AS_SERVICE_FORBIDDEN: "HOSTING_AS_SERVICE_FORBIDDEN",
  OTOSHIGO_NO_MEDIA_RELAY: "OTOSHIGO_NO_MEDIA_RELAY",
  CONFIDENTIAL_EXTERNAL_SEND: "CONFIDENTIAL_EXTERNAL_SEND",
  UNKNOWN_ROUTE: "UNKNOWN_ROUTE",
});

export const RIGHTS_WARNING_CODES = Object.freeze({
  WEIGHTS_CONDITIONAL: "WEIGHTS_CONDITIONAL",
  WEIGHTS_NON_COMMERCIAL_EVALUATION_ONLY: "WEIGHTS_NON_COMMERCIAL_EVALUATION_ONLY",
  OUTPUTS_UNVERIFIED: "OUTPUTS_UNVERIFIED",
  OUTPUTS_CONDITIONAL: "OUTPUTS_CONDITIONAL",
  CODE_UNVERIFIED: "CODE_UNVERIFIED",
  REGION_LIMITED_SCOPE: "REGION_LIMITED_SCOPE",
  REVENUE_THRESHOLD_UNKNOWN: "REVENUE_THRESHOLD_UNKNOWN",
  HOSTING_CONDITIONAL: "HOSTING_CONDITIONAL",
  DATA_OPTIONAL_EXTERNAL: "DATA_OPTIONAL_EXTERNAL",
  DATA_EXTERNAL_SEND: "DATA_EXTERNAL_SEND",
  ASSETS_PERSON_CONSENT: "ASSETS_PERSON_CONSENT",
});

const LAYER = { code: "A", weights: "B", outputs: "C", hosting: "D", assets: "E", data: "F" };

function formatUsd(value) {
  return `US$${Number(value).toLocaleString("en-US")}`;
}

/**
 * 1つのモデルを、1つの実行場所（route）と使い方で判定する。
 *
 * context:
 *   route: operator-mac | operator-cuda | operator-rented-gpu | operator-service | otoshigo-hosted
 *   use: "production"（既定。収益のあるチャンネルの本番） | "evaluation"（非公開の比較だけ）
 *   publishScope: "worldwide"（既定。全世界の YouTube） | "japan-only"
 *   confidentialAssets: 外に出せない素材があるか
 *   annualRevenueUsd: 関連会社を含む年売上（分からなければ null）
 *   identityLock: チャンネルが固定したいもの（素材と人物の層の注意に使う）
 */
export function evaluateModelRights(model, context = {}, { catalog = null } = {}) {
  if (!model || typeof model !== "object" || !model.rights) throw new Error("権利を判定するモデルが構成表の形ではない。");
  const route = String(context.route || "");
  const use = context.use === "evaluation" ? "evaluation" : "production";
  const publishScope = context.publishScope === "japan-only" ? "japan-only" : "worldwide";
  const confidential = context.confidentialAssets === true;
  const revenue = Number.isFinite(context.annualRevenueUsd) ? context.annualRevenueUsd : null;
  const { code, weights, outputs, hosting, region, data } = model.rights;
  const name = model.name || model.id;
  const blocks = [];
  const warnings = [];
  const block = (codeId, layer, message) => blocks.push({ code: codeId, layer, message });
  const warn = (codeId, layer, message) => warnings.push({ code: codeId, layer, message });

  const place = catalog ? findRuntimePlace(catalog, route) : null;
  if (catalog && route && !place) {
    block(RIGHTS_BLOCK_CODES.UNKNOWN_ROUTE, "D", `実行場所 ${route} は構成表に無い。operator-mac / operator-cuda / operator-rented-gpu / operator-service / otoshigo-hosted のどれか。`);
  }
  const otoshigoHosted = route === "otoshigo-hosted";
  const sendsExternally = place ? place.sendsDataExternally : ["operator-rented-gpu", "operator-service", "otoshigo-hosted"].includes(route);

  // A コード
  if (code?.status === "unverified") warn(RIGHTS_WARNING_CODES.CODE_UNVERIFIED, LAYER.code, `${name} のコードの許諾は個別に確認していない（${code.license}）。`);

  // B 重みと全依存
  if (weights.faceIdWeightsCommercial === false) {
    const message = `${name} は、コードが Apache でも顔の重み（InsightFace）が非商用の研究用。顔の重みの商用許諾を取った構成か、許諾のある代替でなければ使えない。`;
    if (use === "production") block(RIGHTS_BLOCK_CODES.FACE_ID_WEIGHTS_NON_COMMERCIAL, LAYER.weights, message);
    else warn(RIGHTS_WARNING_CODES.WEIGHTS_NON_COMMERCIAL_EVALUATION_ONLY, LAYER.weights, `${message}（非公開の比較だけなら記録して進める）`);
  } else if (weights.operatorProductionUse === "forbidden") {
    const research = weights.licenseKind === "research";
    const message = research
      ? `${name} は研究用のライセンス（${weights.license}）。研究・評価に限られ、収益のあるチャンネルの本番には別の商用ライセンスが要る。`
      : `${name} の重みは非商用（${weights.license}）。出力の商用利用が認められていても、収益のあるチャンネルの本番で重みを動かす許諾にはならない。`;
    if (use === "production") block(research ? RIGHTS_BLOCK_CODES.RESEARCH_LICENSE : RIGHTS_BLOCK_CODES.WEIGHTS_NON_COMMERCIAL, LAYER.weights, message);
    else warn(RIGHTS_WARNING_CODES.WEIGHTS_NON_COMMERCIAL_EVALUATION_ONLY, LAYER.weights, `${message}（非公開の比較だけなら記録して進める）`);
  } else if (weights.operatorProductionUse === "conditional" || weights.operatorProductionUse === "unverified") {
    warn(RIGHTS_WARNING_CODES.WEIGHTS_CONDITIONAL, LAYER.weights, `${name} の重みには条件がある: ${weights.note || weights.license}`);
  }
  if (weights.professionalAnimation === "separate-license" && use === "production") {
    block(RIGHTS_BLOCK_CODES.PROFESSIONAL_ANIMATION_LICENSE, LAYER.weights, `${name} は、プロの映画・アニメ制作を売上に関係なく別許諾の対象にしている。チャンネルの動画制作に使うなら、先に別の許諾を取る。`);
  }
  if (weights.derivativeTerms === "restrictive" && use === "production") {
    block(RIGHTS_BLOCK_CODES.DERIVATIVE_TERMS_RESTRICTIVE, LAYER.weights, `${name} は派生モデル（微調整・マージ・LoRA）の公開やレシピ開示を求め、閉じた派生の収益化を禁じる記載がある。固定キャストの LoRA を作る使い方と両立しない。`);
  }
  if (Number.isFinite(weights.revenueThresholdUsd)) {
    if (revenue === null) {
      warn(RIGHTS_WARNING_CODES.REVENUE_THRESHOLD_UNKNOWN, LAYER.weights, `${name} には売上の閾値（${formatUsd(weights.revenueThresholdUsd)}）の条件がある。関連会社を含む年売上を確認する。`);
    } else if (revenue >= weights.revenueThresholdUsd) {
      block(RIGHTS_BLOCK_CODES.REVENUE_THRESHOLD_EXCEEDED, LAYER.weights, `${name} は年売上 ${formatUsd(weights.revenueThresholdUsd)} 以上だと別の（有償の）ライセンスが要る。申告された年売上は ${formatUsd(revenue)}。`);
    }
  }

  // C 出力（地域の制限を含む）
  if (outputs.commercialUse === "forbidden") {
    block(RIGHTS_BLOCK_CODES.OUTPUTS_NON_COMMERCIAL, LAYER.outputs, `${name} は、作った画像（生成物）も商業化の禁止対象にしている。収益のあるチャンネルには使えない。`);
  } else if (outputs.commercialUse === "unverified") {
    warn(RIGHTS_WARNING_CODES.OUTPUTS_UNVERIFIED, LAYER.outputs, `${name} の出力の商用条件は、この調査では一次資料で確認していない。${outputs.note || ""}`.trim());
  } else if (outputs.commercialUse === "conditional") {
    warn(RIGHTS_WARNING_CODES.OUTPUTS_CONDITIONAL, LAYER.outputs, `${name} の出力には条件がある。${outputs.note || ""}`.trim());
  }
  const excluded = Array.isArray(region?.excludedTerritories) ? region.excludedTerritories : [];
  if (region?.appliesToOutputs && excluded.length > 0) {
    const message = `${name} は許諾の地域から ${excluded.join("・")} を外し、その地域での出力の使用・配布・表示まで制限している。`;
    if (publishScope === "worldwide") block(RIGHTS_BLOCK_CODES.REGION_RESTRICTS_OUTPUTS, LAYER.outputs, `${message}全世界に公開する YouTube には合わない。`);
    else warn(RIGHTS_WARNING_CODES.REGION_LIMITED_SCOPE, LAYER.outputs, `${message}公開範囲を本当にその地域の外に限れるかを確認する。`);
  }

  // D ホスト・再販
  if (otoshigoHosted) {
    block(RIGHTS_BLOCK_CODES.OTOSHIGO_NO_MEDIA_RELAY, LAYER.hosting, "オトシゴのサーバーでは画像・動画を生成も中継もしない。生成は運営者の手元か、運営者自身の契約先で動かす。");
    if (hosting.asService === "forbidden") {
      block(RIGHTS_BLOCK_CODES.HOSTING_AS_SERVICE_FORBIDDEN, LAYER.hosting, `${name} は、モデルをサービスや API として提供することを認めていない。運営者の手元で使う分には問題ないが、オトシゴが代わりに動かす形にはできない。`);
    } else if (hosting.asService === "conditional" || hosting.asService === "unverified") {
      warn(RIGHTS_WARNING_CODES.HOSTING_CONDITIONAL, LAYER.hosting, `${name} をサービスとして動かす条件は確定していない。`);
    }
  }

  // E 素材と人物（チャンネル側の条件。モデルの許諾とは別に確認する）
  if (context.identityLock === "person+wardrobe" || context.identityLock === "fixed-cast") {
    warn(RIGHTS_WARNING_CODES.ASSETS_PERSON_CONSENT, LAYER.assets, "参照に使う人物・キャラの素材の権利を確認する。実在の人物を基にするなら本人の同意が要る（モデルの許諾とは別）。");
  }

  // F データの扱い
  if (confidential) {
    if (sendsExternally || data?.sendsExternally === true) {
      const where = sendsExternally ? `実行場所（${place?.label || route}）` : `${name} の経路`;
      block(RIGHTS_BLOCK_CODES.CONFIDENTIAL_EXTERNAL_SEND, LAYER.data, `外に出せない素材があるのに、${where}は素材やプロンプトを外部へ送る。手元で完結する経路にするか、契約とデータ範囲の承認を先に変える。`);
    } else if (data?.sendsExternally === "optional") {
      warn(RIGHTS_WARNING_CODES.DATA_OPTIONAL_EXTERNAL, LAYER.data, `${name} には外部へ送る選択肢がある（${data.note || "プロンプト拡張・text encoder など"}）。ローカルの側を選び、通信を確かめる。`);
    }
  } else if (data?.sendsExternally === true || sendsExternally) {
    warn(RIGHTS_WARNING_CODES.DATA_EXTERNAL_SEND, LAYER.data, `この経路では素材とプロンプトが外部（${sendsExternally ? place?.label || route : name}）へ送られる。送ってよい素材だけを使う。`);
  } else if (data?.sendsExternally === "optional") {
    warn(RIGHTS_WARNING_CODES.DATA_OPTIONAL_EXTERNAL, LAYER.data, `${name} には外部へ送る選択肢がある（${data.note || "プロンプト拡張・text encoder など"}）。`);
  }

  return {
    version: RIGHTS_GATE_VERSION,
    modelId: model.id,
    modelName: name,
    route,
    use,
    publishScope,
    allowed: blocks.length === 0,
    blocks,
    warnings,
  };
}

/** traits（チャンネルの性格）から判定の文脈を作る。 */
export function rightsContextFromTraits(traits = {}, route = "") {
  return {
    route,
    use: "production",
    publishScope: traits.publishScope === "japan-only" ? "japan-only" : "worldwide",
    confidentialAssets: traits.confidentialAssets === true,
    annualRevenueUsd: Number.isFinite(traits.annualRevenueUsd) ? traits.annualRevenueUsd : null,
    identityLock: traits.identityLock,
  };
}

/** id でモデルを引いて判定する。route を省くと、そのモデルの実行場所すべてとオトシゴのサーバーを並べて判定する。 */
export function gateModelById(catalog, modelId, context = {}) {
  const model = findModel(catalog, modelId);
  if (!model) {
    const error = new Error(`構成表に無いモデル: ${modelId}。構成表のモデルは ${catalog.models.map((item) => item.id).join(", ")}。`);
    error.code = "OPTIMAL_CONFIG_UNKNOWN_MODEL";
    throw error;
  }
  if (context.route) return [evaluateModelRights(model, context, { catalog })];
  const routes = [...model.runtime.places, "otoshigo-hosted"];
  return [...new Set(routes)].map((route) => evaluateModelRights(model, { ...context, route }, { catalog }));
}
