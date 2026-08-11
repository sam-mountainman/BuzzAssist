#!/usr/bin/env node

// Keep the proven dialogue generator and its cache format in one place while
// selecting the V25 semantic-prosody, two-take, safe-onset path explicitly.
process.env.MANGA_DIALOGUE_VERSION = "v25";
await import("./generate-manga-v22-dialogue-audio.mjs");
