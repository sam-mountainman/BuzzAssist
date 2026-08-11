#!/usr/bin/env node

process.env.MANGA_DIALOGUE_VERSION = "v25";
await import("./audit-manga-v22-dialogue-audio.mjs");
