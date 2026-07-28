import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { AsarArchive } from "./asar";
import {
  TREE_IDENTITY_FORMAT_VERSION,
  type TreeIdentity,
} from "./tree-identity";

export const COMPATIBILITY_BASELINE_SCHEMA_VERSION = 3;
export const RELEASE_ANALYSIS_FORMAT_VERSION = 4;

export type FileIdentity = { bytes: number; sha256: string };
export type UnpackedJavaScriptFiles = Record<string, FileIdentity>;

type AnchorFile = "app.js" | "main.js" | "index.html";

export interface CompatibilityAnchor {
  id: string;
  file: AnchorFile;
  literal: string;
  expectedMatches: number;
}

export interface CompatibilityBaseline {
  schemaVersion: typeof COMPATIBILITY_BASELINE_SCHEMA_VERSION;
  id: string;
  rendererVersion: string;
  officialDmgSha256: string;
  sourceAppTree: TreeIdentity;
  sourceAsarSha256: string;
  sourceWrapperAsarSha256: string;
  keyFiles: Record<"app.js" | "main.js" | "index.html" | "package.json", FileIdentity>;
  javaScriptFiles: Record<string, FileIdentity>;
  unpackedJavaScriptFiles: UnpackedJavaScriptFiles;
  unpackedJavaScriptReview: {
    status: "reviewed";
    reviewedPaths: string[];
  };
  anchors: CompatibilityAnchor[];
  controlPlaneRoutes: Record<string, number>;
  syncOperations: Record<string, number>;
  syncOperationLocations: Record<string, number>;
  syncMessageShapes: Record<string, number>;
  syncMessageShapeLocations: Record<string, number>;
  syncInboundOperations: Record<string, number>;
}

export interface ReleaseDiscovery {
  rendererVersion: string;
  sourceAsarSha256: string;
  sourceAsarBytes: number;
  dataOffset: number;
  keyFiles: CompatibilityBaseline["keyFiles"];
  javaScriptFiles: CompatibilityBaseline["javaScriptFiles"];
  unpackedJavaScriptFiles: UnpackedJavaScriptFiles;
  anchorMatches: Record<string, number>;
  controlPlaneRoutes: Record<string, number>;
  syncOperations: Record<string, number>;
  syncOperationLocations: Record<string, number>;
  syncMessageShapes: Record<string, number>;
  syncMessageShapeLocations: Record<string, number>;
  syncInboundOperations: Record<string, number>;
  fileCount: number;
}

export interface CompatibilityCheck {
  id: string;
  ready: boolean;
  expected: unknown;
  actual: unknown;
}

export interface ReleaseAnalysisReport {
  formatVersion: typeof RELEASE_ANALYSIS_FORMAT_VERSION;
  baseline: {
    id: string;
    schemaVersion: typeof COMPATIBILITY_BASELINE_SCHEMA_VERSION;
    sha256: string;
  };
  artifact: {
    sha256: string;
    size: number;
    dataOffset: number;
  };
  packageVersion: string;
  ready: boolean;
  checks: CompatibilityCheck[];
  keyFiles: CompatibilityBaseline["keyFiles"];
  javaScriptFiles: CompatibilityBaseline["javaScriptFiles"];
  unpackedJavaScriptFiles: UnpackedJavaScriptFiles;
  unpackedJavaScriptReview: CompatibilityBaseline["unpackedJavaScriptReview"];
  anchorMatches: Record<string, number>;
  controlPlaneRoutes: Record<string, number>;
  syncOperations: Record<string, number>;
  syncOperationLocations: Record<string, number>;
  syncMessageShapes: Record<string, number>;
  syncMessageShapeLocations: Record<string, number>;
  syncInboundOperations: Record<string, number>;
  fileCount: number;
}

export interface LoadedCompatibilityBaseline {
  baseline: CompatibilityBaseline;
  sha256: string;
  path: string;
}

export function defaultCompatibilityBaselinePath(rendererVersion: string): string {
  if (!/^\d+\.\d+\.\d+$/u.test(rendererVersion)) {
    throw new Error(`Unsafe renderer version for baseline lookup: ${rendererVersion}`);
  }
  return resolve(import.meta.dir, `../compatibility/obsidian-${rendererVersion}.json`);
}

export async function loadCompatibilityBaseline(
  path: string,
): Promise<LoadedCompatibilityBaseline> {
  const resolvedPath = resolve(path);
  const bytes = await readFile(resolvedPath);
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(`Invalid compatibility baseline JSON: ${String(error)}`);
  }
  assertCompatibilityBaseline(value);
  return {
    baseline: value,
    sha256: sha256(bytes),
    path: resolvedPath,
  };
}

