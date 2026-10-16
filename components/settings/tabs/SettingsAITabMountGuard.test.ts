import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../../..", import.meta.url));

test("AI settings re-arms its mount guard so CLI path detection cannot hang", () => {
  const source = readFileSync(
    join(root, "components/settings/tabs/SettingsAITab.tsx"),
    "utf8",
  );

  // Regression guard: the mount flag used by every `isCurrentRequest()` check
  // must be set back to true inside an effect. StrictMode and Fast Refresh run
  // an effect's cleanup while keeping refs, so a flag that is only ever set to
  // false drops each resolved CLI path and leaves the agent cards stuck on
  // "Detecting..." forever. The first effect in this file is that guard effect.
  const reArmEffect = /useEffect\(\(\) => \{[\s\S]*?mountedRef\.current = true;[\s\S]*?\}, \[\]\);/;
  assert.match(source, reArmEffect, "mountedRef must be re-armed on mount");
});
