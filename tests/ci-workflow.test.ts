import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const ci = readFileSync(resolve(root, ".github/workflows/ci.yml"), "utf8");
const pages = readFileSync(resolve(root, ".github/workflows/pages.yml"), "utf8");
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
    expect(linter).toContain(".github/workflows/pages.yml");
    expect(linter).toContain("rhysd/actionlint:1.7.12@sha256:");
    expect(linter).toContain("for attempt in 1 2 3");
    expect(linter).toContain('docker pull "$actionlint_image"');
  });

  test("publishes only the static documentation with pinned actions", () => {
    expect(pages).toContain("actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1");
    expect(pages).toContain("actions/configure-pages@45bfe0192ca1faeb007ade9deae92b16b8254a0d");
    expect(pages).toContain("actions/upload-pages-artifact@fc324d3547104276b827a68afc52ff2a11cc49c9");
    expect(pages).toContain("actions/deploy-pages@cd2ce8fcbc39b97be8ca5fce6e763baed58fa128");
    expect(pages).toContain("contents: read");
    expect(pages).toContain("pages: write");
    expect(pages).toContain("id-token: write");
    expect(pages).toContain("path: site");
  });
});
