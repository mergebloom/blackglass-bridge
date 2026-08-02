import { createHash } from "node:crypto";
import { join } from "node:path";
import {
  assertMacOSCodeInventory,
  type MacOSCodeInventory,
  verifyMacOSCodeInventorySignatures,
} from "./macos-code-inventory";
import { MACOS_PACKAGING_EXECUTABLES } from "./packaging-toolchain";
import { stableJson } from "./stable-json";

export const MACOS_CODE_SIGNING_FORMAT_VERSION = 2;
const LEGACY_MANTLE_IDENTIFIER = "org.mantle.Mantle";
const CURRENT_MANTLE_IDENTIFIER = "com.electron.mantle";

export const APPROVED_MACOS_ENTITLEMENTS = [
  "com.apple.security.cs.allow-jit",
  "com.apple.security.cs.allow-unsigned-executable-memory",
  "com.apple.security.cs.disable-library-validation",
  "com.apple.security.device.audio-input",
  "com.apple.security.personal-information.calendars",
] as const;

const CODE_DIRECTORY_ADHOC_FLAG = 0x2;
const CODE_DIRECTORY_RUNTIME_FLAG = 0x1_0000;

export interface MacOSCodeSigningTarget {
  role: "application" | "auxiliary" | "cli" | "framework" | "helper";
  identifier: string;
  runtimeVersion: string;
  entitlementPolicy: "approved" | "none";
}

export interface MacOSCodeSigningEvidence {
  formatVersion: typeof MACOS_CODE_SIGNING_FORMAT_VERSION;
  signature: "ad-hoc";
  allReviewedTargetsHardenedRuntime: true;
  allInventoryTargetsStrictlyVerified: true;
  allArchitecturesStrictlyVerified: true;
  strictInventoryTargets: number;
  strictMachOTargets: number;
  inventorySigningSha256: string;
  approvedEntitlements: string[];
  targets: MacOSCodeSigningTarget[];
}

interface TargetDefinition
  extends Omit<MacOSCodeSigningTarget, "runtimeVersion"> {
  relativePath: string;
  signOrder: number;
}

interface TargetPath extends MacOSCodeSigningTarget {
  path: string;
  signOrder: number;
}

interface InspectedCodeSignature extends MacOSCodeSigningTarget {
  adHoc: boolean;
  codeDirectoryHash: string;
}

export interface SourceMacOSCodeSigningContract {
  targets: InspectedCodeSignature[];
  inventoryMachOTargets: InventoryMachOSigningTarget[];
}

interface InventoryMachOSigningTarget {
  path: string;
  architectures: string[];
  identifier: string;
  runtimeVersion: string;
  entitlementPolicy: "approved" | "none";
}

export function inspectSourceMacOSCodeSigning(
  appPath: string,
  inventory: MacOSCodeInventory,
): SourceMacOSCodeSigningContract {
  // The exact DMG digest and extracted tree are checked by the caller before
  // this metadata is trusted. Some mounted official bundles do not satisfy a
  // fresh strict verification, so source inspection reads the embedded signing
  // contract while output verification is always strict.
  const targets = targetPaths(appPath, "md.obsidian").map((target) =>
    inspectApprovedCodeSignature(target, false)
  );
  return {
    targets,
    inventoryMachOTargets: inspectInventoryMachOSigningTargets(
      appPath,
      inventory,
      false,
    ),
  };
}

