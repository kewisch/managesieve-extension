import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("manifest declares localhost callback as an MV3 host permission", async () => {
  const manifest = JSON.parse(await readFile(new URL("../src/manifest.json", import.meta.url), "utf8"));

  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.permissions.includes("identity"), false);
  assert.equal(manifest.permissions.includes("webRequest"), true);
  assert.equal(manifest.permissions.includes("webNavigation"), true);
  assert.equal(manifest.permissions.includes("http://localhost/*"), false);
  assert.equal(manifest.permissions.includes("https://localhost/*"), false);
  assert.deepEqual(manifest.host_permissions, ["http://localhost/*", "https://localhost/*"]);
  assert.equal(manifest.options_ui.page, "content/manage.html");
  assert.deepEqual(manifest.background.scripts, ["background/index.mjs"]);
  assert.equal(manifest.background.type, "module");
});
