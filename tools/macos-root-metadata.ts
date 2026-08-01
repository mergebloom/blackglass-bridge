import { createHash } from "node:crypto";
import { lstat, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { stableJson } from "./stable-json";
import { MACOS_PACKAGING_EXECUTABLES } from "./packaging-toolchain";

export const MACOS_ROOT_METADATA_FORMAT_VERSION = 2;

export const ALLOWED_MACOS_APP_ROOT_XATTRS = [
  "com.apple.macl",
  "com.apple.provenance",
] as const;

export interface MacOSRootMetadata {
  formatVersion: typeof MACOS_ROOT_METADATA_FORMAT_VERSION;
  sha256: string;
  mode: 493;
  bsdFlags: 0;
  ownerUidMatchesProcess: true;
  quarantineAbsent: true;
  entriesChecked: number;
  entriesSha256: string;
  allEntriesOwnedByProcess: true;
  allEntriesBsdFlagsZero: true;
  allEntriesAclFree: true;
  unsupportedXattrsAbsent: true;
  xattrs: Array<{
    name: (typeof ALLOWED_MACOS_APP_ROOT_XATTRS)[number];
    bytes: number;
    sha256: string;
  }>;
  descendantXattrs: {
    allowedNames: readonly ["com.apple.provenance"];
    entries: number;
    sha256: string;
  };
}

export async function clearMacOSAppExtendedAttributes(
  appArgument: string,
): Promise<void> {
  const appPath = resolve(appArgument);
  const rootStat = await lstat(appPath);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error(`macOS app xattr target must be a real directory: ${appPath}`);
  }
  for (const entry of await listMetadataEntries(appPath)) {
    const arguments_: string[] = [MACOS_PACKAGING_EXECUTABLES.xattr, "-c"];
    if (entry.type === "symlink") arguments_.push("-s");
    arguments_.push(entry.fullPath);
    run(arguments_);
  }
}

export async function inspectMacOSRootMetadata(
  appArgument: string,
): Promise<MacOSRootMetadata> {
  const appPath = resolve(appArgument);
  const rootStat = await lstat(appPath);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error(`macOS app root metadata target must be a real directory: ${appPath}`);
  }
  const mode = rootStat.mode & 0o777;
  if (mode !== 0o755) {
    throw new Error(`macOS app root mode must be 0755, found 0${mode.toString(8)}`);
  }
  const processUid = process.getuid?.();
  if (processUid === undefined || rootStat.uid !== processUid) {
    throw new Error("macOS app root must be owned by the packaging user");
  }
  const entries = await listMetadataEntries(appPath);
  const descendantXattrEntries: Array<{
    path: string;
    name: "com.apple.provenance";
    bytes: number;
    sha256: string;
  }> = [];
  for (const entry of entries) {
    if (entry.uid !== processUid) {
      throw new Error(`macOS app entry is not owned by the packaging user: ${entry.path}`);
    }
    const flags = parseUnsignedInteger(
      runText([MACOS_PACKAGING_EXECUTABLES.stat, "-f", "%f", entry.fullPath]),
      `macOS app BSD flags for ${entry.path}`,
    );
    if (flags !== 0) {
      throw new Error(`macOS app entry has unsupported BSD flags: ${entry.path}: ${flags}`);
    }
    const acl = runText(
      [MACOS_PACKAGING_EXECUTABLES.ls, "-lde", entry.fullPath],
      true,
    );
    if (acl.split("\n").slice(1).some((line) => /^\s*\d+:\s/u.test(line))) {
      throw new Error(`macOS app entry has an unsupported ACL: ${entry.path}`);
    }
    if (entry.path !== ".") {
      const names = listXattrs(entry.fullPath, entry.type === "symlink");
      for (const name of names) {
        if (name !== "com.apple.provenance") {
          throw new Error(
            `macOS app descendant has an unsupported extended attribute: ` +
              `${entry.path}: ${name}`,
          );
        }
        descendantXattrEntries.push({
          path: entry.path,
          name,
          ...readXattr(entry.fullPath, name, entry.type === "symlink"),
        });
      }
    }
  }

  const names = listXattrs(appPath, false);
  if (new Set(names).size !== names.length) {
    throw new Error("macOS app root has duplicate extended attributes");
  }
  for (const name of names) {
    if (!ALLOWED_MACOS_APP_ROOT_XATTRS.includes(
      name as (typeof ALLOWED_MACOS_APP_ROOT_XATTRS)[number],
    )) {
      throw new Error(`macOS app root has unsupported extended attribute: ${name}`);
    }
  }
  const xattrs = names.map((name) => ({
    name: name as (typeof ALLOWED_MACOS_APP_ROOT_XATTRS)[number],
    ...readXattr(appPath, name, false),
  }));
  const identity = {
    formatVersion: MACOS_ROOT_METADATA_FORMAT_VERSION,
    mode: 0o755,
    bsdFlags: 0,
    ownerUidMatchesProcess: true,
    quarantineAbsent: true,
    entriesChecked: entries.length,
    entriesSha256: createHash("sha256")
      .update(stableJson(entries.map(({ path, type }) => ({ path, type }))))
      .digest("hex"),
    allEntriesOwnedByProcess: true,
    allEntriesBsdFlagsZero: true,
    allEntriesAclFree: true,
    unsupportedXattrsAbsent: true,
    xattrs,
    descendantXattrs: {
      allowedNames: ["com.apple.provenance"],
      entries: descendantXattrEntries.length,
      sha256: createHash("sha256")
        .update(stableJson(descendantXattrEntries))
        .digest("hex"),
    },
  } as const;
  const metadata: MacOSRootMetadata = {
    ...identity,
    sha256: createHash("sha256").update(stableJson(identity)).digest("hex"),
  };
  assertMacOSRootMetadata(metadata);
  return metadata;
}