export async function loadBaselineForRenderer(
  rendererAsar: Buffer,
  baselinePath?: string,
): Promise<LoadedCompatibilityBaseline> {
  const version = rendererVersion(AsarArchive.fromBuffer(rendererAsar));
  return loadCompatibilityBaseline(
    baselinePath ?? defaultCompatibilityBaselinePath(version),
  );
}

export async function discoverUnpackedJavaScriptFiles(
  resourcesDirectoryArgument: string,
): Promise<UnpackedJavaScriptFiles> {
  const resourcesDirectory = resolve(resourcesDirectoryArgument);
  const resourcesStat = await lstat(resourcesDirectory);
  if (resourcesStat.isSymbolicLink() || !resourcesStat.isDirectory()) {
    throw new Error(`Application Resources must be a real directory: ${resourcesDirectory}`);
  }
  const discovered = new Map<string, FileIdentity>();
  for (const rootName of ["obsidian.asar.unpacked", "app.asar.unpacked"] as const) {
    const root = join(resourcesDirectory, rootName);
    let rootStat;
    try {
      rootStat = await lstat(root);
    } catch (error) {
      if (isMissingPathError(error)) continue;
      throw error;
    }
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
      throw new Error(`Unpacked ASAR root must be a real directory: ${root}`);
    }
    await walkUnpackedJavaScript(root, rootName, "", discovered);
  }
  return Object.fromEntries(
    [...discovered].sort(([left], [right]) => compareStrings(left, right)),
  );
}

