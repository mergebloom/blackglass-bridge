import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  prepareCheckpointPublication,
  publishCheckpoint,
} from "../tools/checkpoint-publication";

describe("transactional checkpoint publication", () => {
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
