import { createHash } from "node:crypto";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

export const SKILL_INVENTORY_SCHEMA_VERSION = 1;
export const SKILL_INVENTORY_MANIFEST_PATH = ".agents/skills/inventory.manifest.json";
export const SKILL_PROFILES_MANIFEST_PATH = ".agents/skills/profiles.manifest.json";

const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;

/**
 * setup-agents は正本 `.agents/skills/<name>/` を配布物の `skills/<name>/` へ
 * 1階層浅くコピーし、`../../../` を `../../` に書き換える（harness-doctor も同じ
 * 正規化で比較する）。この書き換えだけの差は「壊れた衝突」ではなく想定内の
 * 配布形なので、inventory は正本側から配布形ハッシュを計算して同一視する。
 */
export const SHIPPED_SKILL_DEPTH_REWRITE = Object.freeze({ from: "../../../", to: "../../" });
export function shippedSkillContent(source) {
  return String(source).replaceAll(SHIPPED_SKILL_DEPTH_REWRITE.from, SHIPPED_SKILL_DEPTH_REWRITE.to);
}
const EXTERNAL_COPY_SOURCE_ROLES = new Set(["installed-plugin-skill", "shipped-plugin-source"]);
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const REQUIRED_PROFILE_IDS = Object.freeze([
  "operator-production",
  "buzzassist-development",
  "general-work",
]);

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (plainObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

async function readJson(filePath, label) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    throw new Error(`${label} could not be read: ${filePath}: ${error.message}`);
  }
}

function normalizePath(filePath) {
  return resolve(filePath).split(sep).join("/");
}

