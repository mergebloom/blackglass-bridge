import { createHash, randomBytes } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { AsarArchive } from "./asar";
import { BLACKGLASS_HOME_ENVIRONMENT } from "../packages/client-adapter/src/runtime-home";
import { parseStrictFlags } from "./cli-flags";
import { deriveE2ENetworkPlan } from "./e2e-network";
import { DEFAULT_E2E_SCENARIO, parseE2EScenarioId } from "./e2e-scenario";
import { inspectMacOSArtifact, publicMacOSArtifact } from "./macos-artifact";
import { inspectMacOSPackagingToolchain } from "./packaging-toolchain";
import {
  assertPathWithin,
  canonicalExistingPath,
  canonicalOutputPath,
} from "./path-safety";
import { parseBlackglassReleaseManifest } from "./release-manifest";
import {
  computeToolingSourceIdentity,
  toolingSourceTreeEqual,
} from "./tooling-source";
import { isSupportedStableSemver } from "./semver";
import { stableJson } from "./stable-json";
import {
  assertMacOSReproducibilityEvidenceBinds,
  parseMacOSReproducibilityEvidence,
  verifyMacOSReproducibility,
} from "./verify-macos-reproducibility";

const [rootArgument, asarArgument, ...flags] = Bun.argv.slice(2);
const parsedFlags = parseStrictFlags(flags, {
  valueFlags: [
    "--app",
    "--release-manifest",
    "--package-receipt",
    "--second-app",
    "--second-release-manifest",
    "--second-package-receipt",
    "--reproducibility-evidence",
    "--scenario",
  ],
});
const appArgument = parsedFlags.values.get("--app");
const releaseManifestArgument = parsedFlags.values.get("--release-manifest");
const packageReceiptArgument = parsedFlags.values.get("--package-receipt");
const secondAppArgument = parsedFlags.values.get("--second-app");
const secondReleaseManifestArgument = parsedFlags.values.get(
  "--second-release-manifest",
);
const secondPackageReceiptArgument = parsedFlags.values.get(
  "--second-package-receipt",
);
const reproducibilityArgument = parsedFlags.values.get("--reproducibility-evidence");
const scenarioId = parseE2EScenarioId(
  parsedFlags.values.get("--scenario") ?? DEFAULT_E2E_SCENARIO,
);
if (
  !rootArgument ||
  !asarArgument ||
  !appArgument ||
  !releaseManifestArgument ||
  !packageReceiptArgument ||
  !secondAppArgument ||
  !secondReleaseManifestArgument ||
  !secondPackageReceiptArgument ||
  !reproducibilityArgument
) {
  console.error(
    "Usage: bun run tools/prepare-e2e.ts <run-directory> <patched.asar> " +
      "--app <Blackglass.app> --release-manifest <release.json> " +
      "--package-receipt <receipt.json> " +
      "--second-app <Blackglass.app> " +
      "--second-release-manifest <release.json> " +
      "--second-package-receipt <receipt.json> " +
      "--reproducibility-evidence <reproducibility.json> " +
      "[--scenario <scenario-id>]",
  );
  process.exit(2);
}

