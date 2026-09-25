/**
 * ナレーション物語の配役（ジャンル層）: 役 → 声。
 *
 * 以前は Channel Pack の voice 1本で全文を読んでいた。引用された台詞も語りの声で読むので、
 * 登場人物の声を宣言する場所が無かった。ここでは Pack の `cast` で
 *   - 役（登場人物の型）ごとの声（provider / model / adapterVersion / voiceId）
 *   - 使えない役（権利根拠が無いなど。`status: "blocked"` と理由）
 * を宣言し、台本パッケージの話者（speakers[].castRole）をその声へ振り分ける。
 *
 * 規則（運営者の私有側の配役契約と振り分けで守っていたことを、固有の役名・声 ID 抜きで一般化）:
 *   - 語りの役（narrator）の声は Pack の `voice`。cast.roles に narrator を書かせない（正本を2つにしない）
 *   - blocked の役は、台本に台詞があれば有料生成の前に止める。別の声へ落とさない
 *   - 宣言の無い役は既定で止める。Pack が `undeclaredRoles: "narrator"` と明示したときだけ語りの声で読み、
 *     生成記録に routedBy: "fallback-narrator" を残す（黙って落とさない）
 *   - active の役は権利根拠（rightsBasis）が要る。Pack が受け入れる根拠の一覧を宣言していればその中に限る
 *   - blocked の役の voiceId が、語りや active の役の voiceId と同じなら止める（使えない声が別名で流れる）
 * 役名・声 ID・権利根拠の語彙はチャンネル固有なので Pack が持ち、ここには1つも書かない。
 */

export const NARRATED_CAST_ROLE_FIELDS = Object.freeze([
  "status", "provider", "model", "adapterVersion", "voiceId", "speed", "rightsBasis", "blockReason",
]);
export const NARRATED_CAST_FIELDS = Object.freeze(["roles", "undeclaredRoles", "acceptedRightsBases"]);
export const NARRATED_NARRATOR_ROLE = "narrator";

const ROLE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;
const SENSITIVE_KEY = /(?:api[-_]?key|authorization|auth[-_]?token|access[-_]?token|refresh[-_]?token|token|secret|password|credentials?|private[-_]?key|signing[-_]?key|client[-_]?secret|cookie)$/iu;