export function signMacOSAppAdHoc(
  appPath: string,
  entitlementsPath: string,
  source: SourceMacOSCodeSigningContract,
  inventory: MacOSCodeInventory,
): MacOSCodeSigningEvidence {
  assertMacOSCodeInventory(inventory);
  const basePackagedTargets = targetPaths(appPath, "com.blackglass.bridge");
  if (source.targets.length !== basePackagedTargets.length) {
    throw new Error("Source macOS code-signing target inventory is incomplete");
  }
  const packagedTargets = basePackagedTargets.map(
    (target, index) =>
      target.role === "application"
        ? target
        : { ...target, identifier: source.targets[index]!.identifier },
  );

  const inventoryEntries = inventory.entries.filter((entry) => entry.kind === "mach-o");
  if (
    source.inventoryMachOTargets.length !== inventoryEntries.length ||
    source.inventoryMachOTargets.some(
      (target, index) =>
        target.path !== inventoryEntries[index]!.path ||
        !same(target.architectures, inventoryEntries[index]!.architectures),
    )
  ) {
    throw new Error("Source Mach-O signing contract does not match the code inventory");
  }
  for (const target of source.inventoryMachOTargets) {
    signInventoryMachOTarget(appPath, target, entitlementsPath);
  }

  const signingTargets = packagedTargets
    .map((target, index) => ({
      target,
      runtimeVersion: source.targets[index]!.runtimeVersion,
    }))
    .sort((left, right) => left.target.signOrder - right.target.signOrder);
  for (const { target, runtimeVersion } of signingTargets) {
    signTarget(target, entitlementsPath, runtimeVersion);
  }
  run([
    MACOS_PACKAGING_EXECUTABLES.codesign,
    "--verify",
    "--deep",
    "--strict",
    "--all-architectures",
    appPath,
  ]);
  verifyMacOSCodeInventorySignatures(appPath, inventory);

  const inspected = inspectPackagedMacOSCodeSigning(appPath, inventory);
  for (let index = 0; index < inspected.targets.length; index += 1) {
    if (
      inspected.targets[index]!.runtimeVersion !==
      source.targets[index]!.runtimeVersion
    ) {
      throw new Error(
        `Packaged ${targetLabel(inspected.targets[index]!)} runtime version ` +
          "does not match the reviewed source",
      );
    }
  }
  const expectedInventoryTargets = source.inventoryMachOTargets.map((target) => ({
    ...target,
    identifier:
      target.path === "Contents/MacOS/Obsidian"
        ? "com.blackglass.bridge"
        : target.identifier,
  }));
  if (
    inspected.inventorySigningSha256 !== sha256(stableJson(expectedInventoryTargets))
  ) {
    throw new Error("Packaged Mach-O signing contract differs from the reviewed source");
  }
  return inspected;
}

export function inspectPackagedMacOSCodeSigning(
  appPath: string,
  inventory: MacOSCodeInventory,
): MacOSCodeSigningEvidence {
  verifyMacOSCodeInventorySignatures(appPath, inventory);
  const signatures = targetPaths(appPath, "com.blackglass.bridge").map(
    (target) => inspectApprovedCodeSignature(target, true),
  );
  const inventoryMachOTargets = inspectInventoryMachOSigningTargets(
    appPath,
    inventory,
    true,
  );
  const evidence: MacOSCodeSigningEvidence = {
    formatVersion: MACOS_CODE_SIGNING_FORMAT_VERSION,
    signature: "ad-hoc",
    allReviewedTargetsHardenedRuntime: true,
    allInventoryTargetsStrictlyVerified: true,
    allArchitecturesStrictlyVerified: true,
    strictInventoryTargets: inventory.entries.length,
    strictMachOTargets: inventoryMachOTargets.length,
    inventorySigningSha256: sha256(stableJson(inventoryMachOTargets)),
    approvedEntitlements: [...APPROVED_MACOS_ENTITLEMENTS],
    targets: signatures.map(
      ({ role, identifier, runtimeVersion, entitlementPolicy }) => ({
        role,
        identifier,
        runtimeVersion,
        entitlementPolicy,
      }),
    ),
  };
  assertMacOSCodeSigningEvidence(evidence);
  return evidence;
}

export function assertMacOSCodeSigningEvidence(
  value: unknown,
): asserts value is MacOSCodeSigningEvidence {
  if (
    !isRecord(value) ||
    value.formatVersion !== MACOS_CODE_SIGNING_FORMAT_VERSION ||
    value.signature !== "ad-hoc" ||
    value.allReviewedTargetsHardenedRuntime !== true ||
    value.allInventoryTargetsStrictlyVerified !== true ||
    value.allArchitecturesStrictlyVerified !== true ||
    !Number.isSafeInteger(value.strictInventoryTargets) ||
    (value.strictInventoryTargets as number) < 1 ||
    !Number.isSafeInteger(value.strictMachOTargets) ||
    (value.strictMachOTargets as number) < 1 ||
    (value.strictMachOTargets as number) > (value.strictInventoryTargets as number) ||
    !isSha256(value.inventorySigningSha256) ||
    !same(value.approvedEntitlements, APPROVED_MACOS_ENTITLEMENTS) ||
    !Array.isArray(value.targets)
  ) {
    throw new Error("Invalid macOS hardened-runtime evidence");
  }
  const expectedTargets = targetDefinitions("com.blackglass.bridge");
  if (value.targets.length !== expectedTargets.length) {
    throw new Error("Invalid macOS code-signing target inventory");
  }
  for (let index = 0; index < expectedTargets.length; index += 1) {
    const actual = value.targets[index];
    const expected = expectedTargets[index]!;
    if (
      !isRecord(actual) ||
      actual.role !== expected.role ||
      typeof actual.identifier !== "string" ||
      !approvedIdentifiers(expected.identifier).includes(actual.identifier) ||
      actual.entitlementPolicy !== expected.entitlementPolicy ||
      typeof actual.runtimeVersion !== "string" ||
      !/^\d+(?:\.\d+){1,3}$/u.test(actual.runtimeVersion)
    ) {
      throw new Error("Invalid macOS code-signing target evidence");
    }
  }
}

