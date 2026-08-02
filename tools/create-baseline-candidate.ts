import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { parseStrictFlags } from "./cli-flags";
import {
  inspectMacOSCodeInventory,
  type MacOSCodeInventory,
} from "./macos-code-inventory";
import {
  COMPATIBILITY_BASELINE_SCHEMA_VERSION,
  type CompatibilityAnchor,
  type CompatibilityBaseline,
  type FileIdentity,
  type ReleaseDiscovery,
  discoverRendererRelease,
  discoverUnpackedJavaScriptFiles,
  loadCompatibilityBaseline,
} from "./release-compatibility";
import {
  assertPathWithin,
  canonicalExistingPath,
  canonicalOutputPath,
} from "./path-safety";
import { compareCodeUnitStrings, stableJson } from "./stable-json";
import { computeTreeIdentity, type TreeIdentity } from "./tree-identity";

export const COMPATIBILITY_CANDIDATE_FORMAT_VERSION = 1;
export const COMPATIBILITY_CANDIDATE_REVIEW_FORMAT_VERSION = 1;

export const CRITICAL_SEMANTIC_INVENTORIES = [
  "controlPlaneRoutes",
  "controlPlaneRouteLocations",
  "controlPlaneRequestHelpers",
  "networkConstructors",
  "syncOperations",
  "syncOperationLocations",
  "syncMessageShapes",
  "syncMessageShapeLocations",
  "syncInboundOperations",
] as const satisfies readonly (keyof ReleaseDiscovery)[];

const REQUIRED_REVIEW = [
  "Review minified diffs for every added, removed, or changed packed JavaScript file.",
  "Review every added, removed, or changed unpacked JavaScript file.",
  "Update the protocol documentation and Blackglass Server for intentional protocol changes.",
  "Add or update regression tests for every accepted compatibility change.",
  "Promote a reviewed baseline only with apply_patch or an equivalent manual tracked edit.",
] as const;

type UntrustedProposedBaseline = Omit<
  CompatibilityBaseline,
  "unpackedJavaScriptReview"
> & {
  unpackedJavaScriptReview: {
    status: "untrusted-candidate";
    discoveredPaths: string[];
  };
};

interface InventoryDiff<T> {
  added: Record<string, T>;
  removed: Record<string, T>;
  changed: Record<string, { before: T; after: T }>;
  unchanged: number;
}

interface ValueDiff<T> {
  before: T;
  after: T;
  changed: boolean;
}

export interface CompatibilityCandidate {
  formatVersion: typeof COMPATIBILITY_CANDIDATE_FORMAT_VERSION;
  trust: "untrusted-candidate";
  predecessor: {
    id: string;
    rendererVersion: string;
    sha256: string;
  };
  proposedBaselineSha256: string;
  proposedBaseline: UntrustedProposedBaseline;
  promotionTarget: string;
  requiredReview: readonly string[];
}

export interface CompatibilityCandidateReviewReport {
  formatVersion: typeof COMPATIBILITY_CANDIDATE_REVIEW_FORMAT_VERSION;
  trust: "untrusted-review-report";
  predecessor: CompatibilityCandidate["predecessor"];
  candidate: {
    id: string;
    rendererVersion: string;
    proposedBaselineSha256: string;
  };
  anchors: Array<{
    id: string;
    file: string;
    literalSha256: string;
    expectedMatches: number;
    actualMatches: number;
    matched: true;
  }>;
  identityChanges: {
    rendererVersion: ValueDiff<string>;
    officialDmgSha256: ValueDiff<string>;
    sourceAppTree: ValueDiff<TreeIdentity>;
    sourceMacOSCodeInventory: ValueDiff<MacOSCodeInventory>;
    sourceAsarSha256: ValueDiff<string>;
    sourceWrapperAsarSha256: ValueDiff<string>;
  };
  fileChanges: {
    keyFiles: InventoryDiff<FileIdentity>;
    packedJavaScript: InventoryDiff<FileIdentity>;
    unpackedJavaScript: InventoryDiff<FileIdentity>;
  };
  semanticInventoryChanges: Record<
    (typeof CRITICAL_SEMANTIC_INVENTORIES)[number],
    InventoryDiff<number>
  >;
  requiredReview: readonly string[];
}

