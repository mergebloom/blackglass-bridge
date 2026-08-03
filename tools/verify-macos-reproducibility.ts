import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import {
  inspectMacOSArtifact,
  publicMacOSArtifact,
  type MacOSArtifact,
} from "./macos-artifact";
import {
  assertNonOverlappingPaths,
  canonicalExistingPath,
  canonicalOutputPath,
} from "./path-safety";
import {
  parseBlackglassReleaseManifest,
  type BlackglassReleaseManifest,
} from "./release-manifest";
import {
  assertMacOSPackageReceiptBinds,
  parseMacOSPackageReceipt,
  serializeMacOSPackageReceipt,
  type MacOSPackageReceipt,
  type MacOSPackageReleaseIdentity,
} from "./macos-package-receipt";
import { stableJson } from "./stable-json";

export const MACOS_REPRODUCIBILITY_EVIDENCE_SCHEMA_VERSION = 4;

type PublicMacOSArtifact = Omit<MacOSArtifact, "appPath">;

export interface MacOSReproducibilityEvidence {
  schemaVersion: typeof MACOS_REPRODUCIBILITY_EVIDENCE_SCHEMA_VERSION;
  generatedBy: "tools/verify-macos-reproducibility.ts";
  passed: true;
  separateOutputs: true;
  independentPackageInvocations: true;
  blackglassVersion: string;
  rendererVersion: string;
  releaseManifestSha256: string;
  macOSArtifactSha256: string;
  applicationTreeSha256: string;
  codeInventorySha256: string;
  rootMetadataSha256: string;
  packagingToolchainSha256: string;
  toolingSourceSha256: string;
  packageReceipts: [
    { sha256: string; receipt: MacOSPackageReceipt },
    { sha256: string; receipt: MacOSPackageReceipt },
  ];
}

export async function verifyMacOSReproducibility(input: {
  firstApp: string;
  firstManifest: string;
  firstReceipt: string;
  secondApp: string;
  secondManifest: string;
  secondReceipt: string;
}): Promise<MacOSReproducibilityEvidence> {
  const [
    firstApp,
    firstManifest,
    firstReceipt,
    secondApp,
    secondManifest,
    secondReceipt,
  ] = await Promise.all([
    canonicalExistingPath(input.firstApp, "First packaged app", "directory"),
    canonicalExistingPath(input.firstManifest, "First release manifest", "file"),
    canonicalExistingPath(input.firstReceipt, "First package receipt", "file"),
    canonicalExistingPath(input.secondApp, "Second packaged app", "directory"),
    canonicalExistingPath(input.secondManifest, "Second release manifest", "file"),
    canonicalExistingPath(input.secondReceipt, "Second package receipt", "file"),
  ]);
  assertNonOverlappingPaths([
    { label: "First packaged app", path: firstApp },
    { label: "First release manifest", path: firstManifest },
    { label: "First package receipt", path: firstReceipt },
    { label: "Second packaged app", path: secondApp },
    { label: "Second release manifest", path: secondManifest },
    { label: "Second package receipt", path: secondReceipt },
  ]);

  const [
    firstArtifact,
    secondArtifact,
    firstManifestBytes,
    secondManifestBytes,
    firstReceiptBytes,
    secondReceiptBytes,
  ] = await Promise.all([
    inspectMacOSArtifact(firstApp),
    inspectMacOSArtifact(secondApp),
    readFile(firstManifest),
    readFile(secondManifest),
    readFile(firstReceipt),
    readFile(secondReceipt),
  ]);
  const firstRelease = parseBlackglassReleaseManifest(firstManifestBytes);
  const secondRelease = parseBlackglassReleaseManifest(secondManifestBytes);
  const firstPackageReceipt = parseMacOSPackageReceipt(firstReceiptBytes);
  const secondPackageReceipt = parseMacOSPackageReceipt(secondReceiptBytes);
  if (
    !Buffer.from(firstReceiptBytes).equals(
      serializeMacOSPackageReceipt(firstPackageReceipt),
    ) ||
    !Buffer.from(secondReceiptBytes).equals(
      serializeMacOSPackageReceipt(secondPackageReceipt),
    )
  ) {
    throw new Error("Package invocation receipt bytes are not canonical");
  }
  const firstPublic = publicMacOSArtifact(firstArtifact);
  const secondPublic = publicMacOSArtifact(secondArtifact);
  assertManifestBindsArtifact(firstRelease.macOS, firstPublic, "first");
  assertManifestBindsArtifact(secondRelease.macOS, secondPublic, "second");
  if (stableJson(firstRelease) !== stableJson(secondRelease)) {
    throw new Error("Independent macOS release manifests are not deterministic");
  }
  if (stableJson(firstPublic) !== stableJson(secondPublic)) {
    throw new Error("Independent packaged macOS artifacts are not deterministic");
  }

  const releaseManifestSha256 = sha256(firstManifestBytes);
  if (releaseManifestSha256 !== sha256(secondManifestBytes)) {
    throw new Error("Independent macOS release manifest bytes differ");
  }
  const releaseIdentity = packageReleaseIdentity(
    firstRelease,
    releaseManifestSha256,
    firstPublic,
  );
  assertMacOSPackageReceiptBinds(firstPackageReceipt, releaseIdentity);
  assertMacOSPackageReceiptBinds(secondPackageReceipt, releaseIdentity);
  if (firstPackageReceipt.invocationId === secondPackageReceipt.invocationId) {
    throw new Error("Package receipts do not prove distinct package invocations");
  }
  const evidence: MacOSReproducibilityEvidence = {
    schemaVersion: MACOS_REPRODUCIBILITY_EVIDENCE_SCHEMA_VERSION,
    generatedBy: "tools/verify-macos-reproducibility.ts",
    passed: true,
    separateOutputs: true,
    independentPackageInvocations: true,
    blackglassVersion: firstRelease.blackglassVersion,
    rendererVersion: firstRelease.rendererVersion,
    releaseManifestSha256,
    macOSArtifactSha256: sha256(stableJson(firstPublic)),
    applicationTreeSha256: firstPublic.applicationTreeSha256,
    codeInventorySha256: firstPublic.codeInventory.sha256,
    rootMetadataSha256: firstPublic.rootMetadata.sha256,
    packagingToolchainSha256: sha256(
      stableJson(firstRelease.packagingToolchain),
    ),
    toolingSourceSha256: sha256(stableJson(firstRelease.toolingSource)),
    packageReceipts: [
      { sha256: sha256(firstReceiptBytes), receipt: firstPackageReceipt },
      { sha256: sha256(secondReceiptBytes), receipt: secondPackageReceipt },
    ],
  };
  assertMacOSReproducibilityEvidence(evidence);
  return evidence;
}