export function approvedMacOSEntitlementsPlist(): string {
  const entries = APPROVED_MACOS_ENTITLEMENTS.map(
    (entitlement) => `  <key>${entitlement}</key>\n  <true/>`,
  ).join("\n");
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" ' +
    '"http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n' +
    `<plist version="1.0">\n<dict>\n${entries}\n</dict>\n</plist>\n`
  );
}

function inspectApprovedCodeSignature(
  target: TargetPath,
  requireAdHoc: boolean,
): InspectedCodeSignature {
  if (requireAdHoc) {
    run([
      MACOS_PACKAGING_EXECUTABLES.codesign,
      "--verify",
      "--strict",
      "--all-architectures",
      target.path,
    ]);
  }
  const details = runText([
    MACOS_PACKAGING_EXECUTABLES.codesign,
    "--display",
    "--verbose=4",
    target.path,
  ]);
  const identifier = /^Identifier=(.+)$/mu.exec(details)?.[1];
  const codeDirectory = /^CodeDirectory .+ flags=0x([a-f\d]+)\(([^)]*)\)/mu.exec(
    details,
  );
  const runtimeVersion = /^Runtime Version=(\S+)$/mu.exec(details)?.[1];
  const codeDirectoryHash = /^CDHash=([a-f\d]+)$/mu.exec(details)?.[1];
  const signatureAdHoc = /^Signature=adhoc$/mu.test(details);
  if (!identifier || !approvedIdentifiers(target.identifier).includes(identifier)) {
    throw new Error(
      `Unexpected ${targetLabel(target)} code-signing identifier: ${identifier ?? "missing"}`,
    );
  }
  if (!codeDirectory || !runtimeVersion || !codeDirectoryHash) {
    throw new Error(`Incomplete ${targetLabel(target)} code-signing metadata`);
  }
  const flags = Number.parseInt(codeDirectory[1]!, 16);
  const adHoc = (flags & CODE_DIRECTORY_ADHOC_FLAG) !== 0;
  const expectedFlags =
    CODE_DIRECTORY_RUNTIME_FLAG |
    (requireAdHoc
      ? CODE_DIRECTORY_ADHOC_FLAG
      : adHoc
        ? CODE_DIRECTORY_ADHOC_FLAG
        : 0);
  if (
    flags !== expectedFlags ||
    !codeDirectory[2]!.split(",").includes("runtime") ||
    (requireAdHoc && (!adHoc || !signatureAdHoc)) ||
    (!requireAdHoc && signatureAdHoc !== adHoc)
  ) {
    throw new Error(
      `Unexpected ${targetLabel(target)} code-signing flags: ${codeDirectory[0]}`,
    );
  }
  if (!/^\d+(?:\.\d+){1,3}$/u.test(runtimeVersion)) {
    throw new Error(`Invalid ${targetLabel(target)} hardened-runtime version`);
  }

  const entitlementDetails = runText([
    MACOS_PACKAGING_EXECUTABLES.codesign,
    "--display",
    "--entitlements",
    "-",
    target.path,
  ]);
  const entitlements = parseAbstractEntitlements(entitlementDetails);
  const expectedEntitlements =
    target.entitlementPolicy === "approved"
      ? APPROVED_MACOS_ENTITLEMENTS
      : [];
  if (!same(entitlements, expectedEntitlements)) {
    throw new Error(
      `Unexpected ${targetLabel(target)} entitlements: ${JSON.stringify(entitlements)}`,
    );
  }
  return {
    role: target.role,
    identifier,
    runtimeVersion,
    entitlementPolicy: target.entitlementPolicy,
    adHoc,
    codeDirectoryHash,
  };
}

function approvedIdentifiers(expected: string): readonly string[] {
  return expected === LEGACY_MANTLE_IDENTIFIER
    ? [LEGACY_MANTLE_IDENTIFIER, CURRENT_MANTLE_IDENTIFIER]
    : [expected];
}