export function discoverRendererRelease(
  rendererAsar: Buffer,
  anchors: CompatibilityAnchor[],
  unpackedJavaScriptFiles: UnpackedJavaScriptFiles = {},
): ReleaseDiscovery {
  const archive = AsarArchive.fromBuffer(rendererAsar);
  const appJsBuffer = archive.read("app.js");
  const mainJsBuffer = archive.read("main.js");
  const indexHtmlBuffer = archive.read("index.html");
  const packageJsonBuffer = archive.read("package.json");
  const files: Record<AnchorFile, string> = {
    "app.js": appJsBuffer.toString("utf8"),
    "main.js": mainJsBuffer.toString("utf8"),
    "index.html": indexHtmlBuffer.toString("utf8"),
  };
  const javaScriptEntries = archive.entries()
    .filter(
      (entry) =>
        /\.(?:cjs|js|mjs)$/u.test(entry.path) &&
        !entry.node.files &&
        !entry.node.unpacked,
    )
    .sort((left, right) => left.path.localeCompare(right.path));
  if (javaScriptEntries.length === 0) {
    throw new Error("Renderer archive contains no packed JavaScript files");
  }
  const javaScriptFiles: CompatibilityBaseline["javaScriptFiles"] = {};
  const routes: string[] = [];
  const operations: string[] = [];
  const operationLocations: string[] = [];
  const messageShapes: string[] = [];
  const messageShapeLocations: string[] = [];
  const inboundOperations: string[] = [];
  for (const entry of javaScriptEntries) {
    const buffer = archive.read(entry.path);
    const source = buffer.toString("utf8");
    javaScriptFiles[entry.path] = fileIdentity(buffer);
    routes.push(...collectMatches(source, /\bgw\(\s*(["'])(\/[A-Za-z0-9_./-]+)\1/gu, 2));
    const fileOperations = collectLiteralOperations(source);
    const fileShapes = collectLiteralOperationMessageShapeList(source);
    // Keep both inventories. A literal `op` property can occur in non-Sync
    // libraries, while first-field object shapes are the stronger outbound
    // protocol signal. Binding both to the reviewed baseline makes either
    // class of change visible without misclassifying unrelated JavaScript.
    operations.push(...fileOperations);
    operationLocations.push(...fileOperations.map((operation) => `${entry.path}:${operation}`));
    messageShapes.push(...fileShapes);
    messageShapeLocations.push(...fileShapes.map((shape) => `${entry.path}:${shape}`));
    inboundOperations.push(
      ...collectInboundSyncOperations(source).map((operation) => `${entry.path}:${operation}`),
    );
  }

  return {
    rendererVersion: rendererVersion(archive),
    sourceAsarSha256: sha256(rendererAsar),
    sourceAsarBytes: rendererAsar.length,
    dataOffset: archive.dataOffset,
    keyFiles: {
      "app.js": fileIdentity(appJsBuffer),
      "main.js": fileIdentity(mainJsBuffer),
      "index.html": fileIdentity(indexHtmlBuffer),
      "package.json": fileIdentity(packageJsonBuffer),
    },
    javaScriptFiles,
    unpackedJavaScriptFiles: sortedFileIdentityInventory(unpackedJavaScriptFiles),
    anchorMatches: Object.fromEntries(
      [...anchors]
        .sort((left, right) => left.id.localeCompare(right.id))
        .map((item) => [item.id, countLiteral(files[item.file], item.literal)]),
    ),
    controlPlaneRoutes: countValues(routes),
    syncOperations: countValues(operations),
    syncOperationLocations: countValues(operationLocations),
    syncMessageShapes: countValues(messageShapes),
    syncMessageShapeLocations: countValues(messageShapeLocations),
    syncInboundOperations: countValues(inboundOperations),
    fileCount: archive.entries().filter((entry) => !entry.node.files).length,
  };
}

export function analyzeRendererRelease(
  rendererAsar: Buffer,
  loaded: Pick<LoadedCompatibilityBaseline, "baseline" | "sha256">,
  unpackedJavaScriptFiles: UnpackedJavaScriptFiles = {},
): ReleaseAnalysisReport {
  const { baseline, sha256: baselineSha256 } = loaded;
  const discovery = discoverRendererRelease(
    rendererAsar,
    baseline.anchors,
    unpackedJavaScriptFiles,
  );
  const checks: CompatibilityCheck[] = [
    check("renderer-version", baseline.rendererVersion, discovery.rendererVersion),
    check("source-asar-sha256", baseline.sourceAsarSha256, discovery.sourceAsarSha256),
    check("key-files", baseline.keyFiles, discovery.keyFiles),
    check("javascript-files", baseline.javaScriptFiles, discovery.javaScriptFiles),
    check(
      "unpacked-javascript-files",
      baseline.unpackedJavaScriptFiles,
      discovery.unpackedJavaScriptFiles,
    ),
    check(
      "anchor-match-counts",
      Object.fromEntries(
        baseline.anchors
          .map((item) => [item.id, item.expectedMatches] as const)
          .sort(([left], [right]) => left.localeCompare(right)),
      ),
      discovery.anchorMatches,
    ),
    check("control-plane-routes", baseline.controlPlaneRoutes, discovery.controlPlaneRoutes),
    check("sync-operations", baseline.syncOperations, discovery.syncOperations),
    check(
      "sync-operation-locations",
      baseline.syncOperationLocations,
      discovery.syncOperationLocations,
    ),
    check("sync-message-shapes", baseline.syncMessageShapes, discovery.syncMessageShapes),
    check(
      "sync-message-shape-locations",
      baseline.syncMessageShapeLocations,
      discovery.syncMessageShapeLocations,
    ),
    check(
      "sync-inbound-operations",
      baseline.syncInboundOperations,
      discovery.syncInboundOperations,
    ),
  ];
  return {
    formatVersion: RELEASE_ANALYSIS_FORMAT_VERSION,
    baseline: {
      id: baseline.id,
      schemaVersion: COMPATIBILITY_BASELINE_SCHEMA_VERSION,
      sha256: baselineSha256,
    },
    artifact: {
      sha256: discovery.sourceAsarSha256,
      size: discovery.sourceAsarBytes,
      dataOffset: discovery.dataOffset,
    },
    packageVersion: discovery.rendererVersion,
    ready: checks.every((item) => item.ready),
    checks,
    keyFiles: discovery.keyFiles,
    javaScriptFiles: discovery.javaScriptFiles,
    unpackedJavaScriptFiles: discovery.unpackedJavaScriptFiles,
    unpackedJavaScriptReview: baseline.unpackedJavaScriptReview,
    anchorMatches: discovery.anchorMatches,
    controlPlaneRoutes: discovery.controlPlaneRoutes,
    syncOperations: discovery.syncOperations,
    syncOperationLocations: discovery.syncOperationLocations,
    syncMessageShapes: discovery.syncMessageShapes,
    syncMessageShapeLocations: discovery.syncMessageShapeLocations,
    syncInboundOperations: discovery.syncInboundOperations,
    fileCount: discovery.fileCount,
  };
}

export async function qualifyRendererRelease(
  rendererAsar: Buffer,
  baselinePath?: string,
  unpackedJavaScriptFiles: UnpackedJavaScriptFiles = {},
): Promise<{
  loadedBaseline: LoadedCompatibilityBaseline;
  report: ReleaseAnalysisReport;
}> {
  const loadedBaseline = await loadBaselineForRenderer(rendererAsar, baselinePath);
  const report = analyzeRendererRelease(
    rendererAsar,
    loadedBaseline,
    unpackedJavaScriptFiles,
  );
  if (!report.ready) {
    const failed = report.checks
      .filter((item) => !item.ready)
      .map((item) => item.id)
      .join(", ");
    throw new Error(`Renderer is not compatible with the reviewed baseline: ${failed}`);
  }
  return { loadedBaseline, report };
}

async function walkUnpackedJavaScript(
  root: string,
  rootName: string,
  parent: string,
  output: Map<string, FileIdentity>,
): Promise<void> {
  const entries = await readdir(join(root, parent), { withFileTypes: true });
  entries.sort((left, right) => compareStrings(left.name, right.name));
  for (const entry of entries) {
    const relativePath = parent ? `${parent}/${entry.name}` : entry.name;
    const normalizedPath = relativePath.normalize("NFC");
    const absolutePath = join(root, relativePath);
    const stat = await lstat(absolutePath);
    if (stat.isSymbolicLink()) {
      throw new Error(`Unpacked ASAR trees must not contain symlinks: ${absolutePath}`);
    }
    if (stat.isDirectory()) {
      await walkUnpackedJavaScript(root, rootName, relativePath, output);
      continue;
    }
    if (!stat.isFile()) {
      throw new Error(`Unpacked ASAR tree contains an unsupported entry: ${absolutePath}`);
    }
    if (!isJavaScriptPath(normalizedPath)) continue;
    const inventoryPath = `${rootName}/${normalizedPath}`;
    if (output.has(inventoryPath)) {
      throw new Error(`Duplicate normalized unpacked JavaScript path: ${inventoryPath}`);
    }
    output.set(inventoryPath, fileIdentity(await readFile(absolutePath)));
  }
}

function sortedFileIdentityInventory(
  value: UnpackedJavaScriptFiles,
): UnpackedJavaScriptFiles {
  return Object.fromEntries(
    Object.entries(value).sort(([left], [right]) => compareStrings(left, right)),
  );
}

function isJavaScriptPath(path: string): boolean {
  return /\.(?:c|m)?js$/iu.test(path);
}

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function collectLiteralOperations(input: string): string[] {
  return collectMatches(
    input,
    /\bop\s*:\s*(["'])([A-Za-z][A-Za-z0-9_-]{0,63})\1/gu,
    2,
  );
}

function collectLiteralOperationMessageShapeList(input: string): string[] {
  const shapes: string[] = [];
  const pattern = /\{\s*op\s*:\s*(["'])([A-Za-z][A-Za-z0-9_-]{0,63})\1/gu;
  for (const match of input.matchAll(pattern)) {
    if (match.index === undefined || match[2] === undefined) continue;
    const object = readObjectLiteral(input, match.index);
    const fields = topLevelObjectFields(object);
    if (fields[0] !== "op") {
      throw new Error(`Literal operation ${match[2]} is not the first message field`);
    }
    shapes.push(`${match[2]}(${fields.join(",")})`);
  }
  return shapes;
}

export function collectInboundSyncOperations(input: string): string[] {
  const operations: string[] = [];
  const marker = ".prototype.onMessage=function";
  let cursor = 0;
  while ((cursor = input.indexOf(marker, cursor)) !== -1) {
    const nextPrototype = input.indexOf(".prototype.", cursor + marker.length);
    const handler = input.slice(
      cursor,
      nextPrototype === -1 ? Math.min(input.length, cursor + 32_768) : nextPrototype,
    );
    const operationVariable = /\bvar\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*[A-Za-z_$][A-Za-z0-9_$]*\.op\b/u.exec(handler)?.[1];
    if (operationVariable) {
      const escaped = escapeRegExp(operationVariable);
      const literalFirst = new RegExp(
        `(["'])([A-Za-z][A-Za-z0-9_-]{0,63})\\1\\s*===\\s*${escaped}\\b`,
        "g",
      );
      const variableFirst = new RegExp(
        `\\b${escaped}\\s*===\\s*(["'])([A-Za-z][A-Za-z0-9_-]{0,63})\\1`,
        "g",
      );
      for (const pattern of [literalFirst, variableFirst]) {
        for (const match of handler.matchAll(pattern)) {
          if (match[2]) operations.push(match[2]);
        }
      }
    }
    cursor = nextPrototype === -1 ? input.length : nextPrototype;
  }
  return operations;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function readObjectLiteral(input: string, start: number): string {
  let braces = 0;
  let quote: "\"" | "'" | "`" | null = null;
  let escaped = false;
  for (let index = start; index < input.length; index += 1) {
    const character = input[index];
    if (character === undefined) break;
    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === "\"" || character === "'" || character === "`") {
      quote = character;
    } else if (character === "{") {
      braces += 1;
    } else if (character === "}") {
      braces -= 1;
      if (braces === 0) return input.slice(start, index + 1);
    }
  }
  throw new Error("Unterminated literal operation message object");
}

function topLevelObjectFields(object: string): string[] {
  const body = object.slice(1, -1);
  const fields: string[] = [];
  let segmentStart = 0;
  let braces = 0;
  let brackets = 0;
  let parentheses = 0;
  let quote: "\"" | "'" | "`" | null = null;
  let escaped = false;
  for (let index = 0; index <= body.length; index += 1) {
    const character = body[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === "\"" || character === "'" || character === "`") {
      quote = character;
      continue;
    }
    if (character === "{") braces += 1;
    else if (character === "}") braces -= 1;
    else if (character === "[") brackets += 1;
    else if (character === "]") brackets -= 1;
    else if (character === "(") parentheses += 1;
    else if (character === ")") parentheses -= 1;
    const boundary =
      index === body.length ||
      (character === "," && braces === 0 && brackets === 0 && parentheses === 0);
    if (!boundary) continue;
    const segment = body.slice(segmentStart, index).trim();
    const name = /^([A-Za-z_$][A-Za-z0-9_$]*)\s*:/u.exec(segment)?.[1];
    if (!name) throw new Error(`Unsupported operation message field: ${segment}`);
    fields.push(name);
    segmentStart = index + 1;
  }
  return fields;
}

function rendererVersion(archive: AsarArchive): string {
  const metadata = JSON.parse(archive.read("package.json").toString("utf8")) as {
    version?: unknown;
  };
  if (typeof metadata.version !== "string" || !/^\d+\.\d+\.\d+$/u.test(metadata.version)) {
    throw new Error("Renderer package has no semantic version");
  }
  return metadata.version;
}

function fileIdentity(value: Buffer): { bytes: number; sha256: string } {
  return { bytes: value.length, sha256: sha256(value) };
}

function countLiteral(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let cursor = 0;
  while ((cursor = haystack.indexOf(needle, cursor)) !== -1) {
    count += 1;
    cursor += needle.length;
  }
  return count;
}

function collectMatches(input: string, pattern: RegExp, group: number): string[] {
  return [...input.matchAll(pattern)]
    .map((match) => match[group])
    .filter((value): value is string => value !== undefined);
}

function countValues(values: Iterable<string>): Record<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return Object.fromEntries([...counts].sort(([left], [right]) => left.localeCompare(right)));
}

function check(id: string, expected: unknown, actual: unknown): CompatibilityCheck {
  return {
    id,
    ready: stableJson(expected) === stableJson(actual),
    expected,
    actual,
  };
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function assertCompatibilityBaseline(value: unknown): asserts value is CompatibilityBaseline {
  if (!isRecord(value) || value.schemaVersion !== COMPATIBILITY_BASELINE_SCHEMA_VERSION) {
    throw new Error("Unsupported compatibility baseline schema");
  }
  for (const field of [
    "id",
    "rendererVersion",
    "officialDmgSha256",
    "sourceAsarSha256",
    "sourceWrapperAsarSha256",
  ] as const) {
    if (typeof value[field] !== "string" || value[field].length === 0) {
      throw new Error(`Compatibility baseline has invalid ${field}`);
    }
  }
  if (!/^\d+\.\d+\.\d+$/u.test(value.rendererVersion as string)) {
    throw new Error("Compatibility baseline rendererVersion is invalid");
  }
  for (const field of [
    "officialDmgSha256",
    "sourceAsarSha256",
    "sourceWrapperAsarSha256",
  ] as const) {
    if (!/^[a-f0-9]{64}$/u.test(value[field] as string)) {
      throw new Error(`Compatibility baseline has invalid ${field}`);
    }
  }
  assertTreeIdentity(value.sourceAppTree, "sourceAppTree");
  if (!isRecord(value.keyFiles)) throw new Error("Compatibility baseline keyFiles is invalid");
  for (const filename of ["app.js", "main.js", "index.html", "package.json"] as const) {
    const identity = value.keyFiles[filename];
    if (
      !isRecord(identity) ||
      !Number.isSafeInteger(identity.bytes) ||
      (identity.bytes as number) < 0 ||
      typeof identity.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(identity.sha256)
    ) {
      throw new Error(`Compatibility baseline key file is invalid: ${filename}`);
    }
  }
  assertFileIdentityInventory(value.javaScriptFiles, "javaScriptFiles", true);
  assertFileIdentityInventory(
    value.unpackedJavaScriptFiles,
    "unpackedJavaScriptFiles",
    false,
  );
  for (const path of Object.keys(value.unpackedJavaScriptFiles as Record<string, unknown>)) {
    if (
      !path.startsWith("obsidian.asar.unpacked/") &&
      !path.startsWith("app.asar.unpacked/")
    ) {
      throw new Error(`Compatibility baseline has an invalid unpacked path: ${path}`);
    }
  }
  if (
    !isRecord(value.unpackedJavaScriptReview) ||
    value.unpackedJavaScriptReview.status !== "reviewed" ||
    !Array.isArray(value.unpackedJavaScriptReview.reviewedPaths) ||
    value.unpackedJavaScriptReview.reviewedPaths.some(
      (path) => typeof path !== "string",
    ) ||
    stableJson(value.unpackedJavaScriptReview.reviewedPaths) !==
      stableJson(Object.keys(value.unpackedJavaScriptFiles as Record<string, unknown>).sort(compareStrings))
  ) {
    throw new Error(
      "Compatibility baseline must explicitly mark every unpacked JavaScript file reviewed",
    );
  }
  if (!Array.isArray(value.anchors) || value.anchors.length === 0) {
    throw new Error("Compatibility baseline must contain anchors");
  }
  const anchorIds = new Set<string>();
  for (const anchor of value.anchors) {
    if (
      !isRecord(anchor) ||
      typeof anchor.id !== "string" ||
      anchorIds.has(anchor.id) ||
      !["app.js", "main.js", "index.html"].includes(String(anchor.file)) ||
      typeof anchor.literal !== "string" ||
      anchor.literal.length === 0 ||
      !Number.isSafeInteger(anchor.expectedMatches) ||
      (anchor.expectedMatches as number) < 1
    ) {
      throw new Error("Compatibility baseline contains an invalid or duplicate anchor");
    }
    anchorIds.add(anchor.id);
  }
  for (const field of [
    "controlPlaneRoutes",
    "syncOperations",
    "syncOperationLocations",
    "syncMessageShapes",
    "syncMessageShapeLocations",
    "syncInboundOperations",
  ] as const) {
    const inventory = value[field];
    if (!isRecord(inventory)) {
      throw new Error(`Compatibility baseline ${field} is invalid`);
    }
    for (const [name, count] of Object.entries(inventory)) {
      if (!name || !Number.isSafeInteger(count) || (count as number) < 1) {
        throw new Error(`Compatibility baseline ${field} contains an invalid count`);
      }
    }
  }
}

function assertFileIdentityInventory(
  value: unknown,
  label: string,
  requireNonEmpty: boolean,
): void {
  if (!isRecord(value) || (requireNonEmpty && Object.keys(value).length === 0)) {
    throw new Error(`Compatibility baseline ${label} is invalid`);
  }
  for (const [path, identity] of Object.entries(value)) {
    if (
      !isJavaScriptPath(path) ||
      !isRecord(identity) ||
      !Number.isSafeInteger(identity.bytes) ||
      (identity.bytes as number) < 0 ||
      !isSha256(identity.sha256)
    ) {
      throw new Error(`Compatibility baseline ${label} has an invalid entry`);
    }
  }
}

function assertTreeIdentity(value: unknown, label: string): void {
  if (
    !isRecord(value) ||
    value.formatVersion !== TREE_IDENTITY_FORMAT_VERSION ||
    !isSha256(value.sha256)
  ) {
    throw new Error(`Compatibility baseline ${label} is invalid`);
  }
  for (const field of [
    "entries",
    "files",
    "directories",
    "symlinks",
    "fileBytes",
  ] as const) {
    if (!Number.isSafeInteger(value[field]) || (value[field] as number) < 0) {
      throw new Error(`Compatibility baseline ${label}.${field} is invalid`);
    }
  }
  if (
    (value.entries as number) !==
    (value.files as number) + (value.directories as number) + (value.symlinks as number)
  ) {
    throw new Error(`Compatibility baseline ${label} counts are inconsistent`);
  }
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
