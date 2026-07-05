import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

function rulesForSelector(css, selector) {
  const matches = [];
  const rulePattern = /([^{}]+)\{([^{}]*)\}/g;
  let match;
  while ((match = rulePattern.exec(css))) {
    const selectors = match[1].split(",").map((item) => item.trim());
    if (selectors.includes(selector)) matches.push(match[2]);
  }
  assert.ok(matches.length > 0, `Missing CSS rule for ${selector}`);
  return matches;
}

function zIndex(rule) {
  const match = rule.match(/z-index:\s*([0-9]+)/);
  assert.ok(match, `Missing z-index in rule: ${rule}`);
  return Number(match[1]);
}

function zIndexForSelector(css, selector) {
  const rule = rulesForSelector(css, selector).find((item) => /z-index:\s*[0-9]+/.test(item));
  assert.ok(rule, `Missing z-index rule for ${selector}`);
  return zIndex(rule);
}

test("generator chrome stays below native Excalidraw toolbar and above backdrop", async () => {
  const css = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
  const nativeToolbarSelectors = [
    ".lovart-ai-root .excalidraw .layer-ui__wrapper",
    ".lovart-ai-root .excalidraw .App-menu",
    ".lovart-ai-root .excalidraw .dropdown-menu",
    ".lovart-ai-root .excalidraw [class*=\"popover\"]"
  ];
  for (const selector of nativeToolbarSelectors) {
    assert.equal(zIndexForSelector(css, selector), 40, `${selector} should stay above generator chrome`);
  }
  assert.doesNotMatch(
    css,
    /\.lovart-ai-root\s+\.excalidraw\s+\.FixedSideContainer/,
    "FixedSideContainer covers prompt menus when forced above the generator panel",
  );

  const backdrop = zIndexForSelector(css, ".lovart-menu-backdrop");
  const panel = zIndexForSelector(css, ".lovart-ai-panel");
  const menu = zIndexForSelector(css, ".lovart-menu");
  const menuWrap = zIndexForSelector(css, ".lovart-menu-wrap");
  const slotMenu = zIndexForSelector(css, ".lovart-menu.lovart-slot-menu");
  const slotButton = zIndexForSelector(css, ".lovart-slot-menu button");
  const videoMenuWrap = zIndexForSelector(css, ".lovart-prompt-wrap.has-video-menu");
  const videoFrameTray = zIndexForSelector(css, ".lovart-prompt-wrap.has-video-menu .lovart-video-frame-tray");
  const videoSettings = zIndexForSelector(css, ".lovart-video-settings");
  const utilityMenu = zIndexForSelector(css, ".lovart-menu.lovart-utility-pop");

  assert.equal(backdrop, 20);
  assert.equal(panel, 30);
  assert.equal(menu, 40);
  assert.equal(menuWrap, 30);
  assert.equal(videoMenuWrap, 40);
  assert.equal(videoFrameTray, 80);
  assert.equal(slotMenu, 100);
  assert.equal(videoSettings, 100);
  assert.equal(utilityMenu, 100);
  assert.equal(slotButton, 101);
  assert.ok(backdrop < panel);
  assert.ok(panel < menu);
  assert.ok(menu < slotMenu);
  assert.ok(slotMenu < slotButton);
});
