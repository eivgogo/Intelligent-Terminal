import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const dialogSource = readFileSync(
  new URL("./PortForwardHostKeyDialog.tsx", import.meta.url),
  "utf8",
);

test("port-forward host-key dialog is marked with the outside-click guard marker", () => {
  assert.match(dialogSource, /data-port-forward-host-key-dialog="true"/);
  assert.match(dialogSource, /overlayClassName="port-forward-host-key-dialog-layer"/);
  assert.match(dialogSource, /w-\[calc\(100vw-1\.5rem\)\]/);
  assert.match(dialogSource, /rounded-lg/);
});
