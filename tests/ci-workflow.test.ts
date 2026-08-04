import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const ci = readFileSync(resolve(root, ".github/workflows/ci.yml"), "utf8");
const release = readFileSync(resolve(root, ".github/workflows/release.yml"), "utf8");
const linter = readFileSync(resolve(root, "scripts/lint-actions.sh"), "utf8");

describe("GitHub workflow validation", () => {
  test("fetches complete history wherever release evidence is validated", () => {
    expect(ci.match(/fetch-depth: 0/gu)?.length).toBe(2);
    expect(release.match(/fetch-depth: 0/gu)?.length).toBe(3);
  });

  test("retries one pinned workflow-linter image through a shared entrypoint", () => {
    expect(ci).toContain("run: scripts/lint-actions.sh");
    expect(release).toContain("run: scripts/lint-actions.sh");
    expect(linter).toContain("rhysd/actionlint:1.7.12@sha256:");
    expect(linter).toContain("for attempt in 1 2 3");
    expect(linter).toContain('docker pull "$actionlint_image"');
  });
});
