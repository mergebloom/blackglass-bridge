import { createHash } from "node:crypto";
import { lstat, readFile, readdir, readlink, realpath } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { assertPathWithin } from "./path-safety";

export const TREE_IDENTITY_FORMAT_VERSION = 1;

export interface TreeIdentity {
  formatVersion: typeof TREE_IDENTITY_FORMAT_VERSION;
  sha256: string;
  entries: number;
  files: number;
  directories: number;
  symlinks: number;
  fileBytes: number;
}

type TreeEntry =
  | { path: string; type: "directory"; mode: number }
  | { path: string; type: "file"; mode: number; bytes: number; sha256: string }
  | { path: string; type: "symlink"; mode: number; target: string };

export async function computeTreeIdentity(rootArgument: string): Promise<TreeIdentity> {
  const root = await realpath(resolve(rootArgument));
  if (!(await lstat(root)).isDirectory()) {
    throw new Error(`Tree identity root is not a directory: ${root}`);
  }
  const entries: TreeEntry[] = [];
  await walk(root, root, "", entries);
  entries.sort((left, right) => compareStrings(left.path, right.path));
  const seen = new Set<string>();
  const digest = createHash("sha256");
  let files = 0;
  let directories = 0;
  let symlinks = 0;
  let fileBytes = 0;
  for (const entry of entries) {
    if (seen.has(entry.path)) {
      throw new Error(`Tree contains duplicate normalized path: ${entry.path}`);
    }
    seen.add(entry.path);
    digest.update(JSON.stringify(entry));
    digest.update("\n");
    if (entry.type === "file") {
      files += 1;
      fileBytes += entry.bytes;
    } else if (entry.type === "directory") {
      directories += 1;
    } else {
      symlinks += 1;
    }
  }
  return {
    formatVersion: TREE_IDENTITY_FORMAT_VERSION,
    sha256: digest.digest("hex"),
    entries: entries.length,
    files,
    directories,
    symlinks,
    fileBytes,
  };
}

async function walk(
  root: string,
  directory: string,
  parent: string,
  output: TreeEntry[],
): Promise<void> {
  const children = await readdir(directory, { withFileTypes: true });
  children.sort((left, right) => compareStrings(left.name, right.name));
  for (const child of children) {
    const path = parent ? `${parent}/${child.name}` : child.name;
    const normalizedPath = path.normalize("NFC");
    const fullPath = join(directory, child.name);
    const stat = await lstat(fullPath);
    const mode = stat.mode & 0o777;
    if (stat.isDirectory()) {
      output.push({ path: normalizedPath, type: "directory", mode });
      await walk(root, fullPath, normalizedPath, output);
    } else if (stat.isFile()) {
      const bytes = await readFile(fullPath);
      output.push({
        path: normalizedPath,
        type: "file",
        mode,
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
    } else if (stat.isSymbolicLink()) {
      const target = await readlink(fullPath);
      if (target.startsWith(sep)) {
        throw new Error(`Tree contains an absolute symbolic link: ${normalizedPath}`);
      }
      const resolvedTarget = await realpath(resolve(dirname(fullPath), target));
      assertPathWithin(resolvedTarget, root, `Symbolic link ${normalizedPath}`, true);
      output.push({
        path: normalizedPath,
        type: "symlink",
        mode,
        target: target.normalize("NFC"),
      });
    } else {
      throw new Error(`Tree contains an unsupported filesystem entry: ${normalizedPath}`);
    }
  }
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