export interface CompatibilityCandidateResult {
  outputDirectory: string;
  candidatePath: string;
  reviewPath: string;
  rendererVersion: string;
  predecessorRendererVersion: string;
  proposedBaselineSha256: string;
}

export async function createBaselineCandidate(
  input: {
    officialDmg: string;
    sourceApp: string;
    predecessorBaseline: string;
  },
  rootArgument = resolve(import.meta.dir, ".."),
): Promise<CompatibilityCandidateResult> {
  const projectRoot = await canonicalExistingPath(
    rootArgument,
    "Blackglass project root",
    "directory",
  );
  const officialDmg = await canonicalExistingPath(
    input.officialDmg,
    "Authorized official DMG",
    "file",
  );
  const sourceApp = await canonicalExistingPath(
    input.sourceApp,
    "Extracted Obsidian app",
    "directory",
  );
  const predecessorPath = await canonicalExistingPath(
    input.predecessorBaseline,
    "Predecessor compatibility baseline",
    "file",
  );
  if (!officialDmg.endsWith(".dmg")) {
    throw new Error("Authorized official DMG must have a .dmg filename");
  }
  if (basename(sourceApp) !== "Obsidian.app") {
    throw new Error("Extracted source application must be named Obsidian.app");
  }

  const resources = await canonicalExistingPath(
    join(sourceApp, "Contents/Resources"),
    "Extracted application Resources",
    "directory",
  );
  const rendererPath = await canonicalExistingPath(
    join(resources, "obsidian.asar"),
    "Official renderer ASAR",
    "file",
  );
  const wrapperPath = await canonicalExistingPath(
    join(resources, "app.asar"),
    "Official wrapper ASAR",
    "file",
  );
  assertPathWithin(resources, sourceApp, "Application Resources");
  assertPathWithin(rendererPath, sourceApp, "Official renderer ASAR");
  assertPathWithin(wrapperPath, sourceApp, "Official wrapper ASAR");

  const predecessor = await loadCompatibilityBaseline(predecessorPath);
  const rendererBytes = await readFile(rendererPath);
  const unpackedJavaScriptFiles = await discoverUnpackedJavaScriptFiles(resources);
  const discovery = discoverRendererRelease(
    rendererBytes,
    predecessor.baseline.anchors,
    unpackedJavaScriptFiles,
  );
  assertPredecessorAnchors(predecessor.baseline.anchors, discovery.anchorMatches);
  assertCriticalSemanticInventories(discovery);

  const [
    officialDmgSha256,
    sourceAppTree,
    sourceMacOSCodeInventory,
    wrapperBytes,
  ] = await Promise.all([
    sha256File(officialDmg),
    computeTreeIdentity(sourceApp),
    inspectMacOSCodeInventory(sourceApp, "source-contract"),
    readFile(wrapperPath),
  ]);
  const sourceWrapperAsarSha256 = sha256(wrapperBytes);
  const proposedBaseline: UntrustedProposedBaseline = {
    schemaVersion: COMPATIBILITY_BASELINE_SCHEMA_VERSION,
    id: `obsidian-macos-${discovery.rendererVersion}`,
    rendererVersion: discovery.rendererVersion,
    officialDmgSha256,
    sourceAppTree,
    sourceMacOSCodeInventory,
    sourceAsarSha256: discovery.sourceAsarSha256,
    sourceWrapperAsarSha256,
    keyFiles: discovery.keyFiles,
    javaScriptFiles: discovery.javaScriptFiles,
    unpackedJavaScriptFiles: discovery.unpackedJavaScriptFiles,
    unpackedJavaScriptReview: {
      status: "untrusted-candidate",
      discoveredPaths: Object.keys(discovery.unpackedJavaScriptFiles).sort(
        compareCodeUnitStrings,
      ),
    },
    anchors: sortedAnchors(predecessor.baseline.anchors),
    controlPlaneRoutes: discovery.controlPlaneRoutes,
    controlPlaneRouteLocations: discovery.controlPlaneRouteLocations,
    controlPlaneRequestHelpers: discovery.controlPlaneRequestHelpers,
    networkConstructors: discovery.networkConstructors,
    syncOperations: discovery.syncOperations,
    syncOperationLocations: discovery.syncOperationLocations,
    syncMessageShapes: discovery.syncMessageShapes,
    syncMessageShapeLocations: discovery.syncMessageShapeLocations,
    syncInboundOperations: discovery.syncInboundOperations,
  };
  const proposedBaselineSha256 = sha256(Buffer.from(stableJson(proposedBaseline)));
  const predecessorIdentity = {
    id: predecessor.baseline.id,
    rendererVersion: predecessor.baseline.rendererVersion,
    sha256: predecessor.sha256,
  };
  const promotionTarget = `compatibility/obsidian-${discovery.rendererVersion}.json`;
  const candidate: CompatibilityCandidate = {
    formatVersion: COMPATIBILITY_CANDIDATE_FORMAT_VERSION,
    trust: "untrusted-candidate",
    predecessor: predecessorIdentity,
    proposedBaselineSha256,
    proposedBaseline,
    promotionTarget,
    requiredReview: REQUIRED_REVIEW,
  };
  const report: CompatibilityCandidateReviewReport = {
    formatVersion: COMPATIBILITY_CANDIDATE_REVIEW_FORMAT_VERSION,
    trust: "untrusted-review-report",
    predecessor: predecessorIdentity,
    candidate: {
      id: proposedBaseline.id,
      rendererVersion: proposedBaseline.rendererVersion,
      proposedBaselineSha256,
    },
    anchors: sortedAnchors(predecessor.baseline.anchors).map((anchor) => ({
      id: anchor.id,
      file: anchor.file,
      literalSha256: sha256(Buffer.from(anchor.literal)),
      expectedMatches: anchor.expectedMatches,
      actualMatches: discovery.anchorMatches[anchor.id]!,
      matched: true,
    })),
    identityChanges: {
      rendererVersion: valueDiff(
        predecessor.baseline.rendererVersion,
        proposedBaseline.rendererVersion,
      ),
      officialDmgSha256: valueDiff(
        predecessor.baseline.officialDmgSha256,
        proposedBaseline.officialDmgSha256,
      ),
      sourceAppTree: valueDiff(
        predecessor.baseline.sourceAppTree,
        proposedBaseline.sourceAppTree,
      ),
      sourceMacOSCodeInventory: valueDiff(
        predecessor.baseline.sourceMacOSCodeInventory,
        proposedBaseline.sourceMacOSCodeInventory,
      ),
      sourceAsarSha256: valueDiff(
        predecessor.baseline.sourceAsarSha256,
        proposedBaseline.sourceAsarSha256,
      ),
      sourceWrapperAsarSha256: valueDiff(
        predecessor.baseline.sourceWrapperAsarSha256,
        proposedBaseline.sourceWrapperAsarSha256,
      ),
    },
    fileChanges: {
      keyFiles: inventoryDiff(predecessor.baseline.keyFiles, proposedBaseline.keyFiles),
      packedJavaScript: inventoryDiff(
        predecessor.baseline.javaScriptFiles,
        proposedBaseline.javaScriptFiles,
      ),
      unpackedJavaScript: inventoryDiff(
        predecessor.baseline.unpackedJavaScriptFiles,
        proposedBaseline.unpackedJavaScriptFiles,
      ),
    },
    semanticInventoryChanges: Object.fromEntries(
      CRITICAL_SEMANTIC_INVENTORIES.map((field) => [
        field,
        inventoryDiff(predecessor.baseline[field], discovery[field]),
      ]),
    ) as CompatibilityCandidateReviewReport["semanticInventoryChanges"],
    requiredReview: REQUIRED_REVIEW,
  };

  const candidateRoot = await ensureCandidateRoot(projectRoot);
  const directoryName =
    `obsidian-${discovery.rendererVersion}-from-${predecessor.baseline.rendererVersion}`;
  const outputDirectory = await canonicalOutputPath(
    join(candidateRoot, directoryName),
    "Compatibility candidate output directory",
  );
  assertPathWithin(outputDirectory, candidateRoot, "Compatibility candidate output");
  await mkdir(outputDirectory, { recursive: false, mode: 0o700 });
  const candidatePath = join(
    outputDirectory,
    `obsidian-${discovery.rendererVersion}-candidate.json`,
  );
  const reviewPath = join(
    outputDirectory,
    `obsidian-${discovery.rendererVersion}-predecessor-diff.json`,
  );
  await Promise.all([
    writeFile(candidatePath, stablePrettyJson(candidate), { flag: "wx", mode: 0o600 }),
    writeFile(reviewPath, stablePrettyJson(report), { flag: "wx", mode: 0o600 }),
  ]);
  return {
    outputDirectory,
    candidatePath,
    reviewPath,
    rendererVersion: discovery.rendererVersion,
    predecessorRendererVersion: predecessor.baseline.rendererVersion,
    proposedBaselineSha256,
  };
}