function parseAbstractEntitlements(output: string): string[] {
  const keys = [...output.matchAll(/^\s*\[Key\] (.+)$/gmu)].map(
    (match) => match[1]!,
  );
  const booleans = [...output.matchAll(/^\s*\[Bool\] (true|false)$/gmu)].map(
    (match) => match[1]!,
  );
  if (
    keys.length !== booleans.length ||
    booleans.some((value) => value !== "true")
  ) {
    throw new Error("macOS entitlements are not a flat true-valued dictionary");
  }
  return keys.sort();
}

function inspectInventoryMachOSigningTargets(
  appPath: string,
  inventory: MacOSCodeInventory,
  requireAdHoc: boolean,
): InventoryMachOSigningTarget[] {
  assertMacOSCodeInventory(inventory);
  return inventory.entries
    .filter((entry) => entry.kind === "mach-o")
    .map((entry) => {
      const path = join(appPath, entry.path);
      const slices = entry.architectures.map((architecture) =>
        inspectMachOSliceCodeSignature(
          path,
          entry.path,
          architecture,
          requireAdHoc,
        )
      );
      const first = slices[0];
      if (
        !first ||
        slices.some(
          (slice) =>
            slice.identifier !== first.identifier ||
            slice.runtimeVersion !== first.runtimeVersion ||
            slice.entitlementPolicy !== first.entitlementPolicy,
        )
      ) {
        throw new Error(
          `Mach-O signing metadata differs across architectures: ${entry.path}`,
        );
      }
      return {
        path: entry.path,
        architectures: [...entry.architectures],
        identifier: first.identifier,
        runtimeVersion: first.runtimeVersion,
        entitlementPolicy: first.entitlementPolicy,
      };
    });
}

function inspectMachOSliceCodeSignature(
  path: string,
  label: string,
  architecture: string,
  requireAdHoc: boolean,
): Omit<InventoryMachOSigningTarget, "path" | "architectures"> {
  const details = runText([
    MACOS_PACKAGING_EXECUTABLES.codesign,
    "--display",
    "--verbose=4",
    "--arch",
    architecture,
    path,
  ]);
  const identifier = /^Identifier=(.+)$/mu.exec(details)?.[1];
  const codeDirectory = /^CodeDirectory .+ flags=0x([a-f\d]+)\(([^)]*)\)/mu.exec(
    details,
  );
  const runtimeVersion = /^Runtime Version=(\S+)$/mu.exec(details)?.[1];
  const signatureAdHoc = /^Signature=adhoc$/mu.test(details);
  if (!identifier || !codeDirectory || !runtimeVersion) {
    throw new Error(`Incomplete Mach-O signing metadata: ${label} (${architecture})`);
  }
  const flags = Number.parseInt(codeDirectory[1]!, 16);
  const adHoc = (flags & CODE_DIRECTORY_ADHOC_FLAG) !== 0;
  const expectedFlags = CODE_DIRECTORY_RUNTIME_FLAG |
    (adHoc ? CODE_DIRECTORY_ADHOC_FLAG : 0);
  if (
    flags !== expectedFlags ||
    !codeDirectory[2]!.split(",").includes("runtime") ||
    (requireAdHoc && (!adHoc || !signatureAdHoc)) ||
    (!requireAdHoc && signatureAdHoc !== adHoc) ||
    !/^\d+(?:\.\d+){1,3}$/u.test(runtimeVersion)
  ) {
    throw new Error(`Unexpected Mach-O signing policy: ${label} (${architecture})`);
  }
  const entitlementDetails = runText([
    MACOS_PACKAGING_EXECUTABLES.codesign,
    "--display",
    "--entitlements",
    "-",
    "--arch",
    architecture,
    path,
  ]);
  const entitlements = parseAbstractEntitlements(entitlementDetails);
  const entitlementPolicy = same(entitlements, APPROVED_MACOS_ENTITLEMENTS)
    ? "approved"
    : entitlements.length === 0
      ? "none"
      : undefined;
  if (!entitlementPolicy) {
    throw new Error(
      `Unapproved Mach-O entitlements: ${label} (${architecture}): ` +
        JSON.stringify(entitlements),
    );
  }
  return { identifier, runtimeVersion, entitlementPolicy };
}

function signInventoryMachOTarget(
  appPath: string,
  target: InventoryMachOSigningTarget,
  entitlementsPath: string,
): void {
  const arguments_ = [
    MACOS_PACKAGING_EXECUTABLES.codesign,
    "--force",
    "--sign",
    "-",
    "--identifier",
    target.identifier,
    "--options",
    "runtime",
    "--runtime-version",
    target.runtimeVersion,
    "--timestamp=none",
  ];
  if (target.entitlementPolicy === "approved") {
    arguments_.push(
      "--entitlements",
      entitlementsPath,
      "--generate-entitlement-der",
    );
  }
  arguments_.push(join(appPath, target.path));
  run(arguments_);
}

