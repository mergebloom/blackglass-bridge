import { lstat, mkdtemp, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

const STAGING_PREFIX = ".blackglass-package-";

export async function withPackageStaging<T>(
  outputAppArgument: string,
  operation: (stagingRoot: string) => Promise<T>,
): Promise<T> {
  const outputApp = resolve(outputAppArgument);
  const outputDirectory = dirname(outputApp);
  const stagingRoot = await mkdtemp(join(outputDirectory, STAGING_PREFIX));
  assertPackageStagingPath(stagingRoot, outputDirectory);
  try {
    return await operation(stagingRoot);
  } finally {
    await cleanupPackageStaging(stagingRoot, outputDirectory);
  }
}

async function cleanupPackageStaging(
  stagingRoot: string,
  outputDirectory: string,
): Promise<void> {
  assertPackageStagingPath(stagingRoot, outputDirectory);
  let entry;
  try {
    entry = await lstat(stagingRoot);
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
  if (entry.isSymbolicLink() || !entry.isDirectory()) {
    throw new Error("Refusing to remove a replaced package staging directory");
  }
  await rm(stagingRoot, { recursive: true, force: true });
}

function assertPackageStagingPath(path: string, outputDirectory: string): void {
  const name = basename(path);
  if (
    dirname(path) !== outputDirectory ||
    !name.startsWith(STAGING_PREFIX) ||
    name.length <= STAGING_PREFIX.length
  ) {
    throw new Error("Unsafe package staging path");
  }
}

function isMissing(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}
