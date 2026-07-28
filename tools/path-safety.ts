import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

export type ExistingPathKind = "file" | "directory";

export async function canonicalExistingPath(
  argument: string,
  label: string,
  kind: ExistingPathKind,
): Promise<string> {
  const absolute = resolve(argument);
  const leaf = await lstat(absolute);
  if (leaf.isSymbolicLink()) {
    throw new Error(`${label} must not be a symbolic link: ${absolute}`);
  }
  const canonical = await realpath(absolute);
  const canonicalStat = await lstat(canonical);
  if (
    (kind === "file" && !canonicalStat.isFile()) ||
    (kind === "directory" && !canonicalStat.isDirectory())
  ) {
    throw new Error(`${label} is not a ${kind}: ${canonical}`);
  }
  if (foldPath(absolute) === foldPath(canonical) && absolute !== canonical) {
    throw new Error(`${label} uses non-canonical path casing: ${absolute}`);
  }
  return canonical;
}

export async function canonicalOutputPath(
  argument: string,
  label: string,
): Promise<string> {
  const absolute = resolve(argument);
  const name = basename(absolute);
  if (!name || name === "." || name === "..") {
    throw new Error(`${label} has an unsafe basename`);
  }
  const parent = await canonicalExistingPath(dirname(absolute), `${label} parent`, "directory");
  const canonical = join(parent, name);
  try {
    await lstat(canonical);
    throw new Error(`${label} already exists: ${canonical}`);
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") {
      throw error;
    }
  }
  return canonical;
}

export function assertNonOverlappingPaths(
  paths: Array<{ label: string; path: string }>,
): void {
  for (let leftIndex = 0; leftIndex < paths.length; leftIndex += 1) {
    const left = paths[leftIndex];
    if (!left) continue;
    for (let rightIndex = leftIndex + 1; rightIndex < paths.length; rightIndex += 1) {
      const right = paths[rightIndex];
      if (!right) continue;
      if (pathsOverlap(left.path, right.path)) {
        throw new Error(
          `${left.label} and ${right.label} must not overlap: ${left.path} / ${right.path}`,
        );
      }
    }
  }
}

export function assertPathWithin(
  child: string,
  root: string,
  label: string,
  allowEqual = false,
): void {
  const childFolded = foldPath(child);
  const rootFolded = foldPath(root);
  if (
    (!allowEqual && childFolded === rootFolded) ||
    (childFolded !== rootFolded && !childFolded.startsWith(`${rootFolded}${sep}`))
  ) {
    throw new Error(`${label} must be inside ${root}: ${child}`);
  }
}

export async function assertNoSymlinkSegments(
  root: string,
  child: string,
  label: string,
): Promise<void> {
  assertPathWithin(child, root, label, true);
  const relativePath = relative(root, child);
  let current = root;
  for (const segment of relativePath.split(sep).filter(Boolean)) {
    current = join(current, segment);
    if ((await lstat(current)).isSymbolicLink()) {
      throw new Error(`${label} must not traverse a symbolic link: ${current}`);
    }
  }
}

export function pathsEqual(left: string, right: string): boolean {
  return foldPath(left) === foldPath(right);
}

function pathsOverlap(left: string, right: string): boolean {
  const leftFolded = foldPath(left);
  const rightFolded = foldPath(right);
  return (
    leftFolded === rightFolded ||
    leftFolded.startsWith(`${rightFolded}${sep}`) ||
    rightFolded.startsWith(`${leftFolded}${sep}`)
  );
}

function foldPath(value: string): string {
  return resolve(value).normalize("NFC").toLocaleLowerCase("en-US");
}