const projectDataRoot = resolve(import.meta.dir, "../.data/e2e");
await mkdir(projectDataRoot, { recursive: true });
const canonicalDataRoot = await canonicalExistingPath(
  projectDataRoot,
  "E2E data root",
  "directory",
);
const root = await canonicalOutputPath(rootArgument, "E2E run directory");
assertPathWithin(root, canonicalDataRoot, "E2E run directory");
const asar = await canonicalExistingPath(asarArgument, "Compatibility ASAR", "file");
const app = await canonicalExistingPath(appArgument, "Blackglass app", "directory");
const releaseManifestPath = await canonicalExistingPath(
  releaseManifestArgument,
  "Release manifest",
  "file",
);
const packageReceiptPath = await canonicalExistingPath(
  packageReceiptArgument,
  "Package invocation receipt",
  "file",
);
const secondApp = await canonicalExistingPath(
  secondAppArgument,
  "Second Blackglass app",
  "directory",
);
const secondReleaseManifestPath = await canonicalExistingPath(
  secondReleaseManifestArgument,
  "Second release manifest",
  "file",
);
const secondPackageReceiptPath = await canonicalExistingPath(
  secondPackageReceiptArgument,
  "Second package invocation receipt",
  "file",
);
const reproducibilityPath = await canonicalExistingPath(
  reproducibilityArgument,
  "macOS reproducibility evidence",
  "file",
);
const archive = await AsarArchive.open(asar);
const packageMetadata = JSON.parse(archive.read("package.json").toString("utf8")) as {
  version?: string;
};
if (!isSupportedStableSemver(packageMetadata.version)) {
  throw new Error("Compatibility ASAR has no semantic renderer version");
}
const mainRenderer = archive.read("app.js");
const starterRenderer = archive.read("starter.js");
const adapterBytes = Buffer.from(await Bun.file(asar).arrayBuffer());
const reproducibilityBytes = Buffer.from(
  await Bun.file(reproducibilityPath).arrayBuffer(),
);
const reproducibilityEvidence = parseMacOSReproducibilityEvidence(
  reproducibilityBytes,
);
const recomputedReproducibilityEvidence = await verifyMacOSReproducibility({
  firstApp: app,
  firstManifest: releaseManifestPath,
  firstReceipt: packageReceiptPath,
  secondApp,
  secondManifest: secondReleaseManifestPath,
  secondReceipt: secondPackageReceiptPath,
});
if (
  stableJson(recomputedReproducibilityEvidence) !==
  stableJson(reproducibilityEvidence)
) {
  throw new Error(
    "Supplied macOS reproducibility evidence does not match the two inspected outputs",
  );
}
const clientArtifact = await inspectMacOSArtifact(app);
const releaseManifestBytes = await readFile(releaseManifestPath);
const releaseManifest = parseBlackglassReleaseManifest(releaseManifestBytes);
const releaseManifestSha256 = createHash("sha256")
  .update(releaseManifestBytes)
  .digest("hex");
assertMacOSReproducibilityEvidenceBinds(reproducibilityEvidence, {
  manifest: releaseManifest,
  releaseManifestSha256,
  artifact: publicMacOSArtifact(clientArtifact),
});
const currentToolingSource = await computeToolingSourceIdentity();
const currentPackagingToolchain = await inspectMacOSPackagingToolchain();
if (
  releaseManifest.toolingSource.worktreeClean !== true ||
  currentToolingSource.worktreeClean !== true ||
  releaseManifest.toolingSource.gitRevision !== currentToolingSource.gitRevision ||
  !toolingSourceTreeEqual(releaseManifest.toolingSource, currentToolingSource)
) {
  throw new Error(
    "Prepared E2E requires the exact clean release-critical tooling source used for packaging",
  );
}
if (
  stableJson(releaseManifest.packagingToolchain) !==
  stableJson(currentPackagingToolchain)
) {
  throw new Error(
    "Prepared E2E runtime dependencies or packaging tools differ from the packaged release",
  );
}
if (clientArtifact.version !== packageMetadata.version) {
  throw new Error(
    `App/renderer version mismatch: ${clientArtifact.version} != ${packageMetadata.version}`,
  );
}
if (
  clientArtifact.embeddedAsarSha256 !==
  createHash("sha256").update(adapterBytes).digest("hex")
) {
  throw new Error("Packaged app does not embed the prepared compatibility ASAR");
}
if (
  releaseManifest.rendererVersion !== packageMetadata.version ||
  releaseManifest.renderer.patchedSha256 !==
    createHash("sha256").update(adapterBytes).digest("hex") ||
  releaseManifest.renderer.rendererAfterSha256 !==
    createHash("sha256").update(mainRenderer).digest("hex") ||
  releaseManifest.renderer.starterAfterSha256 !==
    createHash("sha256").update(starterRenderer).digest("hex")
) {
  throw new Error(
    "Release manifest does not bind the prepared compatibility ASAR and starter renderer",
  );
}
if (
  JSON.stringify(releaseManifest.macOS) !==
  JSON.stringify(publicMacOSArtifact(clientArtifact))
) {
  throw new Error("Release manifest does not bind the packaged macOS application");
}
if (
  clientArtifact.profileMode !== 0o700 ||
  clientArtifact.profilePathCanonicalAtSetup !== true ||
  releaseManifest.wrapper.profileMode !== 0o700 ||
  releaseManifest.wrapper.profilePathCanonicalAtSetup !== true ||
  clientArtifact.explicitUserDataDirHonored !== true ||
  releaseManifest.wrapper.explicitUserDataDirHonored !== true ||
  clientArtifact.profileHomeEnvironment !== BLACKGLASS_HOME_ENVIRONMENT ||
  releaseManifest.wrapper.profileHomeEnvironment !== BLACKGLASS_HOME_ENVIRONMENT ||
  clientArtifact.dedicatedHomeValidated !== true ||
  releaseManifest.wrapper.dedicatedHomeValidated !== true ||
  clientArtifact.nativeHomeFallbackPreserved !== true ||
  releaseManifest.wrapper.nativeHomeFallbackPreserved !== true
) {
  throw new Error("Packaged wrapper cannot safely isolate disposable E2E profiles");
}
const adapterFileName = `obsidian-${packageMetadata.version}.asar`;
const runManifest = {
  schemaVersion: 4,
  scenarioId,
  createdAt: new Date().toISOString(),
  blackglassVersion: releaseManifest.blackglassVersion,
  rendererVersion: packageMetadata.version,
  adapterFileName,
  compatibilityAsarSha256: createHash("sha256").update(adapterBytes).digest("hex"),
  releaseManifestFileName: "blackglass-release-manifest.json",
  releaseManifestSha256,
  reproducibilityEvidenceFileName: "client-reproducibility.json",
  reproducibilityEvidenceSha256: createHash("sha256")
    .update(reproducibilityBytes)
    .digest("hex"),
  endpoints: releaseManifest.endpoints,
  network: deriveE2ENetworkPlan(releaseManifest.endpoints),
  explicitUserDataDirHonored: true,
};
await mkdir(root, { recursive: false });
await writeFile(
  resolve(root, "run-manifest.json"),
  `${JSON.stringify(runManifest, null, 2)}\n`,
  { flag: "wx", mode: 0o600 },
);
await writeFile(
  resolve(root, runManifest.reproducibilityEvidenceFileName),
  reproducibilityBytes,
  { flag: "wx", mode: 0o600 },
);
await writeFile(
  resolve(root, "client-artifact.json"),
  `${JSON.stringify(clientArtifact, null, 2)}\n`,
  { flag: "wx", mode: 0o600 },
);
await writeFile(
  resolve(root, runManifest.releaseManifestFileName),
  releaseManifestBytes,
  { flag: "wx", mode: 0o600 },
);