export function parseSkillFrontmatter(source) {
  const match = String(source).match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u);
  if (!match) return { name: null, description: null };
  const result = { name: null, description: null };
  for (const line of match[1].split(/\r?\n/u)) {
    const field = line.match(/^(name|description):\s*(.*)$/u);
    if (!field) continue;
    result[field[1]] = field[2].trim().replace(/^(["'])(.*)\1$/u, "$2") || null;
  }
  return result;
}

function validateClassification(value, field, issues) {
  const keys = ["installed", "bundled", "productionAllowed", "developmentOnly"];
  if (!plainObject(value)) {
    issues.push(`${field} must be an object`);
    return;
  }
  for (const key of keys) {
    if (typeof value[key] !== "boolean") issues.push(`${field}.${key} must be boolean`);
  }
  if (value.productionAllowed === true && value.developmentOnly === true) {
    issues.push(`${field} cannot be both productionAllowed and developmentOnly`);
  }
}

// 人の承認。skill-creator の合否条件「評価結果と人間承認が版・差分SHAへ拘束されている」を
// 置く場所がこれまで無く、承認をどこにも束縛できなかった。承認は版と内容 SHA を持ち、
// どちらかが今の正本と違えば stale（その承認は今の版を保証しない）。
const ISO_TIMESTAMP = (value) => typeof value === "string" && Number.isFinite(Date.parse(value));
export const SKILL_APPROVAL_ATTESTATION = "human-verified";

function validateApproval(approval, field, issues) {
  if (approval === undefined || approval === null) return;
  if (!plainObject(approval)) { issues.push(`${field} must be an object`); return; }
  for (const key of ["reviewer", "approvedAt", "version", "contentSha256", "attestedBy"]) {
    if (typeof approval[key] !== "string" || !approval[key].trim()) issues.push(`${field}.${key} is required`);
  }
  if (typeof approval.approvedAt === "string" && !ISO_TIMESTAMP(approval.approvedAt)) issues.push(`${field}.approvedAt must be an ISO timestamp`);
  if (typeof approval.version === "string" && !SEMVER_PATTERN.test(approval.version)) issues.push(`${field}.version must be semver`);
  if (typeof approval.contentSha256 === "string" && !SHA256_PATTERN.test(approval.contentSha256)) issues.push(`${field}.contentSha256 must be SHA-256`);
  // 機械が自分で reviewer 名を入力した記録は人間承認ではない（skill-creator）。
  if (typeof approval.attestedBy === "string" && approval.attestedBy !== SKILL_APPROVAL_ATTESTATION) {
    issues.push(`${field}.attestedBy must be ${SKILL_APPROVAL_ATTESTATION}`);
  }
}

/** none: 承認が無い / current: 今の版と SHA に束縛されている / stale: 別の版か別の内容への承認 */
export function skillApprovalState(skill, actualSha256 = skill?.contentSha256) {
  const approval = skill?.approval;
  if (!plainObject(approval)) return "none";
  return approval.version === skill.version && approval.contentSha256 === actualSha256
    && approval.attestedBy === SKILL_APPROVAL_ATTESTATION ? "current" : "stale";
}

/**
 * 人の承認を、今の版と内容 SHA に束縛して manifest へ書く。
 * harness-learn の --human-verified と同じ二手（対話端末＋明示の旗）を要求する。
 * これは詐称を止める仕掛けではなく、詐称を既定の経路から外して記録に残す仕掛け。
 */
export async function recordSkillApproval({
  projectDir = process.cwd(),
  skillId,
  reviewer,
  humanVerified = false,
  isInteractive = false,
  now = () => new Date().toISOString(),
} = {}) {
  const name = String(reviewer || "").trim();
  if (!skillId) throw new Error("承認する skill の id が要ります（--approve <id>）。");
  if (!name) throw new Error("reviewer 名が要ります（--reviewer <名前>）。");
  if (!humanVerified) {
    throw new Error("人の承認として記録するには --human-verified が要ります。機械の判断は承認として記録しません。");
  }
  if (!isInteractive) {
    throw new Error("--human-verified は対話端末からのみ受け付けます。承認した人自身の端末から実行してください。");
  }
  const policy = await loadSkillPolicyManifests(projectDir);
  const skill = (policy.inventory.skills || []).find((entry) => entry.id === skillId);
  if (!skill) throw new Error(`inventory に無い skill: ${skillId}`);
  const source = await readFile(resolve(projectDir, skill.canonicalPath), "utf8");
  const actualSha256 = sha256(source);
  if (actualSha256 !== skill.contentSha256) {
    throw new Error(`${skillId}: manifest の contentSha256 が正本と一致しない。先に inventory の版と SHA を更新すること。`);
  }
  skill.approval = {
    reviewer: name,
    approvedAt: now(),
    version: skill.version,
    contentSha256: actualSha256,
    attestedBy: SKILL_APPROVAL_ATTESTATION,
  };
  const issues = validateSkillInventoryManifest(policy.inventory);
  if (issues.length > 0) throw new Error(`承認を書いた manifest が不正:\n${issues.map((issue) => `  - ${issue}`).join("\n")}`);
  await writeFile(policy.inventoryPath, `${JSON.stringify(policy.inventory, null, 2)}\n`, "utf8");
  return { skillId, approval: { ...skill.approval }, inventoryPath: policy.inventoryPath };
}

export function validateSkillInventoryManifest(manifest) {
  const issues = [];
  if (!plainObject(manifest)) return ["manifest must be an object"];
  if (manifest.schemaVersion !== SKILL_INVENTORY_SCHEMA_VERSION) issues.push(`schemaVersion must be ${SKILL_INVENTORY_SCHEMA_VERSION}`);
  if (!SEMVER_PATTERN.test(manifest.manifestVersion || "")) issues.push("manifestVersion must be semver");
  if (!Array.isArray(manifest.skills)) issues.push("skills must be an array");
  if (!Array.isArray(manifest.plugins)) issues.push("plugins must be an array");
  if (!Array.isArray(manifest.classifications)) issues.push("classifications must be an array");
  for (const name of ["installed", "bundled", "productionAllowed", "developmentOnly"]) {
    if (!manifest.classifications?.includes(name)) issues.push(`classifications must include ${name}`);
  }

  const ids = new Set();
  for (const [index, skill] of (manifest.skills ?? []).entries()) {
    const field = `skills[${index}]`;
    for (const key of ["id", "name", "version", "contentSha256", "language", "owner", "origin", "canonicalPath"]) {
      if (typeof skill?.[key] !== "string" || !skill[key].trim()) issues.push(`${field}.${key} is required`);
    }
    if (ids.has(skill?.id)) issues.push(`${field}.id is duplicated: ${skill?.id}`);
    ids.add(skill?.id);
    if (!SEMVER_PATTERN.test(skill?.version || "")) issues.push(`${field}.version must be semver`);
    if (!SHA256_PATTERN.test(skill?.contentSha256 || "")) issues.push(`${field}.contentSha256 must be SHA-256`);
    if (!Array.isArray(skill?.hosts) || skill.hosts.length === 0) issues.push(`${field}.hosts must be non-empty`);
    if (!Array.isArray(skill?.adapters)) issues.push(`${field}.adapters must be an array`);
    validateClassification(skill?.classification, `${field}.classification`, issues);
    validateApproval(skill?.approval, `${field}.approval`, issues);
  }

  const pluginIds = new Set();
  for (const [index, plugin] of (manifest.plugins ?? []).entries()) {
    const field = `plugins[${index}]`;
    for (const key of ["id", "name", "version", "owner", "origin"]) {
      if (typeof plugin?.[key] !== "string" || !plugin[key].trim()) issues.push(`${field}.${key} is required`);
    }
    if (pluginIds.has(plugin?.id)) issues.push(`${field}.id is duplicated: ${plugin?.id}`);
    pluginIds.add(plugin?.id);
    if (!SEMVER_PATTERN.test(plugin?.version || "")) issues.push(`${field}.version must be semver`);
    if (!Array.isArray(plugin?.manifestPaths) || plugin.manifestPaths.length === 0) issues.push(`${field}.manifestPaths must be non-empty`);
    validateClassification(plugin?.classification, `${field}.classification`, issues);
  }
  return issues;
}

export function validateSkillProfilesManifest(manifest) {
  const issues = [];
  if (!plainObject(manifest)) return ["profiles manifest must be an object"];
  if (manifest.schemaVersion !== SKILL_INVENTORY_SCHEMA_VERSION) issues.push(`schemaVersion must be ${SKILL_INVENTORY_SCHEMA_VERSION}`);
  if (!SEMVER_PATTERN.test(manifest.manifestVersion || "")) issues.push("manifestVersion must be semver");
  if (!Array.isArray(manifest.profiles)) return [...issues, "profiles must be an array"];
  const ids = new Set();
  for (const [index, profile] of manifest.profiles.entries()) {
    const field = `profiles[${index}]`;
    if (typeof profile.id !== "string" || !profile.id) issues.push(`${field}.id is required`);
    if (ids.has(profile.id)) issues.push(`${field}.id is duplicated: ${profile.id}`);
    ids.add(profile.id);
    for (const key of ["alwaysAllowedSkills", "eligibleDeclaredSkills", "conditionallyAllowedSelectors", "hardDeniedSelectors", "allowedPlugins", "requiredCapabilities"]) {
      if (!Array.isArray(profile[key])) issues.push(`${field}.${key} must be an array`);
    }
    if (typeof profile.allowUnlisted !== "boolean") issues.push(`${field}.allowUnlisted must be boolean`);
    if (typeof profile.selectorRequiresDeclaration !== "boolean") issues.push(`${field}.selectorRequiresDeclaration must be boolean`);
  }
  for (const id of REQUIRED_PROFILE_IDS) {
    if (!ids.has(id)) issues.push(`required profile is missing: ${id}`);
  }
  for (const profile of manifest.profiles) {
    if (profile.inherits && !ids.has(profile.inherits)) issues.push(`${profile.id} inherits missing profile: ${profile.inherits}`);
  }
  return issues;
}

export async function loadSkillPolicyManifests(projectDir = process.cwd()) {
  const inventoryPath = resolve(projectDir, SKILL_INVENTORY_MANIFEST_PATH);
  const profilesPath = resolve(projectDir, SKILL_PROFILES_MANIFEST_PATH);
  const [inventory, profiles] = await Promise.all([
    readJson(inventoryPath, "skill inventory manifest"),
    readJson(profilesPath, "skill profiles manifest"),
  ]);
  const issues = [
    ...validateSkillInventoryManifest(inventory),
    ...validateSkillProfilesManifest(profiles),
  ];
  if (issues.length > 0) throw new Error(`Skill policy manifests are invalid:\n${issues.map((issue) => `  - ${issue}`).join("\n")}`);
  return { inventory, profiles, inventoryPath, profilesPath };
}

async function projectSkillRecords(projectDir, manifest) {
  const records = [];
  const issues = [];
  for (const skill of manifest.skills) {
    const canonicalPath = resolve(projectDir, skill.canonicalPath);
    let source;
    try {
      source = await readFile(canonicalPath, "utf8");
    } catch (error) {
      issues.push(`${skill.id}: canonical skill is missing: ${skill.canonicalPath} (${error.code || error.message})`);
      continue;
    }
    const metadata = parseSkillFrontmatter(source);
    const actualSha256 = sha256(source);
    if (metadata.name !== skill.name) issues.push(`${skill.id}: frontmatter name is ${metadata.name || "missing"}, expected ${skill.name}`);
    if (actualSha256 !== skill.contentSha256) issues.push(`${skill.id}: manifest hash ${skill.contentSha256} != ${actualSha256}`);
    records.push({
      kind: "skill",
      name: skill.name,
      qualifiedId: skill.id,
      scope: "buzzassist",
      sourceRole: skill.origin === "project-canonical" ? "project-canonical" : "plugin-runtime-source",
      path: canonicalPath,
      relativePath: skill.canonicalPath,
      version: skill.version,
      language: skill.language,
      owner: skill.owner,
      origin: skill.origin,
      hosts: [...skill.hosts],
      contentSha256: actualSha256,
      shippedContentSha256: sha256(shippedSkillContent(source)),
      expectedContentSha256: skill.contentSha256,
      classification: { ...skill.classification },
      approval: skill.approval ? { ...skill.approval } : null,
      approvalState: skillApprovalState(skill, actualSha256),
    });

    for (const adapter of skill.adapters) {
      const adapterPath = resolve(projectDir, adapter.path);
      let adapterSource;
      try {
        adapterSource = await readFile(adapterPath, "utf8");
      } catch (error) {
        issues.push(`${skill.id}: ${adapter.host} adapter is missing: ${adapter.path} (${error.code || error.message})`);
        continue;
      }
      const adapterMetadata = parseSkillFrontmatter(adapterSource);
      if (adapterMetadata.name !== adapter.name) {
        issues.push(`${skill.id}: ${adapter.host} adapter name is ${adapterMetadata.name || "missing"}, expected ${adapter.name}`);
      }
      const canonicalNeedle = skill.canonicalPath.replace(/^\.\//u, "");
      if (!adapterSource.includes(canonicalNeedle)) {
        issues.push(`${skill.id}: ${adapter.host} adapter does not route to ${skill.canonicalPath}`);
      }
      records.push({
        kind: "skill",
        name: adapter.name,
        qualifiedId: skill.id,
        canonicalName: skill.name,
        scope: "buzzassist",
        sourceRole: "project-adapter",
        adapterHost: adapter.host,
        canonicalPath,
        path: adapterPath,
        relativePath: adapter.path,
        version: skill.version,
        language: skill.language,
        owner: skill.owner,
        origin: "project-adapter",
        hosts: [adapter.host],
        contentSha256: sha256(adapterSource),
        shippedContentSha256: sha256(shippedSkillContent(adapterSource)),
        canonicalContentSha256: actualSha256,
        classification: { ...skill.classification, installed: false },
      });
    }
  }
  return { records, issues };
}

async function projectPluginRecords(projectDir, manifest) {
  const records = [];
  const issues = [];
  for (const plugin of manifest.plugins) {
    const observed = [];
    for (const manifestPath of plugin.manifestPaths) {
      const fullPath = resolve(projectDir, manifestPath);
      let value;
      try {
        value = await readJson(fullPath, "plugin manifest");
      } catch (error) {
        issues.push(`${plugin.id}: ${error.message}`);
        continue;
      }
      const version = value.version || value.plugins?.find?.((entry) => entry.name === plugin.name)?.version || null;
      if (version && version !== plugin.version) issues.push(`${plugin.id}: ${manifestPath} version ${version} != ${plugin.version}`);
      observed.push({ path: fullPath, relativePath: manifestPath, sha256: sha256(canonicalJson(value)), version });
    }
    records.push({
      kind: "plugin",
      name: plugin.name,
      qualifiedId: plugin.id,
      scope: "buzzassist",
      sourceRole: "project-bundle",
      version: plugin.version,
      owner: plugin.owner,
      origin: plugin.origin,
      hosts: [...plugin.hosts],
      manifests: observed,
      contentSha256: sha256(canonicalJson(observed.map(({ relativePath, sha256: digest }) => ({ relativePath, sha256: digest })))),
      classification: { ...plugin.classification },
    });
  }
  return { records, issues };
}

async function pathIsDirectory(path) {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function findFiles(root, names, options = {}) {
  const output = [];
  const maxDepth = Number.isInteger(options.maxDepth) ? options.maxDepth : 8;
  const skip = new Set(options.skip ?? [".git", "node_modules"]);
  const visit = async (dir, depth) => {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (skip.has(entry.name)) continue;
      const path = join(dir, entry.name);
      if (entry.isFile() && names.has(entry.name)) output.push(path);
      else if (entry.isDirectory()) await visit(path, depth + 1);
    }
  };
  await visit(resolve(root), 0);
  return output.sort((a, b) => a.localeCompare(b));
}

function inferPluginNamespace(filePath) {
  const parts = normalizePath(filePath).split("/");
  const skillsIndex = parts.lastIndexOf("skills");
  if (skillsIndex >= 3 && SEMVER_PATTERN.test(parts[skillsIndex - 1])) return parts[skillsIndex - 2];
  const cacheIndex = parts.lastIndexOf("cache");
  if (cacheIndex >= 0 && parts[cacheIndex + 1]) return parts[cacheIndex + 1];
  return null;
}

function externalScopeForPath(filePath, spec) {
  const normalized = normalizePath(filePath);
  if (normalized.includes("/.codex/skills/.system/")) return { scope: "codex-system", sourceRole: "system-skill", namespace: "codex-system" };
  const pluginNamespace = spec.namespace || inferPluginNamespace(filePath);
  if (pluginNamespace) {
    return { scope: `plugin:${pluginNamespace}`, sourceRole: spec.sourceRole || "installed-plugin-skill", namespace: pluginNamespace };
  }
  return { scope: spec.scope || "user-global", sourceRole: spec.sourceRole || "global-install", namespace: spec.namespace || "user-global" };
}

/**
 * 端末側コピーが「どの導入物（installation）」に属するかを path から決める。
 * host cache は `<cache>/<ns>/<ns>/<semver>/…`、配布元は spec.path そのもの。
 * 同じ installation に属するコピーをまとめて正本の同梱一覧と突き合わせるため、
 * ここで root / host / version を record に残す（欠落検出は analyze 側）。
 */
export function installationForPath(filePath, spec, inferred) {
  const normalized = normalizePath(filePath);
  if (inferred.sourceRole === "shipped-plugin-source") {
    return { root: normalizePath(spec.path), host: spec.host || null, version: spec.version || null, namespace: inferred.namespace };
  }
  if (inferred.sourceRole !== "installed-plugin-skill") return null;
  const parts = normalized.split("/");
  const cacheIndex = parts.lastIndexOf("cache");
  for (let index = Math.max(cacheIndex, 0) + 1; index < parts.length - 1; index += 1) {
    if (SEMVER_PATTERN.test(parts[index])) {
      return { root: parts.slice(0, index + 1).join("/"), host: spec.host || null, version: parts[index], namespace: inferred.namespace };
    }
  }
  return { root: normalizePath(spec.path), host: spec.host || null, version: spec.version || null, namespace: inferred.namespace };
}

/** 導入物の中で「同梱 Skill の1コピー」として数える相対位置（`skills/<name>` と `.agents/skills/<name>`）。 */
const SHIPPED_COPY_PATTERN = /(?:^|\/)(?:skills|\.agents\/skills)\/([^/]+)\/SKILL\.md$/u;
function shippedCopyDirName(filePath) {
  const match = normalizePath(filePath).match(SHIPPED_COPY_PATTERN);
  return match ? match[1] : null;
}

export async function scanInstalledSkillRoots(rootSpecs = []) {
  const records = [];
  for (const rawSpec of rootSpecs) {
    const spec = typeof rawSpec === "string" ? { path: rawSpec } : rawSpec;
    if (!spec?.path || !(await pathIsDirectory(spec.path))) continue;
    const files = await findFiles(spec.path, new Set(["SKILL.md"]), { maxDepth: spec.maxDepth ?? 8 });
    for (const filePath of files) {
      const source = await readFile(filePath, "utf8");
      const metadata = parseSkillFrontmatter(source);
      const name = metadata.name || basename(dirname(filePath));
      const inferred = externalScopeForPath(filePath, spec);
      const installation = installationForPath(filePath, spec, inferred);
      records.push({
        kind: "skill",
        name,
        qualifiedId: `${inferred.namespace}:${name}`,
        scope: inferred.scope,
        sourceRole: inferred.sourceRole,
        path: resolve(filePath),
        relativePath: relative(resolve(spec.path), resolve(filePath)).split(sep).join("/"),
        version: spec.version || null,
        language: null,
        owner: null,
        origin: inferred.sourceRole,
        hosts: spec.host ? [spec.host] : [],
        contentSha256: sha256(source),
        ...(installation ? { installation, shippedDirName: shippedCopyDirName(filePath) } : {}),
        classification: { installed: true, bundled: false, productionAllowed: false, developmentOnly: false },
      });
    }
  }
  return records.sort((a, b) => a.qualifiedId.localeCompare(b.qualifiedId) || a.path.localeCompare(b.path));
}

export async function scanInstalledPluginRoot(cacheRoot) {
  if (!cacheRoot || !(await pathIsDirectory(cacheRoot))) return [];
  const files = await findFiles(cacheRoot, new Set(["plugin.json"]), { maxDepth: 8 });
  const records = [];
  for (const filePath of files) {
    if (!/[\\/]\.(?:codex|claude)-plugin[\\/]plugin\.json$/u.test(filePath)) continue;
    let value;
    try {
      value = await readJson(filePath, "installed plugin manifest");
    } catch {
      continue;
    }
    if (!value?.name) continue;
    records.push({
      kind: "plugin",
      name: value.name,
      qualifiedId: `plugin:${value.name}`,
      scope: `plugin:${value.name}`,
      sourceRole: "installed-plugin",
      version: value.version || null,
      path: resolve(filePath),
      contentSha256: sha256(canonicalJson(value)),
      classification: { installed: true, bundled: false, productionAllowed: false, developmentOnly: false },
    });
  }
  return records.sort((a, b) => a.qualifiedId.localeCompare(b.qualifiedId) || a.path.localeCompare(b.path));
}

function groupBy(items, keyFor) {
  const groups = new Map();
  for (const item of items) {
    const key = keyFor(item);
    const group = groups.get(key);
    if (group) group.push(item);
    else groups.set(key, [item]);
  }
  return groups;
}

function summarizeDivergence(id, records) {
  return {
    id,
    hashes: [...new Set(records.map((record) => record.contentSha256))].sort(),
    paths: records.map((record) => record.path).sort(),
    sourceRoles: [...new Set(records.map((record) => record.sourceRole))].sort(),
  };
}

/**
 * 正本に同梱されている Skill が、端末側の導入物（host cache / 配布元）に
 * そもそも存在しないものを見つける。hash 差（stale）は「存在するが古い」で、
 * こちらは「無い」——host がその Skill を一切読めない状態なので別区分にする。
 *
 * 版の一致する導入物（または版が読めない導入物）だけを欠落として数える。
 * 同梱版より古い版の cache は、新しい Skill を持たないのが当然なので
 * `outdatedInstalledVersions` に分けて残存を見えるようにする。
 */
export function findMissingInstalledCopies(records) {
  const bundledPlugins = records.filter((record) => record.kind === "plugin" && record.scope === "buzzassist" && record.sourceRole === "project-bundle");
  const bundledVersionByNamespace = new Map(bundledPlugins.map((plugin) => [plugin.name, plugin.version]));
  const expectedByNamespace = new Map();
  for (const record of records) {
    if (record.kind !== "skill" || record.scope !== "buzzassist" || record.classification?.bundled !== true) continue;
    const relativePath = String(record.relativePath || "").replace(/^\.\//u, "");
    const match = relativePath.match(/^(?:skills|\.agents\/skills)\/([^/]+)\/SKILL\.md$/u);
    if (!match) continue; // .claude/skills, .codex/skills の host adapter は配布物に入らない
    const namespace = record.qualifiedId.split(":")[0];
    if (!expectedByNamespace.has(namespace)) expectedByNamespace.set(namespace, new Map());
    expectedByNamespace.get(namespace).set(match[1], { qualifiedId: record.qualifiedId, name: record.name, dirName: match[1] });
  }

  const installations = new Map();
  for (const record of records) {
    if (record.kind !== "skill" || !record.installation || !EXTERNAL_COPY_SOURCE_ROLES.has(record.sourceRole)) continue;
    const { root, host, version, namespace } = record.installation;
    if (!expectedByNamespace.has(namespace)) continue;
    const key = `${namespace}\u0000${root}`;
    if (!installations.has(key)) installations.set(key, { namespace, root, host, version, present: new Set() });
    const installation = installations.get(key);
    if (record.shippedDirName) installation.present.add(record.shippedDirName);
    installation.present.add(record.name);
  }

  const missingInstalledCopies = [];
  const outdatedInstalledVersions = [];
  for (const installation of installations.values()) {
    const expected = expectedByNamespace.get(installation.namespace);
    // 配布ディレクトリ名で数える（adapter と正本が同じ qualifiedId を共有するため、
    // qualifiedId で数えると skill-creator が二重に見える）。
    const missingEntries = [...expected.values()]
      .filter((entry) => !installation.present.has(entry.dirName) && !installation.present.has(entry.name))
      .sort((a, b) => a.dirName.localeCompare(b.dirName));
    const missing = missingEntries.map((entry) => entry.dirName);
    const missingQualifiedIds = [...new Set(missingEntries.map((entry) => entry.qualifiedId))].sort();
    const bundledVersion = bundledVersionByNamespace.get(installation.namespace) || null;
    const entry = {
      namespace: installation.namespace,
      installRoot: installation.root,
      host: installation.host,
      version: installation.version,
      bundledVersion,
      expected: expected.size,
      present: expected.size - missing.length,
      missing,
      missingQualifiedIds,
    };
    if (installation.version && bundledVersion && installation.version !== bundledVersion) {
      outdatedInstalledVersions.push(entry);
    } else if (missing.length > 0) {
      missingInstalledCopies.push(entry);
    }
  }
  const byRoot = (a, b) => a.installRoot.localeCompare(b.installRoot);
  return { missingInstalledCopies: missingInstalledCopies.sort(byRoot), outdatedInstalledVersions: outdatedInstalledVersions.sort(byRoot) };
}

export function analyzeSkillInventory(records, manifestIssues = []) {
  const { missingInstalledCopies, outdatedInstalledVersions } = findMissingInstalledCopies(records);
  const implementations = records.filter((record) => record.kind === "skill" && record.sourceRole !== "project-adapter");
  // 配布形ハッシュ → 正本ハッシュ。正本・adapter どちらの配布コピーも正本側へ畳む。
  const shippedToCanonical = new Map();
  for (const record of records) {
    if (record.scope !== "buzzassist" || !record.shippedContentSha256) continue;
    if (record.shippedContentSha256 !== record.contentSha256) shippedToCanonical.set(record.shippedContentSha256, record.contentSha256);
  }
  const effectiveHash = (record) => {
    if (EXTERNAL_COPY_SOURCE_ROLES.has(record.sourceRole)) return shippedToCanonical.get(record.contentSha256) || record.contentSha256;
    return record.contentSha256;
  };
  const byQualifiedId = groupBy(implementations, (record) => record.qualifiedId);
  const collisions = [];
  const externalDivergentHashes = [];
  const staleInstalledCopies = [];
  const exactMirrors = [];
  for (const [qualifiedId, group] of byQualifiedId) {
    if (group.length < 2) continue;
    const internal = group.filter((record) => record.scope === "buzzassist");
    const internalHashes = new Set(internal.map(effectiveHash));
    const allHashes = new Set(group.map(effectiveHash));
    const depthRewriteEquivalents = group
      .filter((record) => effectiveHash(record) !== record.contentSha256)
      .map((record) => record.path)
      .sort();
    if (allHashes.size === 1) {
      exactMirrors.push({ ...summarizeDivergence(qualifiedId, group), hashes: [...allHashes], depthRewriteEquivalents });
    } else if (internalHashes.size > 1) {
      collisions.push(summarizeDivergence(qualifiedId, group));
    } else if (internal.length > 0) {
      // 正本側は一致し、端末側の導入コピーだけが古い/違う。壊れた正本ではなく
      // 「配布し直していない」状態なので collision とは分けて報告する。
      const [canonicalHash] = internalHashes;
      staleInstalledCopies.push({
        ...summarizeDivergence(qualifiedId, group),
        canonicalHash,
        stalePaths: group.filter((record) => effectiveHash(record) !== canonicalHash).map((record) => record.path).sort(),
      });
    } else {
      externalDivergentHashes.push(summarizeDivergence(qualifiedId, group));
    }
  }

  const crossScopeSameNames = [...groupBy(implementations, (record) => record.name)]
    .filter(([, group]) => new Set(group.map((record) => record.qualifiedId)).size > 1)
    .map(([name, group]) => ({
      name,
      qualifiedIds: [...new Set(group.map((record) => record.qualifiedId))].sort(),
      paths: group.map((record) => record.path).sort(),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const adapterIssues = [];
  const canonicalById = new Map(
    records
      .filter((record) => record.scope === "buzzassist" && record.sourceRole !== "project-adapter")
      .map((record) => [record.qualifiedId, record]),
  );
  for (const adapter of records.filter((record) => record.sourceRole === "project-adapter")) {
    const canonical = canonicalById.get(adapter.qualifiedId);
    if (!canonical) adapterIssues.push(`${adapter.path}: canonical ${adapter.qualifiedId} is missing`);
    else if (adapter.canonicalContentSha256 !== canonical.contentSha256) adapterIssues.push(`${adapter.path}: canonical SHA is stale`);
  }

  return {
    collisions,
    externalDivergentHashes,
    staleInstalledCopies,
    missingInstalledCopies,
    outdatedInstalledVersions,
    exactMirrors,
    crossScopeSameNames,
    adapterIssues,
    manifestIssues: [...manifestIssues],
    // 人の承認が今の版・今の SHA に束縛されていない本番スキル。skill-creator の合否
    // 条件「評価結果と人間承認が版・差分SHAへ拘束されている」を、報告として見える
    // ようにする。ok には含めない（今は全スキルが未承認で、含めると本番が全部止まる。
    // 止めるかどうかは --require-approval で明示する）。
    unapprovedProductionSkills: records
      .filter((record) => record.kind === "skill" && record.sourceRole === "project-canonical"
        && record.classification?.productionAllowed === true && record.approvalState !== "current")
      .map((record) => ({ id: record.qualifiedId, version: record.version, approvalState: record.approvalState }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    // ok は正本（このリポジトリ）の整合だけを見る。端末側の導入状態は hostSyncOk。
    ok: collisions.length === 0 && adapterIssues.length === 0 && manifestIssues.length === 0,
    hostSyncOk: staleInstalledCopies.length === 0 && missingInstalledCopies.length === 0,
  };
}

function selectorRegex(selector) {
  const escaped = String(selector).replace(/[.+?^${}()|[\]\\]/gu, "\\$&").replaceAll("*", ".*");
  return new RegExp(`^${escaped}$`, "iu");
}

export function matchesSkillSelector(skill, selector) {
  const regex = selectorRegex(selector);
  const id = typeof skill === "string" ? skill : skill?.qualifiedId || "";
  const name = typeof skill === "string" ? skill.split(":").at(-1) : skill?.name || "";
  return regex.test(id) || regex.test(name);
}

function mergeProfile(parent, child) {
  const mergeArray = (key) => [...new Set([...(parent?.[key] ?? []), ...(child?.[key] ?? [])])];
  return {
    ...parent,
    ...child,
    alwaysAllowedSkills: mergeArray("alwaysAllowedSkills"),
    eligibleDeclaredSkills: mergeArray("eligibleDeclaredSkills"),
    conditionallyAllowedSelectors: mergeArray("conditionallyAllowedSelectors"),
    hardDeniedSelectors: mergeArray("hardDeniedSelectors"),
    allowedPlugins: mergeArray("allowedPlugins"),
    requiredCapabilities: mergeArray("requiredCapabilities"),
  };
}

export function resolveSkillProfile(profilesManifest, profileId) {
  const byId = new Map((profilesManifest?.profiles ?? []).map((profile) => [profile.id, profile]));
  const seen = new Set();
  const resolveProfile = (id) => {
    if (seen.has(id)) throw new Error(`Skill profile inheritance cycle: ${[...seen, id].join(" -> ")}`);
    const profile = byId.get(id);
    if (!profile) throw new Error(`Unknown skill profile: ${id}`);
    if (!profile.inherits) return { ...profile };
    seen.add(id);
    const resolved = mergeProfile(resolveProfile(profile.inherits), profile);
    seen.delete(id);
    return resolved;
  };
  return resolveProfile(profileId);
}

export function evaluateSkillForProfile(skill, profileId, profilesManifest, options = {}) {
  const profile = resolveSkillProfile(profilesManifest, profileId);
  const qualifiedId = typeof skill === "string" ? skill : skill?.qualifiedId;
  if (!qualifiedId) return { allowed: false, reason: "skill-id-missing", profileId };
  const declared = new Set(options.declaredSkillIds ?? []);
  if (profile.hardDeniedSelectors.some((selector) => matchesSkillSelector(skill, selector))) {
    return { allowed: false, reason: "hard-denied", profileId, qualifiedId };
  }
  if (profile.alwaysAllowedSkills.includes(qualifiedId)) {
    return { allowed: true, reason: "profile-base", profileId, qualifiedId };
  }
  if (profile.eligibleDeclaredSkills.includes(qualifiedId)) {
    return declared.has(qualifiedId)
      ? { allowed: true, reason: "harness-declared", profileId, qualifiedId }
      : { allowed: false, reason: "harness-declaration-required", profileId, qualifiedId };
  }
  const conditional = profile.conditionallyAllowedSelectors.some((selector) => matchesSkillSelector(skill, selector));
  if (conditional) {
    if (profile.selectorRequiresDeclaration && !declared.has(qualifiedId)) {
      return { allowed: false, reason: "harness-declaration-required", profileId, qualifiedId };
    }
    return { allowed: true, reason: profile.selectorRequiresDeclaration ? "harness-declared-external" : "profile-selector", profileId, qualifiedId };
  }
  return profile.allowUnlisted
    ? { allowed: true, reason: "profile-allows-unlisted", profileId, qualifiedId }
    : { allowed: false, reason: "not-in-profile", profileId, qualifiedId };
}

export function evaluatePluginForProfile(plugin, profileId, profilesManifest) {
  const profile = resolveSkillProfile(profilesManifest, profileId);
  const qualifiedId = typeof plugin === "string" ? plugin : plugin?.qualifiedId;
  return profile.allowedPlugins.includes(qualifiedId)
    ? { allowed: true, reason: "profile-plugin", profileId, qualifiedId }
    : { allowed: false, reason: "plugin-not-in-profile", profileId, qualifiedId };
}

export function defaultGlobalSkillRoots(home = homedir(), options = {}) {
  const roots = [
    { path: join(home, ".codex", "skills"), scope: "user-global", sourceRole: "global-install", host: "codex", maxDepth: 4 },
    { path: join(home, ".agents", "skills"), scope: "user-global", sourceRole: "global-install", host: "shared", maxDepth: 3 },
    { path: join(home, ".claude", "skills"), scope: "user-global", sourceRole: "global-install", host: "claude-code", maxDepth: 3 },
  ];
  if (options.includePluginCache) {
    roots.push(
      // 配布元（setup-agents が書き、launchd updater と両 host の marketplace が指す）
      { path: join(home, "plugins", "buzzassist", "plugin", "skills"), namespace: "buzzassist", sourceRole: "shipped-plugin-source", host: "shared", maxDepth: 3 },
      // 各 host が実際に読み込む cache
      { path: join(home, ".codex", "plugins", "cache"), host: "codex", maxDepth: 8 },
      { path: join(home, ".claude", "plugins", "cache"), host: "claude-code", maxDepth: 8 },
    );
  }
  return roots;
}

/** 配布元 `<root>/skills` の親にある plugin.json から版を読む（無ければ null）。 */
async function shippedPluginVersion(skillsRoot) {
  const pluginRoot = dirname(resolve(skillsRoot));
  for (const manifestPath of [join(pluginRoot, ".claude-plugin", "plugin.json"), join(pluginRoot, ".codex-plugin", "plugin.json")]) {
    try {
      const value = JSON.parse(await readFile(manifestPath, "utf8"));
      if (typeof value?.version === "string" && SEMVER_PATTERN.test(value.version)) return value.version;
    } catch {
      // 次の候補へ
    }
  }
  return null;
}

export async function buildSkillInventory(options = {}) {
  const projectDir = resolve(options.projectDir || process.cwd());
  const policy = await loadSkillPolicyManifests(projectDir);
  const [projectSkills, projectPlugins] = await Promise.all([
    projectSkillRecords(projectDir, policy.inventory),
    projectPluginRecords(projectDir, policy.inventory),
  ]);
  const rootSpecs = [
    ...(options.includeGlobal ? defaultGlobalSkillRoots(options.homeDir || homedir(), { includePluginCache: options.includePluginCache }) : []),
    ...(options.skillRoots ?? []),
  ];
  for (const spec of rootSpecs) {
    if (spec?.sourceRole === "shipped-plugin-source" && !spec.version) spec.version = await shippedPluginVersion(spec.path);
  }
  const installedSkills = await scanInstalledSkillRoots(rootSpecs);
  const home = options.homeDir || homedir();
  const installedPlugins = options.includePluginCache
    ? (await Promise.all([
        scanInstalledPluginRoot(join(home, ".codex", "plugins", "cache")),
        scanInstalledPluginRoot(join(home, ".claude", "plugins", "cache")),
      ])).flat()
    : [];
  const skills = [...projectSkills.records, ...installedSkills];
  const plugins = [...projectPlugins.records, ...installedPlugins];
  const manifestIssues = [...projectSkills.issues, ...projectPlugins.issues];
  // 同梱 plugin の版を渡すことで、古い版の cache と「同版なのに欠けている」cache を分ける。
  const analysis = analyzeSkillInventory([...skills, ...projectPlugins.records], manifestIssues);
  const profile = options.profileId
    ? {
        id: options.profileId,
        skills: skills.map((skill) => ({
          qualifiedId: skill.qualifiedId,
          path: skill.path,
          sourceRole: skill.sourceRole,
          ...evaluateSkillForProfile(skill, options.profileId, policy.profiles, { declaredSkillIds: options.declaredSkillIds }),
        })),
        plugins: plugins.map((plugin) => ({
          qualifiedId: plugin.qualifiedId,
          path: plugin.path,
          sourceRole: plugin.sourceRole,
          ...evaluatePluginForProfile(plugin, options.profileId, policy.profiles),
        })),
      }
    : null;
  return {
    schemaVersion: SKILL_INVENTORY_SCHEMA_VERSION,
    generatedFrom: {
      projectDir,
      inventoryManifest: policy.inventoryPath,
      profilesManifest: policy.profilesPath,
      includeGlobal: Boolean(options.includeGlobal),
      includePluginCache: Boolean(options.includePluginCache),
    },
    classifications: ["installed", "bundled", "productionAllowed", "developmentOnly"],
    skills,
    plugins,
    analysis,
    profile,
  };
}

