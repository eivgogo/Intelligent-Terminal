"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const appIconManager = require("./appIconManager.cjs");

test("normalizeAppIconVariant falls back to original for invalid values", () => {
  assert.equal(appIconManager.normalizeAppIconVariant("nope"), "original");
  assert.equal(appIconManager.normalizeAppIconVariant("bright"), "original");
});

test("original icon uses platform-specific sizing", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-icon-platform-"));
  const publicDir = path.join(tmp, "public");
  fs.mkdirSync(publicDir, { recursive: true });
  const macPath = path.join(publicDir, "icons", "variants", "macos", "original.png");
  const desktopPath = path.join(publicDir, "icons", "variants", "original.png");
  fs.mkdirSync(path.dirname(macPath), { recursive: true });
  fs.mkdirSync(path.dirname(desktopPath), { recursive: true });
  fs.writeFileSync(macPath, "mac");
  fs.writeFileSync(desktopPath, "desktop");

  appIconManager.initializeAppIconManager(tmp, { preferPublic: true, isMac: true });
  assert.equal(appIconManager.getAppIconPath(tmp), macPath);

  appIconManager.initializeAppIconManager(tmp, { preferPublic: true, isMac: false });
  assert.equal(appIconManager.getAppIconPath(tmp), desktopPath);
});