export function assertMacOSRootMetadata(
  value: unknown,
): asserts value is MacOSRootMetadata {
  if (
    !isRecord(value) ||
    value.formatVersion !== MACOS_ROOT_METADATA_FORMAT_VERSION ||
    value.mode !== 0o755 ||
    value.bsdFlags !== 0 ||
    value.ownerUidMatchesProcess !== true ||
    value.quarantineAbsent !== true ||
    !Number.isSafeInteger(value.entriesChecked) ||
    (value.entriesChecked as number) < 1 ||
    !isSha256(value.entriesSha256) ||
    value.allEntriesOwnedByProcess !== true ||
    value.allEntriesBsdFlagsZero !== true ||
    value.allEntriesAclFree !== true ||
    value.unsupportedXattrsAbsent !== true ||
    !isSha256(value.sha256) ||
    !Array.isArray(value.xattrs) ||
    !isRecord(value.descendantXattrs) ||
    !Array.isArray(value.descendantXattrs.allowedNames) ||
    value.descendantXattrs.allowedNames.length !== 1 ||
    value.descendantXattrs.allowedNames[0] !== "com.apple.provenance" ||
    !Number.isSafeInteger(value.descendantXattrs.entries) ||
    (value.descendantXattrs.entries as number) < 0 ||
    !isSha256(value.descendantXattrs.sha256)
  ) {
    throw new Error("Invalid macOS app root metadata");
  }
  let previous = "";
  for (const item of value.xattrs) {
    if (
      !isRecord(item) ||
      !ALLOWED_MACOS_APP_ROOT_XATTRS.includes(
        item.name as (typeof ALLOWED_MACOS_APP_ROOT_XATTRS)[number],
      ) ||
      typeof item.name !== "string" ||
      (previous && compareStrings(previous, item.name) >= 0) ||
      !Number.isSafeInteger(item.bytes) ||
      (item.bytes as number) < 0 ||
      !isSha256(item.sha256)
    ) {
      throw new Error("Invalid macOS app root extended-attribute evidence");
    }
    previous = item.name;
  }
  const { sha256, ...identity } = value;
  if (sha256 !== createHash("sha256").update(stableJson(identity)).digest("hex")) {
    throw new Error("macOS app root metadata digest is inconsistent");
  }
}

