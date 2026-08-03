import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  releaseStageResumeDecision,
  releaseUnboundOutputDecision,
} from "../tools/release-stage-resume";

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
    expect(source).toContain("without an exact completed-stage receipt");
    expect(source).toContain("outputs changed after their receipt was written");
    expect(source).toContain("computeTreeIdentity");
    expect(source).toContain('join(workRoot, "pipeline.lock")');
    expect(source).toContain('flag: "wx"');
    expect(source).toContain("Refusing to remove a changed release pipeline lock");
  });

  test("revalidates a receipted stage without misclassifying its exact output", () => {
    expect(releaseStageResumeDecision({ hasReceipt: true, revalidateOnResume: true }))
      .toBe("revalidate");
    expect(releaseStageResumeDecision({ hasReceipt: true, revalidateOnResume: false }))
      .toBe("resume");
    expect(releaseStageResumeDecision({ hasReceipt: false, revalidateOnResume: true }))
      .toBe("run-new");
  });

  test("permits only a complete explicitly rebuildable unreceipted output", () => {
    expect(releaseUnboundOutputDecision({
      presence: "missing",
      rebuildsExistingOutputs: false,
    })).toBe("run");
    expect(releaseUnboundOutputDecision({
      presence: "complete",
      rebuildsExistingOutputs: true,
    })).toBe("run");
    expect(releaseUnboundOutputDecision({
      presence: "complete",
      rebuildsExistingOutputs: false,
    })).toBe("reject");
    expect(releaseUnboundOutputDecision({
      presence: "partial",
      rebuildsExistingOutputs: true,
    })).toBe("reject");
  });

  test("prepares two independent packages and reproducibility evidence", async () => {
    const source = await readFile(resolve(root, "tools/run-release-candidate.ts"), "utf8");
    expect(source).toContain('packageStage("a"');
    expect(source).toContain('packageStage("b"');
    expect(source).toContain('"blackglass-a.asar"');
    expect(source).toContain('"blackglass-b.asar"');
    expect(source).toContain(`name: \`client-\${rendererVersion}-patch-a\``);
    expect(source).toContain(`name: \`client-\${rendererVersion}-patch-b\``);
    expect(source).toContain('"standalone-bridge-a"');
    expect(source).toContain('"standalone-bridge-b"');
    expect(source).toContain(
      'const standaloneReproducibility = join(workRoot, "standalone-reproducibility.json")',
    );
    expect(source).not.toContain(
      'const standaloneReproducibility = join(rendererRoot, "standalone-reproducibility.json")',
    );
    expect(source).toContain("tools/verify-standalone-reproducibility.ts");
    expect(source).toContain("tools/verify-macos-reproducibility.ts");
    expect(source).toContain("tools/prepare-e2e.ts");
    expect(source).toContain("tools/prepare-e2e-tls.ts");
    expect(source).toContain('join(runRoot, "run-manifest.json")');
    expect(source).not.toContain('join(runRoot, "run.json")');
    expect(source).toContain("runScopedStageKey(");
    expect(source).toContain("entry.key === stageResumeKey(stage)");
    expect(source).toContain('relative(resolve(root, ".data/e2e"), runRoot)');
  });

  test("runs Bridge stages from a detached exact immutable source", async () => {
    const source = await readFile(resolve(root, "tools/run-release-candidate.ts"), "utf8");
    expect(source).toContain('"worktree", "add", "--detach"');
    expect(source).toContain("assertImmutableClientSource");
    expect(source).toContain("immutableClientSource: true");
    expect(source).toContain('"status", "--porcelain=v1", "--untracked-files=all"');
    expect(source).toContain('"npm", "ci", "--ignore-scripts"');
    expect(source).toContain("assertImmutableClientDependencies");
    expect(source).toContain("tools/verify-release-dependencies.ts");
  });

  test("keeps operator E2E state in the exact clean checkout", async () => {
    const source = await readFile(resolve(root, "tools/run-release-candidate.ts"), "utf8");
    expect(source).toContain("E2E state deliberately belongs to the operator checkout");
    expect(source).toContain("const runRoot = await safeE2EOutputPath(clientRoot, runArgument)");
    const prepareStage = source.slice(
      source.indexOf('name: `client-${rendererVersion}-e2e-prepare`'),
      source.indexOf('name: `client-${rendererVersion}-e2e-tls`'),
    );
    expect(prepareStage).toContain("cwd: clientRoot");
    expect(prepareStage).not.toContain("immutableClientSource: true");
    expect(source).toContain("await assertReleaseCandidateMatchesCheckouts");
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
    const runner = await readFile(
      resolve(root, "tools/run-release-candidate.ts"),
      "utf8",
    );
    const nativeStage = runner.slice(
      runner.indexOf('name: "server-native-release"'),
      runner.indexOf('if (parsed.booleans.has("--linux"))'),
    );
    expect(nativeStage).toContain("rebuildsExistingOutputs: true");
  });

  test("finds generated apps even when LaunchServices omits them", async () => {
    const source = await readFile(resolve(root, "tools/macos-launch-preflight.m"), "utf8");
    const wrapper = await readFile(resolve(root, "tools/macos-preflight.ts"), "utf8");
    expect(source).toContain("proc_listallpids");
    expect(source).toContain("proc_pidpath");
    expect(source).toContain("/Blackglass Bridge.app/Contents/MacOS/");
    expect(wrapper).toContain('"-lproc"');
  });
});