const clients = ["client-a", "client-b", "client-c"] as const;
for (const client of clients) {
  const userData = resolve(root, client, "user-data");
  const vault = resolve(root, client, "vault");
  await mkdir(userData, { recursive: true, mode: 0o700 });
  await mkdir(vault, { recursive: true, mode: 0o700 });
  await copyFile(asar, resolve(userData, adapterFileName));
  // Keep this identifier identical to launch-macos.ts. A random identifier here
  // would make the launcher register the same vault a second time and open two
  // renderer windows, which makes UI evidence nondeterministic.
  const vaultId = createHash("sha256").update(vault).digest("hex").slice(0, 16);
  await writeFile(resolve(userData, `${vaultId}.json`), "{}", {
    flag: "wx",
    mode: 0o600,
  });
  await writeFile(
    resolve(userData, "obsidian.json"),
    JSON.stringify({
      updateDisabled: true,
      vaults: {
        [vaultId]: {
          path: vault,
          ts: Date.now(),
          open: true,
        },
      },
    }),
    { flag: "wx", mode: 0o600 },
  );
}

const environment = {
  email: "e2e@example.test",
  password: `pw-${randomBytes(18).toString("base64url")}`,
  token: randomBytes(32).toString("base64url"),
  e2ePassword: `vault-${randomBytes(18).toString("base64url")}`,
  secondary: {
    email: "e2e-secondary@example.test",
    password: `pw-${randomBytes(18).toString("base64url")}`,
    name: "E2E secondary user",
  },
  outsider: {
    email: "e2e-outsider@example.test",
    password: `pw-${randomBytes(18).toString("base64url")}`,
    name: "E2E unrelated user",
  },
};
await writeFile(
  resolve(root, "credentials.json"),
  JSON.stringify(environment, null, 2),
  { flag: "wx", mode: 0o600 },
);

console.log(
  JSON.stringify(
    {
      root,
      runManifest,
      database: resolve(root, "server.sqlite"),
      credentials: resolve(root, "credentials.json"),
      clientA: {
        userData: resolve(root, "client-a/user-data"),
        vault: resolve(root, "client-a/vault"),
      },
      clientB: {
        userData: resolve(root, "client-b/user-data"),
        vault: resolve(root, "client-b/vault"),
      },
      clientC: {
        userData: resolve(root, "client-c/user-data"),
        vault: resolve(root, "client-c/vault"),
      },
    },
    null,
    2,
  ),
);