function signTarget(
  target: TargetPath,
  entitlementsPath: string,
  runtimeVersion: string,
): void {
  const arguments_ = [
    MACOS_PACKAGING_EXECUTABLES.codesign,
    "--force",
    "--sign",
    "-",
    "--identifier",
    target.identifier,
    "--options",
    "runtime",
    "--runtime-version",
    runtimeVersion,
    "--timestamp=none",
  ];
  if (target.entitlementPolicy === "approved") {
    arguments_.push(
      "--entitlements",
      entitlementsPath,
      "--generate-entitlement-der",
    );
  }
  arguments_.push(target.path);
  run(arguments_);
}

function targetPaths(
  appPath: string,
  applicationIdentifier: string,
): TargetPath[] {
  return targetDefinitions(applicationIdentifier).map((target) => ({
    role: target.role,
    identifier: target.identifier,
    runtimeVersion: "",
    entitlementPolicy: target.entitlementPolicy,
    signOrder: target.signOrder,
    path: target.relativePath ? join(appPath, target.relativePath) : appPath,
  }));
}

function targetDefinitions(applicationIdentifier: string): TargetDefinition[] {
  const helper = (
    nameSuffix: string,
    identifierSuffix: string,
    signOrder: number,
  ): TargetDefinition => ({
    role: "helper",
    identifier: `md.obsidian.helper${identifierSuffix}`,
    entitlementPolicy: "approved",
    relativePath: `Contents/Frameworks/Obsidian Helper${nameSuffix}.app`,
    signOrder,
  });
  return [
    {
      role: "application",
      identifier: applicationIdentifier,
      entitlementPolicy: "approved",
      relativePath: "",
      signOrder: 120,
    },
    {
      role: "cli",
      identifier: "obsidian-cli",
      entitlementPolicy: "approved",
      relativePath: "Contents/MacOS/obsidian-cli",
      signOrder: 90,
    },
    helper("", "", 100),
    helper(" (GPU)", ".GPU", 101),
    helper(" (Plugin)", ".Plugin", 102),
    helper(" (Renderer)", ".Renderer", 103),
    {
      role: "auxiliary",
      identifier: "ShipIt",
      entitlementPolicy: "approved",
      relativePath:
        "Contents/Frameworks/Squirrel.framework/Versions/A/Resources/ShipIt",
      signOrder: 10,
    },
    {
      role: "auxiliary",
      identifier: "chrome_crashpad_handler",
      entitlementPolicy: "approved",
      relativePath:
        "Contents/Frameworks/Electron Framework.framework/Versions/A/Helpers/chrome_crashpad_handler",
      signOrder: 20,
    },
    {
      role: "framework",
      identifier: "com.github.Electron.framework",
      entitlementPolicy: "none",
      relativePath: "Contents/Frameworks/Electron Framework.framework",
      signOrder: 40,
    },
    {
      role: "framework",
      identifier: LEGACY_MANTLE_IDENTIFIER,
      entitlementPolicy: "none",
      relativePath: "Contents/Frameworks/Mantle.framework",
      signOrder: 50,
    },
    {
      role: "framework",
      identifier: "com.electron.reactive",
      entitlementPolicy: "none",
      relativePath: "Contents/Frameworks/ReactiveObjC.framework",
      signOrder: 60,
    },
    {
      role: "framework",
      identifier: "com.github.Squirrel",
      entitlementPolicy: "none",
      relativePath: "Contents/Frameworks/Squirrel.framework",
      signOrder: 70,
    },
  ];
}

function targetLabel(target: MacOSCodeSigningTarget): string {
  return `${target.role} ${target.identifier}`;
}

function run(arguments_: string[]): void {
  const result = Bun.spawnSync(arguments_, { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    throw new Error(
      `${arguments_[0]} failed: ${Buffer.from(result.stderr).toString("utf8").trim()}`,
    );
  }
}

function runText(arguments_: string[]): string {
  const result = Bun.spawnSync(arguments_, { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    throw new Error(
      `${arguments_[0]} failed: ${Buffer.from(result.stderr).toString("utf8").trim()}`,
    );
  }
  return Buffer.concat([
    Buffer.from(result.stdout),
    Buffer.from(result.stderr),
  ]).toString("utf8");
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}
