import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test } from "bun:test";

test("multi-window cleanup remains reachable and verifies every Settings window closed", async () => {
  const source = await readFile(resolve(import.meta.dir, "../tools/e2e-ui.mjs"), "utf8");
  expect(source).toContain('action !== "close-auxiliary" && auxiliaryPages.length > 1');
  expect(source).toContain("auxiliaryPages.some((auxiliary) => !auxiliary.isClosed())");
  expect(source).toContain("One or more auxiliary Settings renderers remained after cleanup");
});

test("live E2E controls target the bound window and native checkbox input", async () => {
  const source = await readFile(
    resolve(import.meta.dir, "../tools/e2e-ui.mjs"),
    "utf8",
  );
  expect(source).toContain('action === "bring-to-front"');
  expect(source).toContain("await boundPage.bringToFront()");
  expect(source).toContain("await checkbox.evaluate((element) => element.click())");
  expect(source).not.toContain("await container.click({ force: true })");
});

test("release UI checkpoints validate before immutable proof publication", async () => {
  const source = await readFile(
    resolve(import.meta.dir, "../tools/capture-release-e2e-checkpoint.ts"),
    "utf8",
  );
  expect(source).toContain("prepareCheckpointPublication(paths");
  expect(source).toContain("Release UI checkpoint is missing required text");
  expect(source.indexOf("is missing required text")).toBeLessThan(
    source.indexOf("publishCheckpoint(staged, paths)"),
  );
  expect(source).toContain("previousCheckpointProofSha256");
  expect(source).toContain("preserveFailedCheckpointCapture");
});
