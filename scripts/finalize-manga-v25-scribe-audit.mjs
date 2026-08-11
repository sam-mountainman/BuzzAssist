#!/usr/bin/env node

process.env.MANGA_DIALOGUE_VERSION = "v25";
await import("./finalize-manga-v22-scribe-audit.mjs");
