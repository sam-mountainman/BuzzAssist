const ALLOWED_CATEGORIES = new Set([
  "external-report",
  "optional-heavy-qa",
  "platform-limitation",
  "private-channel-pack",
  "private-model-fixture",
]);

const FORBIDDEN_TOOLCHAIN_MARKERS = [
  /ffmpeg/iu,
  /ffprobe/iu,
  /python3 with cv2\/numpy is unavailable/iu,
];

function assertNonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim() !== value || value.length === 0) {
    throw new Error(`${label} must be a non-empty, trimmed string.`);
  }
}

function assertNonEmptyMatcherSegment(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }
}

function normalizeReasonMatcher(entry, label) {
  if (entry.reason !== undefined) {
    assertNonEmptyString(entry.reason, `${label}.reason`);
    if (entry.reasonPrefix !== undefined || entry.reasonSuffix !== undefined) {
      throw new Error(`${label} must use either reason or reasonPrefix/reasonSuffix, never both.`);
    }
    return { type: "exact", value: entry.reason };
  }

  assertNonEmptyMatcherSegment(entry.reasonPrefix, `${label}.reasonPrefix`);
  assertNonEmptyMatcherSegment(entry.reasonSuffix, `${label}.reasonSuffix`);
  return { type: "bounded-dynamic", prefix: entry.reasonPrefix, suffix: entry.reasonSuffix };
}

export function validateTestSkipPolicy(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Test skip policy must be an object.");
  }
  if (input.schemaVersion !== 1) throw new Error("Test skip policy schemaVersion must be 1.");
  if (!Array.isArray(input.entries) || input.entries.length === 0) {
    throw new Error("Test skip policy entries must be a non-empty array.");
  }

  const entries = input.entries.map((entry, index) => {
    const label = `entries[${index}]`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`${label} must be an object.`);
    }
    const allowedKeys = new Set([
      "category", "justification", "name", "platforms", "reason", "reasonPrefix", "reasonSuffix",
    ]);
    const unknown = Object.keys(entry).filter((key) => !allowedKeys.has(key));
    if (unknown.length > 0) throw new Error(`${label} has unknown keys: ${unknown.join(", ")}`);

    assertNonEmptyString(entry.name, `${label}.name`);
    assertNonEmptyString(entry.category, `${label}.category`);
    assertNonEmptyString(entry.justification, `${label}.justification`);
    if (!ALLOWED_CATEGORIES.has(entry.category)) {
      throw new Error(`${label}.category is not an intentional external/private skip category.`);
    }
    if (!Array.isArray(entry.platforms) || entry.platforms.length === 0) {
      throw new Error(`${label}.platforms must be a non-empty array.`);
    }
    const platforms = [...new Set(entry.platforms)];
    if (platforms.length !== entry.platforms.length || platforms.some((value) => !["darwin", "linux", "win32"].includes(value))) {
      throw new Error(`${label}.platforms must contain unique Node platform names.`);
    }

    const reasonMatcher = normalizeReasonMatcher(entry, label);
    const matcherText = reasonMatcher.type === "exact"
      ? reasonMatcher.value
      : `${reasonMatcher.prefix}${reasonMatcher.suffix}`;
    if (FORBIDDEN_TOOLCHAIN_MARKERS.some((pattern) => pattern.test(matcherText))) {
      throw new Error(`${label} attempts to allowlist a required toolchain skip.`);
    }

    return {
      name: entry.name,
      category: entry.category,
      justification: entry.justification,
      platforms,
      reasonMatcher,
    };
  });

  for (const platform of ["darwin", "linux", "win32"]) {
    const names = new Set();
    for (const entry of entries.filter((candidate) => candidate.platforms.includes(platform))) {
      if (names.has(entry.name)) {
        throw new Error(`Duplicate applicable skip entry for ${platform}: ${entry.name}`);
      }
      names.add(entry.name);
    }
  }
  return { schemaVersion: 1, entries };
}

function reasonMatches(reason, matcher) {
  if (matcher.type === "exact") return reason === matcher.value;
  if (!reason.startsWith(matcher.prefix) || !reason.endsWith(matcher.suffix)) return false;
  return reason.length > matcher.prefix.length + matcher.suffix.length;
}

export function evaluateTestSkips(skips, rawPolicy, { platform = process.platform } = {}) {
  if (!["darwin", "linux", "win32"].includes(platform)) {
    throw new Error(`Unsupported test skip policy platform: ${platform}`);
  }
  const policy = validateTestSkipPolicy(rawPolicy);
  const expected = policy.entries.filter((entry) => entry.platforms.includes(platform));
  const matched = new Set();
  const unexpected = [];

  for (const skip of skips) {
    assertNonEmptyString(skip?.name, "skip.name");
    assertNonEmptyString(skip?.reason, "skip.reason");
    const index = expected.findIndex((entry) => entry.name === skip.name && reasonMatches(skip.reason, entry.reasonMatcher));
    if (index < 0 || matched.has(index)) {
      unexpected.push(skip);
      continue;
    }
    matched.add(index);
  }

  const stale = expected.filter((_, index) => !matched.has(index));
  return {
    pass: unexpected.length === 0 && stale.length === 0,
    allowed: skips.filter((skip) => expected.some((entry) => entry.name === skip.name && reasonMatches(skip.reason, entry.reasonMatcher))),
    unexpected,
    stale,
  };
}

export function parseTapSkips(output) {
  const skips = [];
  for (const line of String(output ?? "").split("\n")) {
    const match = line.match(/^\s*(?:not )?ok \d+ - (.+?) # SKIP(?:\s+(.*))?$/u);
    if (!match) continue;
    skips.push({
      name: match[1].trim(),
      reason: (match[2] || "").trim() || "(理由なし)",
    });
  }
  return skips;
}
