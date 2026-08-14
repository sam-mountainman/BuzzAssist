import { normalizeCameraShotSequence } from "./mangaVideoPipeline.mjs";

function rounded(value, digits = 3) {
  return Number(Number(value || 0).toFixed(digits));
}

function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

function shotImageKey(cut, shot) {
  return String(shot?.imagePath || cut?.imagePath || "").trim();
}

/**
 * Audit actual edit structure, not just manifest policy flags.
 * Consecutive shots that reuse one illustration are treated as one image hold.
 */
export function auditKoyaEditorialQuality(manifest, contract) {
  const policy = contract?.editorial || {};
  const utteranceById = new Map((manifest?.utterances || []).map((utterance) => [utterance.id, utterance]));
  const segments = [];
  const assignments = new Map();
  const failures = [];
  const addFailure = (id, detail, evidence = {}) => failures.push({ id, detail, ...evidence });

  for (const cut of manifest?.cuts || []) {
    const cutUtteranceIds = Array.isArray(cut.utteranceIds) ? cut.utteranceIds : [];
    const cutUtteranceSet = new Set(cutUtteranceIds);
    const utterances = cutUtteranceIds.map((id) => utteranceById.get(id)).filter(Boolean);
    const durationSeconds = Number(cut.timing?.durationSeconds || 0);

    for (const id of cutUtteranceIds) {
      if (!utteranceById.has(id)) addFailure("unknown-cut-utterance", `Cut ${cut.id} references an unknown utterance.`, { cutId: cut.id, utteranceId: id });
    }

    if (cut.panelLayout?.enabled && cut.panelLayout?.enableFromUtteranceId) {
      addFailure(
        "conditional-split-page-lead-in",
        `Cut ${cut.id} conditionally enables a split page and creates a contextless lead-in edit.`,
        { cutId: cut.id, enableFromUtteranceId: cut.panelLayout.enableFromUtteranceId },
      );
    }

    if (cut.panelLayout?.enabled && !cut.panelLayout?.enableFromUtteranceId) {
      const imageKey = `${cut.id}:split-page`;
      segments.push({
        cutId: cut.id,
        imageKey,
        imagePath: cut.flattenedSplitPage?.filePath || cut.imagePath || imageKey,
        utteranceIds: [...cutUtteranceIds],
        utteranceCount: cutUtteranceIds.length,
        holdSeconds: durationSeconds,
        source: "split-page",
      });
      for (const id of cutUtteranceIds) assignments.set(id, (assignments.get(id) || 0) + 1);
      continue;
    }

    let shots = [];
    try {
      shots = normalizeCameraShotSequence(cut, utterances, durationSeconds);
    } catch (error) {
      addFailure("camera-sequence-normalization", `Cut ${cut.id} camera sequence could not be normalized: ${error.message}`, { cutId: cut.id });
      continue;
    }

    let current = null;
    for (const shot of shots) {
      const utteranceIds = Array.isArray(shot.utteranceIds) ? shot.utteranceIds : [];
      const imageKey = shotImageKey(cut, shot);
      if (!imageKey) addFailure("missing-shot-image", `Shot ${shot.id || "(unknown)"} has no illustration.`, { cutId: cut.id, shotId: shot.id || "" });
      if (policy.forbidUnassignedCameraShots && utteranceIds.length === 0) {
        addFailure("unassigned-camera-shot", `Shot ${shot.id || "(unknown)"} has no utterance and is a contextless insert.`, { cutId: cut.id, shotId: shot.id || "", imagePath: imageKey });
      }
      for (const id of utteranceIds) {
        if (!utteranceById.has(id) || !cutUtteranceSet.has(id)) {
          addFailure("unknown-shot-utterance", `Shot ${shot.id || "(unknown)"} references an utterance outside its cut.`, { cutId: cut.id, shotId: shot.id || "", utteranceId: id });
        } else {
          assignments.set(id, (assignments.get(id) || 0) + 1);
        }
      }
      const holdSeconds = Number(shot.durationSeconds || (Number(shot.endSeconds) - Number(shot.startSeconds)) || 0);
      const source = shot.editorialPlate?.characterPolicy === "strictly-none"
        && shot.editorialPlate?.environmentPolicy === "none"
        ? "editorial-plate"
        : "camera-shot";
      if (current && current.imageKey === imageKey) {
        current.holdSeconds += holdSeconds;
        current.utteranceIds.push(...utteranceIds);
        current.utteranceIds = [...new Set(current.utteranceIds)];
        current.utteranceCount = current.utteranceIds.length;
      } else {
        if (current) segments.push(current);
        current = {
          cutId: cut.id,
          imageKey,
          imagePath: imageKey,
          utteranceIds: [...new Set(utteranceIds)],
          utteranceCount: new Set(utteranceIds).size,
          holdSeconds,
          source,
        };
      }
    }
    if (current) segments.push(current);
  }

  if (policy.requireEveryUtteranceAssignedToImage) {
    for (const utterance of manifest?.utterances || []) {
      if (!assignments.has(utterance.id)) {
        addFailure("missing-utterance-image", `Utterance ${utterance.id} is not assigned to any rendered illustration.`, { utteranceId: utterance.id });
      }
    }
  }

  // A solid editorial card is deliberately not an illustration. It still
  // participates in assignment and continuity gates, but counting its short
  // typographic hold against illustration pacing makes a compact cold-open
  // fail for the wrong reason.
  const dialogueSegments = segments.filter((segment) => (
    segment.utteranceCount > 0 && segment.source !== "editorial-plate"
  ));
  const holdSeconds = dialogueSegments.map((segment) => segment.holdSeconds);
  const multiUtteranceCount = dialogueSegments.filter((segment) => segment.utteranceCount >= 2).length;
  const multiUtteranceImageShare = dialogueSegments.length > 0 ? multiUtteranceCount / dialogueSegments.length : 0;
  const medianImageHoldSeconds = median(holdSeconds);
  const maximumImageHoldSeconds = holdSeconds.length > 0 ? Math.max(...holdSeconds) : 0;

  if (dialogueSegments.length === 0) addFailure("no-dialogue-image-segments", "No dialogue-bearing illustration segments were found.");
  if (multiUtteranceImageShare < Number(policy.minimumMultiUtteranceImageShare || 0)) {
    addFailure("multi-utterance-image-share", "Too few illustrations hold multiple utterances.", {
      actual: rounded(multiUtteranceImageShare),
      minimum: policy.minimumMultiUtteranceImageShare,
    });
  }
  if (medianImageHoldSeconds < Number(policy.minimumMedianImageHoldSeconds || 0)) {
    addFailure("median-image-hold", "Median illustration hold is too short.", {
      actualSeconds: rounded(medianImageHoldSeconds),
      minimumSeconds: policy.minimumMedianImageHoldSeconds,
    });
  }
  if (maximumImageHoldSeconds > Number(policy.maximumImageHoldSeconds || Number.POSITIVE_INFINITY)) {
    addFailure("maximum-image-hold", "An illustration is held longer than the editorial maximum.", {
      actualSeconds: rounded(maximumImageHoldSeconds),
      maximumSeconds: policy.maximumImageHoldSeconds,
    });
  }

  const metrics = {
    imageSegmentCount: segments.length,
    dialogueImageSegmentCount: dialogueSegments.length,
    multiUtteranceImageCount: multiUtteranceCount,
    multiUtteranceImageShare: rounded(multiUtteranceImageShare),
    medianImageHoldSeconds: rounded(medianImageHoldSeconds),
    maximumImageHoldSeconds: rounded(maximumImageHoldSeconds),
    assignedUtteranceCount: assignments.size,
    totalUtteranceCount: (manifest?.utterances || []).length,
  };
  return {
    version: "koya-editorial-quality-audit-v1",
    episodeId: manifest?.id || "",
    policy: {
      minimumMultiUtteranceImageShare: policy.minimumMultiUtteranceImageShare,
      minimumMedianImageHoldSeconds: policy.minimumMedianImageHoldSeconds,
      maximumImageHoldSeconds: policy.maximumImageHoldSeconds,
      forbidUnassignedCameraShots: policy.forbidUnassignedCameraShots,
      forbidConditionalSplitPageLeadIns: policy.forbidConditionalSplitPageLeadIns,
      requireEveryUtteranceAssignedToImage: policy.requireEveryUtteranceAssignedToImage,
    },
    metrics,
    segments: segments.map((segment) => ({ ...segment, holdSeconds: rounded(segment.holdSeconds) })),
    failures,
    knownRemainingIssues: failures.map((failure) => ({ id: failure.id, detail: failure.detail })),
    pass: failures.length === 0,
  };
}
