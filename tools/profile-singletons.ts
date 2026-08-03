import { lstat, unlink } from "node:fs/promises";
import { join } from "node:path";

const CHROMIUM_PROFILE_SINGLETONS = [
  "SingletonLock",
  "SingletonSocket",
  "SingletonCookie",
] as const;

export async function removeProfileSingletonArtifacts(profile: string): Promise<void> {
  for (const name of CHROMIUM_PROFILE_SINGLETONS) {
    const path = join(profile, name);
    let metadata;
    try {
      metadata = await lstat(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (!metadata.isSymbolicLink()) {
      throw new Error(`Refusing to remove a non-symlink profile singleton artifact: ${path}`);
    }
    await unlink(path);
  }
}
