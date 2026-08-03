import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test } from "bun:test";

test("multi-window cleanup remains reachable and verifies every Settings window closed", async () => {
  const source = await readFile(resolve(import.meta.dir, "../tools/e2e-ui.mjs"), "utf8");
  expect(source).toContain('action !== "close-auxiliary" && auxiliaryPages.length > 1');
  expect(source).toContain("auxiliaryPages.some((auxiliary) => !auxiliary.isClosed())");
  expect(source).toContain("One or more auxiliary Settings renderers remained after cleanup");
});