export function assertMacOSReproducibilityEvidence(
  value: unknown,
): asserts value is MacOSReproducibilityEvidence {
  if (
    !isRecord(value) ||
    value.schemaVersion !== MACOS_REPRODUCIBILITY_EVIDENCE_SCHEMA_VERSION ||
    value.generatedBy !== "tools/verify-macos-reproducibility.ts" ||
    value.passed !== true ||
    value.separateOutputs !== true ||
    value.independentPackageInvocations !== true ||
    typeof value.blackglassVersion !== "string" ||
    typeof value.rendererVersion !== "string" ||
    !Array.isArray(value.packageReceipts) ||
    value.packageReceipts.length !== 2
  ) {
    throw new Error("Invalid macOS reproducibility evidence");
  }
  for (const field of [
    "releaseManifestSha256",
    "macOSArtifactSha256",
    "applicationTreeSha256",
    "codeInventorySha256",
    "rootMetadataSha256",
    "packagingToolchainSha256",
    "toolingSourceSha256",
  ] as const) {
    if (!isSha256(value[field])) {
      throw new Error(`Invalid macOS reproducibility evidence ${field}`);
    }
  }
  const [first, second] = value.packageReceipts;
  if (!isRecord(first) || !isRecord(second)) {
    throw new Error("Invalid macOS reproducibility package receipts");
  }
  for (const entry of [first, second]) {
    const receipt = entry.receipt;
    const receiptBytes = serializeMacOSPackageReceipt(
      receipt as MacOSPackageReceipt,
    );
    if (!isSha256(entry.sha256) || entry.sha256 !== sha256(receiptBytes)) {
      throw new Error("Invalid macOS reproducibility package receipt identity");
    }
  }
  if (
    (first.receipt as MacOSPackageReceipt).invocationId ===
    (second.receipt as MacOSPackageReceipt).invocationId
  ) {
    throw new Error("macOS reproducibility receipts are not independent");
  }
}

export async function readMacOSReproducibilityEvidence(
  path: string,
): Promise<MacOSReproducibilityEvidence> {
  return parseMacOSReproducibilityEvidence(await readFile(path));
}

export function parseMacOSReproducibilityEvidence(
  bytes: Uint8Array,
): MacOSReproducibilityEvidence {
  const value = JSON.parse(Buffer.from(bytes).toString("utf8")) as unknown;
  assertMacOSReproducibilityEvidence(value);
  return value;
}

export function assertMacOSReproducibilityEvidenceBinds(
  evidence: MacOSReproducibilityEvidence,
  input: {
    manifest: BlackglassReleaseManifest;
    releaseManifestSha256: string;
    artifact: PublicMacOSArtifact;
  },
): void {
  assertMacOSReproducibilityEvidenceBindsRelease(evidence, {
    blackglassVersion: input.manifest.blackglassVersion,
    rendererVersion: input.manifest.rendererVersion,
    releaseManifestSha256: input.releaseManifestSha256,
    artifact: input.artifact,
    packagingToolchainSha256: sha256(
      stableJson(input.manifest.packagingToolchain),
    ),
    toolingSourceSha256: sha256(stableJson(input.manifest.toolingSource)),
  });
}

