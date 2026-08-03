import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  prepareCheckpointPublication,
  preserveFailedCheckpointCapture,
  publishCheckpoint,
} from "../tools/checkpoint-publication";
import {
  RELEASE_UI_CHECKPOINT_PROOF_SCHEMA_VERSION,
  assertReleaseUiCheckpointContent,
  assertReleaseUiCheckpointProof,
  releasePrimaryUiCheckpoints,
  releaseUiCheckpoints,
} from "../tools/release-e2e-ui";

describe("transactional checkpoint publication", () => {
  test("chains clean recovery after the six primary Sync checkpoints", () => {
    const all = releaseUiCheckpoints("1.12.7");
    expect(releasePrimaryUiCheckpoints("1.12.7")).toEqual(all.slice(0, -1));
    expect(all).toHaveLength(7);
    expect(all.at(-1)).toMatchObject({
      client: "client-b",
      path: "evidence/recovery/client-b-restored",
    });
  });

  test("validates all seven proof links and rejects a changed terminal predecessor", () => {
    const runManifestSha256 = "1".repeat(64);
    const releaseManifestSha256 = "2".repeat(64);
    const launchIdentitySha256 = "3".repeat(64);
    let previousCheckpointProofSha256: string | null = null;
    let terminal: { checkpoint: ReturnType<typeof releaseUiCheckpoints>[number]; proof: any } | null = null;
    for (const [index, checkpoint] of releaseUiCheckpoints("1.12.7").entries()) {
      const stateBytes = Buffer.from(`state-${index}`);
      const screenshotBytes = Buffer.from(`screenshot-${index}`);
      const observedAt = `2026-08-03T12:00:0${index}.000Z`;
      const proof = {
        schemaVersion: RELEASE_UI_CHECKPOINT_PROOF_SCHEMA_VERSION,
        scenarioId: "E2E-RELEASE-SYNC-RECOVERY",
        checkpoint: checkpoint.path,
        client: checkpoint.client,
        observedAt,
        previousCheckpointProofSha256,
        runManifestSha256,
        releaseManifestSha256,
        launchIdentitySha256,
        uiStateSha256: digest(stateBytes),
        screenshotSha256: digest(screenshotBytes),
      };
      expect(() => assertReleaseUiCheckpointProof({
        checkpoint,
        proof,
        observedAt,
        previousCheckpointProofSha256,
        runManifestSha256,
        releaseManifestSha256,
        launchIdentitySha256,
        stateBytes,
        screenshotBytes,
      })).not.toThrow();
      previousCheckpointProofSha256 = digest(Buffer.from(`${JSON.stringify(proof)}\n`));
      terminal = { checkpoint, proof };
    }
    const terminalState = Buffer.from("state-6");
    const terminalScreenshot = Buffer.from("screenshot-6");
    expect(() => assertReleaseUiCheckpointProof({
      checkpoint: terminal!.checkpoint,
      proof: { ...terminal!.proof, previousCheckpointProofSha256: "f".repeat(64) },
      observedAt: terminal!.proof.observedAt,
      previousCheckpointProofSha256: terminal!.proof.previousCheckpointProofSha256,
      runManifestSha256,
      releaseManifestSha256,
      launchIdentitySha256,
      stateBytes: terminalState,
      screenshotBytes: terminalScreenshot,
    })).toThrow("Malformed or unchained");
  });

  test("uses one strict terminal content contract before and after publication", () => {
    const checkpoint = releaseUiCheckpoints("1.12.7").at(-1)!;
    const launchStartedAt = "2026-08-03T12:00:00.000Z";
    const accepted = {
      observedAt: "2026-08-03T12:00:01.000Z",
      bodyText: "# Recovery Drill Home",
      accessibleText: ["Fully synced"],
    };
    expect(() => assertReleaseUiCheckpointContent(
      checkpoint,
      accepted,
      launchStartedAt,
      Date.parse(accepted.observedAt),
    )).not.toThrow();
    expect(() => assertReleaseUiCheckpointContent(checkpoint, {
      ...accepted,
      bodyText: "Fully synced",
      accessibleText: ["Recovery Drill Home"],
    }, launchStartedAt, Date.parse(accepted.observedAt))).toThrow(
      "body is missing required text",
    );
    expect(() => assertReleaseUiCheckpointContent(checkpoint, {
      ...accepted,
      observedAt: launchStartedAt,
    }, launchStartedAt, Date.parse(accepted.observedAt))).toThrow(
      "invalid observation time",
    );
  });

  test("quarantines an interrupted pair and permits a clean recapture", async () => {
    const root = await mkdtemp(join(tmpdir(), "blackglass-checkpoint-"));
    try {
      const evidence = join(root, "evidence");
      await mkdir(evidence);
      const paths = {
        screenshot: join(evidence, "step.png"),
        state: join(evidence, "step.json"),
        proof: join(evidence, "step.proof.json"),
      };
      await writeFile(paths.screenshot, "partial screenshot");
      await writeFile(paths.state, "partial state");
      await prepareCheckpointPublication(paths, root, "phase/step");
      const quarantines = (await readdir(evidence)).filter((name) =>
        name.startsWith(".interrupted-checkpoint-"),
      );
      expect(quarantines).toHaveLength(1);
      expect((await readdir(join(evidence, quarantines[0]!))).sort()).toEqual([
        "reason.txt",
        "step.json",
        "step.png",
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("preserves a rejected recovery view without consuming its final checkpoint", async () => {
    const root = await mkdtemp(join(tmpdir(), "blackglass-checkpoint-"));
    try {
      const evidence = join(root, "evidence", "recovery");
      await mkdir(evidence, { recursive: true });
      const staging = await mkdtemp(join(evidence, ".checkpoint-capture-"));
      await Promise.all([
        writeFile(join(staging, "capture.png"), "wrong view"),
        writeFile(join(staging, "capture.json"), "wrong state"),
      ]);
      await preserveFailedCheckpointCapture(
        staging,
        root,
        "evidence/recovery/client-b-restored",
        new Error("missing Recovery Drill Home"),
      );
      const failed = await readdir(join(root, "evidence", "failed-attempts"));
      expect(failed).toHaveLength(1);
      expect(await readFile(
        join(root, "evidence", "failed-attempts", failed[0]!, "failure.txt"),
        "utf8",
      )).toContain("missing Recovery Drill Home");
      await expect(prepareCheckpointPublication({
        screenshot: join(evidence, "client-b-restored.png"),
        state: join(evidence, "client-b-restored.json"),
        proof: join(evidence, "client-b-restored.proof.json"),
      }, root, "evidence/recovery/client-b-restored")).resolves.toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("publishes proof last and makes the checkpoint immutable", async () => {
    const root = await mkdtemp(join(tmpdir(), "blackglass-checkpoint-"));
    try {
      const evidence = join(root, "evidence");
      const staging = join(root, "staging");
      await mkdir(evidence);
      await mkdir(staging);
      const final = {
        screenshot: join(evidence, "step.png"),
        state: join(evidence, "step.json"),
        proof: join(evidence, "step.proof.json"),
      };
      const staged = {
        screenshot: join(staging, "step.png"),
        state: join(staging, "step.json"),
        proof: join(staging, "step.proof.json"),
      };
      await Promise.all([
        writeFile(staged.screenshot, "screenshot"),
        writeFile(staged.state, "state"),
        writeFile(staged.proof, "proof"),
      ]);
      await publishCheckpoint(staged, final);
      expect(await readFile(final.proof, "utf8")).toBe("proof");
      await expect(prepareCheckpointPublication(final, root, "phase/step")).rejects.toThrow(
        "Refusing to overwrite checkpoint proof",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
