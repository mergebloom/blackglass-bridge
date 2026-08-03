import { mkdir, mkdtemp, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export interface CheckpointPublicationPaths {
  screenshot: string;
  state: string;
  proof: string;
}

export async function prepareCheckpointPublication(
  paths: CheckpointPublicationPaths,
  runRoot: string,
  checkpoint: string,
): Promise<void> {
  await mkdir(dirname(paths.screenshot), { recursive: true, mode: 0o700 });
  if (await fileExists(paths.proof)) {
    throw new Error(`Refusing to overwrite checkpoint proof: ${paths.proof}`);
  }
  if (await fileExists(paths.screenshot) || await fileExists(paths.state)) {
    const quarantine = await mkdtemp(join(runRoot, "evidence", ".interrupted-checkpoint-"));
    for (const source of [paths.screenshot, paths.state]) {
      if (await fileExists(source)) await rename(source, join(quarantine, basename(source)));
    }
    await writeFile(
      join(quarantine, "reason.txt"),
      `Interrupted checkpoint publication preserved for ${checkpoint}\n`,
      { flag: "wx", mode: 0o600 },
    );
  }
}

export async function publishCheckpoint(
  staged: CheckpointPublicationPaths,
  final: CheckpointPublicationPaths,
): Promise<void> {
  if (await fileExists(final.proof)) {
    throw new Error(`Refusing to overwrite checkpoint proof: ${final.proof}`);
  }
  await rename(staged.screenshot, final.screenshot);
  await rename(staged.state, final.state);
  await rename(staged.proof, final.proof);
}

export async function preserveFailedCheckpointCapture(
  staging: string,
  runRoot: string,
  checkpoint: string,
  error: unknown,
): Promise<void> {
  await writeFile(join(staging, "failure.txt"), `${String(error)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  const failedRoot = join(runRoot, "evidence", "failed-attempts");
  await mkdir(failedRoot, { recursive: true, mode: 0o700 });
  await rename(
    staging,
    join(failedRoot, `${checkpoint.replaceAll("/", "-")}-${basename(staging)}`),
  );
}

export async function fileExists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