export function assertMacOSReproducibilityEvidenceBindsRelease(
  evidence: MacOSReproducibilityEvidence,
  input: MacOSPackageReleaseIdentity,
): void {
  assertMacOSReproducibilityEvidence(evidence);
  if (
    evidence.blackglassVersion !== input.blackglassVersion ||
    evidence.rendererVersion !== input.rendererVersion ||
    evidence.releaseManifestSha256 !== input.releaseManifestSha256 ||
    evidence.macOSArtifactSha256 !== sha256(stableJson(input.artifact)) ||
    evidence.applicationTreeSha256 !== input.artifact.applicationTreeSha256 ||
    evidence.codeInventorySha256 !== input.artifact.codeInventory.sha256 ||
    evidence.rootMetadataSha256 !== input.artifact.rootMetadata.sha256 ||
    evidence.packagingToolchainSha256 !== input.packagingToolchainSha256 ||
    evidence.toolingSourceSha256 !== input.toolingSourceSha256
  ) {
    throw new Error("macOS reproducibility evidence does not bind the selected release");
  }
  for (const { receipt } of evidence.packageReceipts) {
    assertMacOSPackageReceiptBinds(receipt, input);
  }
}

function assertManifestBindsArtifact(
  recorded: PublicMacOSArtifact,
  inspected: PublicMacOSArtifact,
  label: string,
): void {
  if (stableJson(recorded) !== stableJson(inspected)) {
    throw new Error(`The ${label} release manifest does not bind its packaged app`);
  }
}

function packageReleaseIdentity(
  manifest: BlackglassReleaseManifest,
  releaseManifestSha256: string,
  artifact: PublicMacOSArtifact,
): MacOSPackageReleaseIdentity {
  return {
    blackglassVersion: manifest.blackglassVersion,
    rendererVersion: manifest.rendererVersion,
    releaseManifestSha256,
    artifact,
    packagingToolchainSha256: sha256(stableJson(manifest.packagingToolchain)),
    toolingSourceSha256: sha256(stableJson(manifest.toolingSource)),
  };
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

if (import.meta.main) {
  const [
    firstApp,
    firstManifest,
    firstReceipt,
    secondApp,
    secondManifest,
    secondReceipt,
    outputArgument,
    ...extra
  ] = Bun.argv.slice(2);
  if (
    !firstApp ||
    !firstManifest ||
    !firstReceipt ||
    !secondApp ||
    !secondManifest ||
    !secondReceipt ||
    !outputArgument ||
    extra.length !== 0
  ) {
    usage();
  }
  const output = await canonicalOutputPath(outputArgument, "Reproducibility evidence");
  if (!output.endsWith(".json")) {
    throw new Error("Reproducibility evidence output must be a .json file");
  }
  const [
    canonicalFirstApp,
    canonicalFirstManifest,
    canonicalFirstReceipt,
    canonicalSecondApp,
    canonicalSecondManifest,
    canonicalSecondReceipt,
  ] = await Promise.all([
      canonicalExistingPath(firstApp, "First packaged app", "directory"),
      canonicalExistingPath(firstManifest, "First release manifest", "file"),
      canonicalExistingPath(firstReceipt, "First package receipt", "file"),
      canonicalExistingPath(secondApp, "Second packaged app", "directory"),
      canonicalExistingPath(secondManifest, "Second release manifest", "file"),
      canonicalExistingPath(secondReceipt, "Second package receipt", "file"),
    ]);
  assertNonOverlappingPaths([
    { label: "First packaged app", path: canonicalFirstApp },
    { label: "First release manifest", path: canonicalFirstManifest },
    { label: "First package receipt", path: canonicalFirstReceipt },
    { label: "Second packaged app", path: canonicalSecondApp },
    { label: "Second release manifest", path: canonicalSecondManifest },
    { label: "Second package receipt", path: canonicalSecondReceipt },
    { label: "Reproducibility evidence", path: output },
  ]);
  const evidence = await verifyMacOSReproducibility({
    firstApp: canonicalFirstApp,
    firstManifest: canonicalFirstManifest,
    firstReceipt: canonicalFirstReceipt,
    secondApp: canonicalSecondApp,
    secondManifest: canonicalSecondManifest,
    secondReceipt: canonicalSecondReceipt,
  });
  await writeFile(output, `${JSON.stringify(evidence, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  console.log(JSON.stringify({ output, evidence }, null, 2));
}

function usage(): never {
  console.error(
    "Usage: bun run tools/verify-macos-reproducibility.ts " +
      "<first/Blackglass Bridge.app> <first-release.json> <first-receipt.json> " +
      "<second/Blackglass Bridge.app> <second-release.json> " +
      "<second-receipt.json> <evidence.json>",
  );
  process.exit(2);
}