function assertPredecessorAnchors(
  anchors: CompatibilityAnchor[],
  actual: Record<string, number>,
): void {
  const mismatches = anchors
    .filter((anchor) => actual[anchor.id] !== anchor.expectedMatches)
    .map(
      (anchor) =>
        `${anchor.id} expected=${anchor.expectedMatches} actual=${actual[anchor.id] ?? 0}`,
    )
    .sort(compareCodeUnitStrings);
  if (mismatches.length > 0) {
    throw new Error(
      `Candidate renderer no longer matches predecessor anchors: ${mismatches.join(", ")}`,
    );
  }
}

function assertCriticalSemanticInventories(discovery: ReleaseDiscovery): void {
  const empty = CRITICAL_SEMANTIC_INVENTORIES.filter(
    (field) => Object.keys(discovery[field]).length === 0,
  );
  if (empty.length > 0) {
    throw new Error(
      `Candidate renderer has empty critical semantic inventories: ${empty.join(", ")}`,
    );
  }
}

function sortedAnchors(anchors: CompatibilityAnchor[]): CompatibilityAnchor[] {
  return [...anchors].sort((left, right) => compareCodeUnitStrings(left.id, right.id));
}

function valueDiff<T>(before: T, after: T): ValueDiff<T> {
  return { before, after, changed: stableJson(before) !== stableJson(after) };
}