function nonEmpty(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function clampSpeed(value) {
  const parsed = Number(value);
  if (value === undefined || value === null || value === "" || !Number.isFinite(parsed)) return 1;
  return Math.min(1.3, Math.max(0.7, parsed));
}

const DISABLED = Object.freeze({ enabled: false, roles: {}, undeclaredRoles: "stop", acceptedRightsBases: [] });

/**
 * narrated-story.json の `cast`（任意）を読む。形の誤り・欠け・権利根拠の不備は blocker にする
 * （有料生成の前に止める）。`narratorVoice` は正規化済みの Pack の `voice`。
 */
export function normalizeNarratedCastConfig(source, { narratorVoice = null } = {}) {
  if (source === undefined || source === null) return { config: { ...DISABLED, roles: {} }, blockers: [] };
  if (!plainObject(source)) return { config: { ...DISABLED, roles: {} }, blockers: ["cast"] };
  const blockers = [];
  for (const key of Object.keys(source)) {
    if (SENSITIVE_KEY.test(key)) blockers.push(`cast.${key}-forbidden`);
    else if (!NARRATED_CAST_FIELDS.includes(key)) blockers.push(`cast.${key}-unknown`);
  }
  const undeclaredRoles = source.undeclaredRoles === undefined ? "stop" : nonEmpty(source.undeclaredRoles);
  if (!["stop", "narrator"].includes(undeclaredRoles)) blockers.push("cast.undeclaredRoles");
  let acceptedRightsBases = [];
  if (source.acceptedRightsBases !== undefined) {
    if (!Array.isArray(source.acceptedRightsBases) || source.acceptedRightsBases.some((entry) => !nonEmpty(entry))) {
      blockers.push("cast.acceptedRightsBases");
    } else acceptedRightsBases = [...new Set(source.acceptedRightsBases.map((entry) => entry.trim()))];
  }
  const roles = {};
  if (!plainObject(source.roles)) blockers.push("cast.roles");
  else {
    for (const [roleId, entry] of Object.entries(source.roles)) {
      const at = `cast.roles.${roleId}`;
      if (!ROLE_ID.test(roleId)) { blockers.push(`cast.roles.invalid-role-id`); continue; }
      if (roleId === NARRATED_NARRATOR_ROLE) { blockers.push(`${at}-reserved-use-voice`); continue; }
      if (!plainObject(entry)) { blockers.push(at); continue; }
      for (const key of Object.keys(entry)) {
        if (SENSITIVE_KEY.test(key)) blockers.push(`${at}.${key}-forbidden`);
        else if (!NARRATED_CAST_ROLE_FIELDS.includes(key)) blockers.push(`${at}.${key}-unknown`);
      }
      const status = entry.status === undefined ? "active" : nonEmpty(entry.status);
      if (!["active", "blocked"].includes(status)) { blockers.push(`${at}.status`); continue; }
      if (status === "blocked") {
        if (!nonEmpty(entry.blockReason)) blockers.push(`${at}.blockReason`);
        roles[roleId] = { status, blockReason: nonEmpty(entry.blockReason), voiceId: nonEmpty(entry.voiceId), provider: nonEmpty(entry.provider) };
        continue;
      }
      const voice = {
        provider: nonEmpty(entry.provider),
        model: nonEmpty(entry.model),
        adapterVersion: nonEmpty(entry.adapterVersion),
        voiceId: nonEmpty(entry.voiceId),
        speed: clampSpeed(entry.speed),
      };
      for (const field of ["provider", "model", "adapterVersion", "voiceId"]) if (!voice[field]) blockers.push(`${at}.${field}`);
      const rightsBasis = nonEmpty(entry.rightsBasis);
      if (!rightsBasis) blockers.push(`${at}.rightsBasis`);
      else if (acceptedRightsBases.length > 0 && !acceptedRightsBases.includes(rightsBasis)) blockers.push(`${at}.rightsBasis-not-accepted`);
      roles[roleId] = { status, voice, rightsBasis };
    }
  }
  // 使えない声が、使える役の名前で流れていないか。
  const routedVoices = new Set([
    narratorVoice?.voiceId ? `${nonEmpty(narratorVoice.provider)}\u0000${narratorVoice.voiceId}` : "",
    ...Object.values(roles).filter((role) => role.status === "active").map((role) => `${role.voice.provider}\u0000${role.voice.voiceId}`),
  ].filter(Boolean));
  const routedIds = new Set([...routedVoices].map((key) => key.split("\u0000")[1]));
  for (const [roleId, role] of Object.entries(roles)) {
    if (role.status !== "blocked" || !role.voiceId) continue;
    const sameProvider = role.provider ? routedVoices.has(`${role.provider}\u0000${role.voiceId}`) : routedIds.has(role.voiceId);
    if (sameProvider) blockers.push(`cast.roles.${roleId}.blocked-voice-routed`);
  }
  return {
    config: { enabled: true, roles, undeclaredRoles: ["stop", "narrator"].includes(undeclaredRoles) ? undeclaredRoles : "stop", acceptedRightsBases },
    blockers: [...new Set(blockers)],
  };
}

/**
 * 役 → 声の振り分け。台本パッケージの計画（lib/narratedStoryScriptPackage.mjs）が話者の区切りごとに呼ぶ。
 * 戻り値の voice が null なら Pack の `voice`（語りの声）で読む。
 */
export function createNarratedRoleResolver(config = {}) {
  const cast = config?.cast || DISABLED;
  return (role) => {
    const id = nonEmpty(role);
    if (id === NARRATED_NARRATOR_ROLE) return { ok: true, role: id, voice: null, routedBy: "narrator" };
    const entry = cast.roles?.[id];
    if (entry?.status === "blocked") return { ok: false, issue: `cast-role-blocked:${id}` };
    if (entry?.status === "active") return { ok: true, role: id, voice: { ...entry.voice }, routedBy: "cast-role" };
    if (cast.undeclaredRoles === "narrator") return { ok: true, role: NARRATED_NARRATOR_ROLE, voice: null, routedBy: "fallback-narrator" };
    return { ok: false, issue: `cast-role-undeclared:${id}` };
  };
}

/** 有料生成の前に probe する声の adapter（語りの声と、台本で使う役の声。重複なし）。 */
export function narratedVoiceAdapters(config = {}, segments = []) {
  const seen = new Map();
  for (const voice of [config.voice, ...segments.map((segment) => segment.voice).filter(Boolean)]) {
    if (!voice) continue;
    const adapter = { kind: "voice.synthesis", provider: voice.provider, model: voice.model, adapterVersion: voice.adapterVersion };
    seen.set(`${adapter.provider}\u0000${adapter.model}\u0000${adapter.adapterVersion}`, adapter);
  }
  return [...seen.values()];
}

/**
 * 生成した声のテイクが宣言どおりの声で作られたか（生成側の「こう作った」ではなく Media Job の
 * 受領記録で照合する）。blocked の役の voiceId がどのテイクにも出ていないことも見る。
 * `voiceReceipts` は segment id → 採用したテイクの Media Job receipt。
 */
export function auditNarratedVoiceCasting({ segments = [], voiceReceipts = new Map(), config = {} } = {}) {
  const blockedVoiceIds = new Set(Object.values(config?.cast?.roles || {})
    .filter((role) => role.status === "blocked" && role.voiceId)
    .map((role) => role.voiceId));
  const problems = [];
  const byRole = {};
  let fallback = 0;
  for (const segment of segments) {
    const expected = segment.voice || config.voice || {};
    const receipt = voiceReceipts.get(segment.id);
    const role = segment.castRole || NARRATED_NARRATOR_ROLE;
    byRole[role] = (byRole[role] || 0) + 1;
    if (segment.routedBy === "fallback-narrator") fallback += 1;
    if (!receipt) { problems.push(`${segment.id}:receipt-missing`); continue; }
    for (const field of ["provider", "model", "adapterVersion", "voiceId"]) {
      if (nonEmpty(receipt[field]) !== nonEmpty(expected[field])) problems.push(`${segment.id}:${field}-mismatch`);
    }
    if (blockedVoiceIds.has(nonEmpty(receipt.voiceId))) problems.push(`${segment.id}:blocked-voice-used`);
    if (segment.delivery === "dialogue" && role !== NARRATED_NARRATOR_ROLE && segment.routedBy !== "cast-role") {
      problems.push(`${segment.id}:dialogue-not-routed-to-role`);
    }
  }
  const pass = segments.length > 0 && problems.length === 0;
  return {
    pass,
    detail: pass
      ? `${segments.length} voice takes match their declared role voices (${Object.entries(byRole).map(([role, count]) => `${role}=${count}`).join(", ")}`
        + `${fallback ? `; ${fallback} undeclared-role lines read by the narrator as the Pack declares` : ""}); no blocked voice was used`
      : (segments.length === 0 ? "no voice takes to check" : `voice casting mismatch: ${problems.slice(0, 20).join(", ")}`),
    takes: segments.length,
    byRole,
    fallbackToNarrator: fallback,
    problems,
  };
}

/** generation manifest に残す配役（役ごとの声の識別子と状態。blocked の理由の文は残さない）。 */
export function narratedCastManifest(cast = DISABLED) {
  return {
    undeclaredRoles: cast.undeclaredRoles,
    roles: Object.fromEntries(Object.entries(cast.roles || {}).map(([roleId, role]) => [roleId, role.status === "active"
      ? { status: role.status, provider: role.voice.provider, model: role.voice.model, adapterVersion: role.voice.adapterVersion, voiceId: role.voice.voiceId, rightsBasis: role.rightsBasis }
      : { status: role.status }])),
  };
}
