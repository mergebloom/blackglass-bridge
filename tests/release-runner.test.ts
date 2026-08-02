import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");

describe("immutable release runner", () => {
  test("revalidates the candidate on every run and before every stage", async () => {
    const source = await readFile(resolve(root, "tools/run-release-candidate.ts"), "utf8");
    expect(source.indexOf('name: "doctor"')).toBeLessThan(source.indexOf("const stages"));
    expect(source).toContain("for (const stage of stages)");
    expect(source).toContain("await assertReleaseCandidateMatchesCheckouts");
    expect(source).toContain("candidateSha256");
  });

  test("reuses only candidate-bound state and exact server builds", async () => {
    const source = await readFile(resolve(root, "tools/run-release-candidate.ts"), "utf8");
    expect(source).toContain("Release pipeline state is malformed or belongs to another candidate");
    expect(source).toContain("BLACKGLASS_TESTED_SOURCE_REVISION");
    expect(source).toContain("revalidateOnResume: true");
    expect(source).toContain("has partial outputs");
    expect(source).toContain('join(workRoot, "pipeline.lock")');
    expect(source).toContain('flag: "wx"');
    expect(source).toContain("Refusing to remove a changed release pipeline lock");
  });

  test("prepares two independent packages and reproducibility evidence", async () => {
    const source = await readFile(resolve(root, "tools/run-release-candidate.ts"), "utf8");
    expect(source).toContain('packageStage("a"');
    expect(source).toContain('packageStage("b"');
    expect(source).toContain("tools/verify-macos-reproducibility.ts");
    expect(source).toContain("tools/prepare-e2e.ts");
    expect(source).toContain("tools/prepare-e2e-tls.ts");
    expect(source).toContain('join(runRoot, "run-manifest.json")');
    expect(source).not.toContain('join(runRoot, "run.json")');
  });

  test("treats an old native binary as rebuildable cache state", async () => {
    const source = await readFile(
      resolve(root, "tools/doctor-release-candidate.ts"),
      "utf8",
    );
    expect(source).toContain('"missing" | "exact" | "stale"');
    expect(source).not.toContain(
      "Existing native server binary does not match the release candidate",
    );
  });
});