function inventoryDiff<T>(
  before: Record<string, T>,
  after: Record<string, T>,
): InventoryDiff<T> {
  const added: Record<string, T> = {};
  const removed: Record<string, T> = {};
  const changed: Record<string, { before: T; after: T }> = {};
  let unchanged = 0;
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort(
    compareCodeUnitStrings,
  );
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(before, key)) {
      added[key] = after[key]!;
    } else if (!Object.prototype.hasOwnProperty.call(after, key)) {
      removed[key] = before[key]!;
    } else if (stableJson(before[key]) !== stableJson(after[key])) {
      changed[key] = { before: before[key]!, after: after[key]! };
    } else {
      unchanged += 1;
    }
  }
  return { added, removed, changed, unchanged };
}

async function ensureCandidateRoot(projectRoot: string): Promise<string> {
  const dataRoot = await ensureRealDirectory(projectRoot, ".data");
  return ensureRealDirectory(dataRoot, "compatibility-candidates");
}

async function ensureRealDirectory(parent: string, name: string): Promise<string> {
  const path = join(parent, name);
  try {
    const existing = await lstat(path);
    if (existing.isSymbolicLink() || !existing.isDirectory()) {
      throw new Error(`Compatibility candidate directory must be a real directory: ${path}`);
    }
  } catch (error) {
    if (!isMissingPathError(error)) throw error;
    await mkdir(path, { recursive: false, mode: 0o700 });
  }
  if ((await realpath(path)) !== path) {
    throw new Error(`Compatibility candidate directory is not canonical: ${path}`);
  }
  return path;
}

async function sha256File(path: string): Promise<string> {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path)) digest.update(chunk as Buffer);
  return digest.digest("hex");
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function stablePrettyJson(value: unknown): string {
  const canonical = JSON.parse(stableJson(value)) as unknown;
  return `${JSON.stringify(canonical, null, 2)}\n`;
}

function isMissingPathError(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

if (import.meta.main) {
  const [officialDmg, sourceApp, ...flags] = Bun.argv.slice(2);
  if (!officialDmg || !sourceApp) usage();
  const parsed = parseStrictFlags(flags, { valueFlags: ["--predecessor"] });
  const predecessorBaseline = parsed.values.get("--predecessor");
  if (!predecessorBaseline) usage();
  const result = await createBaselineCandidate({
    officialDmg,
    sourceApp,
    predecessorBaseline,
  });
  console.log(JSON.stringify(result, null, 2));
}

function usage(): never {
  console.error(
    "Usage: bun run tools/create-baseline-candidate.ts " +
      "<authorized-official.dmg> <extracted-Obsidian.app> " +
      "--predecessor <reviewed-baseline.json>",
  );
  process.exit(2);
}