interface MetadataEntry {
  path: string;
  fullPath: string;
  type: "directory" | "file" | "symlink";
  uid: number;
}

async function listMetadataEntries(root: string): Promise<MetadataEntry[]> {
  const rootStat = await lstat(root);
  const entries: MetadataEntry[] = [
    { path: ".", fullPath: root, type: "directory", uid: rootStat.uid },
  ];
  await walkMetadataEntries(root, "", entries);
  entries.sort((left, right) => compareStrings(left.path, right.path));
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.path)) {
      throw new Error(`macOS app metadata contains a duplicate normalized path: ${entry.path}`);
    }
    seen.add(entry.path);
  }
  return entries;
}

async function walkMetadataEntries(
  directory: string,
  parent: string,
  output: MetadataEntry[],
): Promise<void> {
  const children = await readdir(directory, { withFileTypes: true });
  children.sort((left, right) => compareStrings(left.name, right.name));
  for (const child of children) {
    const path = (parent ? `${parent}/${child.name}` : child.name).normalize("NFC");
    const fullPath = join(directory, child.name);
    const stat = await lstat(fullPath);
    let type: MetadataEntry["type"];
    if (stat.isDirectory()) type = "directory";
    else if (stat.isFile()) type = "file";
    else if (stat.isSymbolicLink()) type = "symlink";
    else throw new Error(`macOS app contains an unsupported filesystem entry: ${path}`);
    output.push({ path, fullPath, type, uid: stat.uid });
    if (type === "directory") {
      await walkMetadataEntries(fullPath, path, output);
    }
  }
}

function listXattrs(path: string, symbolicLink: boolean): string[] {
  const arguments_: string[] = [MACOS_PACKAGING_EXECUTABLES.xattr];
  if (symbolicLink) arguments_.push("-s");
  arguments_.push(path);
  const output = runText(arguments_, true);
  const names = output
    ? output.split("\n").map((name) => name.trim()).filter(Boolean)
    : [];
  names.sort(compareStrings);
  return names;
}

function readXattr(
  path: string,
  name: string,
  symbolicLink: boolean,
): { bytes: number; sha256: string } {
  const arguments_: string[] = [
    MACOS_PACKAGING_EXECUTABLES.xattr,
    "-p",
    "-x",
  ];
  if (symbolicLink) arguments_.push("-s");
  arguments_.push(name, path);
  const hex = runText(arguments_).replaceAll(/\s+/gu, "");
  if (hex.length % 2 !== 0 || !/^[a-f0-9]*$/iu.test(hex)) {
    throw new Error(`macOS app extended attribute is malformed: ${name}`);
  }
  const bytes = Buffer.from(hex, "hex");
  return {
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

function runText(arguments_: string[], allowEmpty = false): string {
  const result = Bun.spawnSync(arguments_, { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    throw new Error(Buffer.from(result.stderr).toString("utf8").trim());
  }
  const output = Buffer.from(result.stdout).toString("utf8").trim();
  if (!allowEmpty && output.length === 0) {
    throw new Error(`Command returned no metadata: ${arguments_[0]}`);
  }
  return output;
}

function run(arguments_: string[]): void {
  const result = Bun.spawnSync(arguments_, { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    throw new Error(Buffer.from(result.stderr).toString("utf8").trim());
  }
}

function parseUnsignedInteger(value: string, label: string): number {
  if (!/^\d+$/u.test(value)) throw new Error(`${label} is invalid`);
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error(`${label} is invalid`);
  return number;
}

function compareStrings(left: string, right: string): number {
  return Buffer.from(left).compare(Buffer.from(right));
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
