import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  RENDERER_INCISION_COUNT,
  RENDERER_PATCH_FORMAT_VERSION,
  canonicalAdapterOptions,
} from "../packages/client-adapter/src/patch";
import {
  WRAPPER_INCISION_COUNT,
  WRAPPER_PATCH_FORMAT_VERSION,
} from "../packages/client-adapter/src/wrapper";
import {
  CLI_BINARY_INCISION_COUNT,
  CLI_BINARY_PATCH_FORMAT_VERSION,
} from "../tools/cli-binary";
import {
  COMPATIBILITY_BASELINE_SCHEMA_VERSION,
  loadCompatibilityBaseline,
} from "../tools/release-compatibility";
import {
  assertReleaseValidationRecord,
  releaseValidationRecordFileName,
} from "../tools/release-validation";
import {
  computeToolingSourceIdentityAtRevision,
  isGeneratedValidationRecordPath,
  toolingSourceTreeEqual,
} from "../tools/tooling-source";

const root = resolve(import.meta.dir, "..");

describe("committed release records", () => {
  test("binds the validation record to the reviewed baseline and current patchers", async () => {
    const baselinePath = resolve(root, "compatibility/obsidian-1.12.7.json");
    const loaded = await loadCompatibilityBaseline(baselinePath);
    const packageMetadata = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
    const expectedName = releaseValidationRecordFileName(
      packageMetadata.version,
      loaded.baseline.rendererVersion,
    );
    const validationDirectory = resolve(root, "docs/validation");
    const currentRecords = (await readdir(validationDirectory)).filter((name) =>
      isGeneratedValidationRecordPath(`docs/validation/${name}`),
    );
    const currentVersionRecords = currentRecords.filter((name) =>
      name.startsWith(`blackglass-bridge-${packageMetadata.version}-`),
    );
    expect(currentVersionRecords).toEqual([expectedName]);
    const recordBytes = await readFile(resolve(validationDirectory, expectedName));
    expect(recordBytes.at(-1)).toBe(10);
    const validation = JSON.parse(recordBytes.toString("utf8"));
    assertReleaseValidationRecord(validation);
    expect(
      toolingSourceTreeEqual(
        validation.toolingSource,
        computeToolingSourceIdentityAtRevision(root, gitRevision()),
      ),
    ).toBe(true);
    expect(validation.bridgeVersion).toBe(packageMetadata.version);
    expect(validation.rendererVersion).toBe(loaded.baseline.rendererVersion);
    expect(loaded.baseline.schemaVersion).toBe(COMPATIBILITY_BASELINE_SCHEMA_VERSION);
    expect(loaded.baseline.officialDmgSha256).toBe(validation.source.officialDmgSha256);
    expect(loaded.baseline.sourceAppTree).toEqual(validation.source.appTree);
    expect(loaded.baseline.sourceAsarSha256).toBe(validation.source.rendererAsarSha256);
    expect(loaded.baseline.sourceWrapperAsarSha256).toBe(
      validation.source.wrapperAsarSha256,
    );
    expect(validation.compatibilityBaseline).toEqual({
      id: loaded.baseline.id,
      schemaVersion: loaded.baseline.schemaVersion,
      sha256: loaded.sha256,
    });
    expect(validation.patcher).toEqual({
      renderer: {
        formatVersion: RENDERER_PATCH_FORMAT_VERSION,
        incisions: RENDERER_INCISION_COUNT,
      },
      wrapper: {
        formatVersion: WRAPPER_PATCH_FORMAT_VERSION,
        incisions: WRAPPER_INCISION_COUNT,
      },
      cli: {
        formatVersion: CLI_BINARY_PATCH_FORMAT_VERSION,
        incisions: CLI_BINARY_INCISION_COUNT,
      },
    });
    expect(canonicalAdapterOptions(validation.endpoints)).toEqual({
      controlOrigin: "https://blackglass.example.com",
      dataHost: "blackglass-data.example.com",
    });
    for (const hash of [
      validation.artifacts.compatibilityAsarSha256,
      validation.artifacts.releaseManifestSha256,
      validation.artifacts.wrapperAsarSha256,
      validation.artifacts.wrapperHeaderSha256,
      validation.artifacts.server.sha256,
      validation.packagedClientE2E.qualificationSha256,
    ]) {
      expect(hash).toMatch(/^[a-f0-9]{64}$/u);
    }
    expect(validation.artifacts.server).toMatchObject({
      schemaVersion: 2,
      name: "blackglass-server",
      version: "0.2.2",
      sourceRevision: expect.stringMatching(/^[a-f0-9]{40}$/u),
      binaryName: "blackglass-server",
      architecture: "arm64",
    });
    expect(validation.packagedClientE2E).toMatchObject({
      passed: true,
      workflow: {
        generatedBackgroundTransfers: 3,
        bidirectionalSync: true,
        propagatedDeletion: true,
        gracefulServerRestart: true,
        postRestartSync: true,
        sourceClientRemoved: true,
        coldRecovery: true,
        finderLaunchServicesSmoke: true,
        defaultProfileIsolation: true,
        starterNoVaultFlow: true,
        starterControlRouting: true,
        noLaunchCrashOrEarlyExit: true,
      },
    });
    expect(Object.keys(loaded.baseline.javaScriptFiles)).toContain("app.js");
    expect(loaded.baseline.syncInboundOperations).toEqual({
      "app.js:pong": 1,
      "app.js:push": 1,
      "app.js:ready": 1,
    });
    expect(loaded.baseline.unpackedJavaScriptFiles).toEqual({
      "app.asar.unpacked/node_modules/btime/index.js": {
        bytes: 1726,
        sha256: "7ade5c334d6eb8a2e5ef8b6d52c5396641903af30c3c2ceda5e4934e3b88f35c",
      },
      "app.asar.unpacked/node_modules/get-fonts/index.js": {
        bytes: 115,
        sha256: "b44255cd3525bf6596a184d6d4db62c54be16826ac35c9384ead5f6a815a1b47",
      },
    });
    expect(loaded.baseline.unpackedJavaScriptReview).toEqual({
      status: "reviewed",
      reviewedPaths: [
        "app.asar.unpacked/node_modules/btime/index.js",
        "app.asar.unpacked/node_modules/get-fonts/index.js",
      ],
    });
  });

  test("stores the baseline as exact canonical JSON bytes", async () => {
    const path = resolve(root, "compatibility/obsidian-1.12.7.json");
    const bytes = await readFile(path);
    expect(bytes.at(-1)).toBe(10);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(
      "bade8064d0dc670619d0b9d2376a2f4bcdb87dd3999661d8036f74615bdbdc7e",
    );
  });
});

function gitRevision(): string {
  const result = Bun.spawnSync(["git", "-C", root, "rev-parse", "--verify", "HEAD"]);
  if (result.exitCode !== 0) throw new Error("Unable to resolve repository HEAD");
  const revision = result.stdout.toString().trim();
  if (!/^[a-f0-9]{40}$/u.test(revision)) throw new Error("Repository HEAD is malformed");
  return revision;
}
