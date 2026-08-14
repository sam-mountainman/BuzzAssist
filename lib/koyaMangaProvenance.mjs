function nonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function detectedHost(env = process.env) {
  if (nonEmptyString(env.CODEX_THREAD_ID)) return "codex";
  if (nonEmptyString(env.CLAUDE_SESSION_ID) || nonEmptyString(env.CLAUDE_CODE_SESSION_ID)) return "claude";
  return "";
}

function detectedContextId(env = process.env) {
  return nonEmptyString(env.CODEX_THREAD_ID)
    || nonEmptyString(env.CLAUDE_SESSION_ID)
    || nonEmptyString(env.CLAUDE_CODE_SESSION_ID);
}

export function resolveKoyaAgentProvenance(options = {}) {
  const env = options.env || process.env;
  const role = nonEmptyString(options.role) || "generator";
  const host = nonEmptyString(options.host).toLowerCase() || detectedHost(env);
  const contextId = nonEmptyString(options.contextId) || detectedContextId(env);
  if (!host || !["codex", "claude", "legacy-migration"].includes(host)) {
    throw new Error(`${role} host must be codex, claude, or legacy-migration.`);
  }
  if (!contextId || contextId.length < 8) {
    throw new Error(`${role} contextId is required and must identify the real Codex task or Claude session.`);
  }
  const id = nonEmptyString(options.id) || `${host}:${contextId}`;
  return {
    version: "koya-agent-provenance-v1",
    role,
    host,
    id,
    contextId,
    capturedAt: nonEmptyString(options.capturedAt) || new Date().toISOString(),
    source: nonEmptyString(options.source) || (detectedContextId(env) === contextId ? "host-environment" : "explicit"),
  };
}

export function assertKoyaIndependentEvaluator(generator, evaluator) {
  const failures = [];
  if (!generator?.id || !generator?.contextId) failures.push("generator-provenance-missing");
  if (!evaluator?.id || !evaluator?.contextId) failures.push("evaluator-provenance-missing");
  if (generator?.id && evaluator?.id && generator.id === evaluator.id) failures.push("generator-evaluator-id-reused");
  if (generator?.contextId && evaluator?.contextId && generator.contextId === evaluator.contextId) {
    failures.push("generator-evaluator-context-reused");
  }
  return { pass: failures.length === 0, failures };
}
