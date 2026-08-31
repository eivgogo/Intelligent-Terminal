"use strict";

const path = require("node:path");
const fs = require("node:fs");

const VALID_VARIANTS = new Set(["original"]);

const DEFAULT_VARIANT = "original";

let currentVariant = DEFAULT_VARIANT;
let currentIconPath = null;
let preferPublicSources = false;
let useMacIconSources = false;

function isValidAppIconVariant(variant) {
  return typeof variant === "string" && VALID_VARIANTS.has(variant);
}

function normalizeAppIconVariant(variant) {
  return isValidAppIconVariant(variant) ? variant : DEFAULT_VARIANT;
}

function isPackagedApp(app) {
  try {
    return app?.isPackaged === true;
  } catch {
    return false;
  }
}

function pickExistingPath(candidates) {
  return candidates.find((candidate) => fs.existsSync(candidate));
}

function buildSourceCandidates(appPath, relativeParts) {
  const publicCandidate = path.join(appPath, "public", ...relativeParts);
  const distCandidate = path.join(appPath, "dist", ...relativeParts);
  return preferPublicSources
    ? [publicCandidate, distCandidate]
    : [distCandidate, publicCandidate];
}

function resolveOriginalIconPath(appPath) {
  const primaryParts = useMacIconSources
    ? ["icons", "variants", "macos", "original.png"]
    : ["icons", "variants", "original.png"];
  const candidates = useMacIconSources
    ? buildSourceCandidates(appPath, primaryParts)
    : [
        ...buildSourceCandidates(appPath, primaryParts),
        ...buildSourceCandidates(appPath, ["icon-win.png"]),
        ...buildSourceCandidates(appPath, ["icon.png"]),
      ];
  return pickExistingPath(candidates) || candidates[0];
}

function initializeAppIconManager(appPath, options = {}) {
  preferPublicSources = options.preferPublic === true;
  useMacIconSources = options.isMac === true;
  currentVariant = DEFAULT_VARIANT;
  currentIconPath = resolveOriginalIconPath(appPath);
  return currentIconPath;
}

function getAppIconPath(appPath) {
  if (!currentIconPath) {
    return initializeAppIconManager(appPath);
  }
  return currentIconPath;
}

function createNativeImage(nativeImage, iconPath) {
  if (!nativeImage || !iconPath || !fs.existsSync(iconPath)) return null;
  try {
    // Read from disk so regenerated assets at the same path refresh immediately.
    return nativeImage.createFromBuffer(fs.readFileSync(iconPath));
  } catch {
    try {
      return nativeImage.createFromPath(iconPath);
    } catch {
      return null;
    }
  }
}

module.exports = {
  DEFAULT_VARIANT,
  VALID_VARIANTS,
  isValidAppIconVariant,
  normalizeAppIconVariant,
  initializeAppIconManager,
  getAppIconPath,
};
