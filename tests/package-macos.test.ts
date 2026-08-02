import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { expect, test } from "bun:test";
import { patchAsar } from "../packages/client-adapter/src/patch";
import { inspectMacOSArtifact } from "../tools/macos-artifact";
import { inspectMacOSCodeInventory } from "../tools/macos-code-inventory";
import {
  APPROVED_MACOS_ENTITLEMENTS,
  approvedMacOSEntitlementsPlist,
  inspectSourceMacOSCodeSigning,
} from "../tools/macos-code-signing";
import { asarHeaderSha256 } from "../tools/asar";
import { assertBlackglassReleaseManifest } from "../tools/release-manifest";
import {
  discoverRendererRelease,
  discoverUnpackedJavaScriptFiles,
  type CompatibilityAnchor,
  type CompatibilityBaseline,
} from "../tools/release-compatibility";
import { computeTreeIdentity } from "../tools/tree-identity";
import { assertMacOSReproducibilityEvidenceBinds } from "../tools/verify-macos-reproducibility";

const root = resolve(import.meta.dir, "..");

test("macOS packaging gives Blackglass an independent identity", async () => {
  if (process.platform !== "darwin") return;

  const directory = await mkdtemp(join(tmpdir(), "blackglass-package-test-"));
  try {
    const sourceApp = join(directory, "Obsidian.app");
    const contents = join(sourceApp, "Contents");
    const resources = join(contents, "Resources");
    const executableDirectory = join(contents, "MacOS");
    const frameworks = join(contents, "Frameworks");
    await Promise.all([
      mkdir(resources, { recursive: true }),
      mkdir(executableDirectory, { recursive: true }),
      mkdir(frameworks, { recursive: true }),
    ]);

    const sourceAsar = makeRendererArchive();
    const sourceWrapperAsar = makeArchive({
      "main.js": Buffer.from(sourceWrapperMain()),
      "package.json": Buffer.from(JSON.stringify({ name: "obsidian" })),
    });
    const endpoints = {
      controlOrigin: "http://127.0.0.1:3000",
      dataHost: "127.0.0.1:3003",
    };
    const patchedAsar = patchAsar(sourceAsar, endpoints).buffer;
    const sourceWrapperSha256 = asarHeaderSha256(sourceWrapperAsar);
    const patchedPath = join(directory, "patched.asar");
    const baselinePath = join(directory, "compatibility.json");
    const manifestPath = join(directory, "release-manifest.json");
    const receiptPath = join(directory, "package-receipt.json");
    const officialDmgPath = join(directory, "Obsidian-1.12.7.dmg");
    await Promise.all([
      writeFile(join(resources, "obsidian.asar"), sourceAsar),
      writeFile(join(resources, "app.asar"), sourceWrapperAsar),
      writeFile(patchedPath, patchedAsar),
      writeFile(join(contents, "Info.plist"), sourceInfoPlist(sourceWrapperSha256)),
      writeFile(officialDmgPath, "synthetic official DMG"),
      copyFile("/usr/bin/true", join(executableDirectory, "Obsidian")),
      readFile("/usr/bin/true").then((binary) => {
        const cliBinary = Buffer.from(binary);
        const firstSliceOffset =
          cliBinary.readUInt32BE(0) === 0xca_fe_ba_be
            ? cliBinary.readUInt32BE(16)
            : 0;
        Buffer.from(".obsidian-cli.sock .obsidian-cli.sock").copy(
          cliBinary,
          firstSliceOffset + 4096,
        );
        return writeFile(join(executableDirectory, "obsidian-cli"), cliBinary);
      }),
      ...sourceHelperBundles(frameworks),
      ...sourceFrameworkBundles(frameworks),
    ]);
    await chmod(join(executableDirectory, "Obsidian"), 0o755);
    await chmod(join(executableDirectory, "obsidian-cli"), 0o755);
    const staleNestedMachO = join(
      resources,
      "app.asar.unpacked/node_modules/stale-native/binding.node",
    );
    await mkdir(dirname(staleNestedMachO), { recursive: true });
    await copyFile("/usr/bin/true", staleNestedMachO);
    await chmod(staleNestedMachO, 0o755);
    runCommand([
      "codesign",
      "--force",
      "--sign",
      "-",
      "--options",
      "runtime",
      "--timestamp=none",
      staleNestedMachO,
    ]);
    const staleNestedBytes = await readFile(staleNestedMachO);
    const staleFirstSliceOffset =
      staleNestedBytes.readUInt32BE(0) === 0xca_fe_ba_be
        ? staleNestedBytes.readUInt32BE(16)
        : 0;
    staleNestedBytes[staleFirstSliceOffset + 4096] =
      staleNestedBytes[staleFirstSliceOffset + 4096]! ^ 1;
    await writeFile(staleNestedMachO, staleNestedBytes);
    const entitlementsPath = join(directory, "source-entitlements.plist");
    await writeFile(entitlementsPath, approvedMacOSEntitlementsPlist());
    signSyntheticSource(sourceApp, entitlementsPath);
    expect(
      Bun.spawnSync([
        "codesign",
        "--verify",
        "--strict",
        "--all-architectures",
        staleNestedMachO,
      ]).exitCode,
    ).not.toBe(0);
    const compatibilityBaseline = await testCompatibilityBaseline(
      sourceAsar,
      sourceWrapperAsar,
      sourceApp,
      officialDmgPath,
    );
    await writeFile(
      baselinePath,
      `${JSON.stringify(compatibilityBaseline, null, 2)}\n`,
    );

    const wrongNameResult = Bun.spawnSync([
      "bun", "run", "tools/package-macos.ts", sourceApp, patchedPath,
      join(directory, "Renamed Blackglass.app"), "--control-origin", endpoints.controlOrigin,
      "--data-host", endpoints.dataHost, "--manifest", join(directory, "wrong-name.json"),
      "--official-dmg", officialDmgPath, "--baseline", baselinePath,
    ], { cwd: root, stdout: "pipe", stderr: "pipe" });
    expect(wrongNameResult.exitCode).not.toBe(0);
    expect(wrongNameResult.stderr.toString()).toContain(
      'basename must be exactly "Blackglass.app"',
    );

    const outputApp = join(directory, "Blackglass.app");
    const packageResult = Bun.spawnSync([
      "bun",
      "run",
      "tools/package-macos.ts",
      sourceApp,
      patchedPath,
      outputApp,
      "--control-origin",
      endpoints.controlOrigin,
      "--data-host",
      endpoints.dataHost,
      "--manifest",
      manifestPath,
      "--receipt",
      receiptPath,
      "--official-dmg",
      officialDmgPath,
      "--baseline",
      baselinePath,
    ], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(packageResult.exitCode, packageResult.stderr.toString()).toBe(0);
    const report = JSON.parse(packageResult.stdout.toString());
    expect(report).toMatchObject({
      sourceBundleIdentifier: "md.obsidian",
      bundleIdentifier: "com.blackglass.app",
      bundleName: "Obsidian",
      displayName: "Blackglass",
      executableName: "Obsidian",
      profileDirectory: "Blackglass",
      profileMode: 0o700,
      profilePathCanonicalAtSetup: true,
      explicitUserDataDirHonored: true,
      profileHomeEnvironment: "BLACKGLASS_HOME",
      dedicatedHomeValidated: true,
      nativeHomeFallbackPreserved: true,
      upstreamUpdatesDisabled: true,
      embeddedRendererOnly: true,
      helperBundleIdentifiers: [
        "md.obsidian.helper",
        "md.obsidian.helper.GPU",
        "md.obsidian.helper.Plugin",
        "md.obsidian.helper.Renderer",
      ],
      codeSigning: {
        formatVersion: 2,
        signature: "ad-hoc",
        allReviewedTargetsHardenedRuntime: true,
        allInventoryTargetsStrictlyVerified: true,
        allArchitecturesStrictlyVerified: true,
        strictInventoryTargets: compatibilityBaseline.sourceMacOSCodeInventory.entries.length,
        strictMachOTargets: compatibilityBaseline.sourceMacOSCodeInventory.entries.filter(
          (entry) => entry.kind === "mach-o",
        ).length,
        approvedEntitlements: [...APPROVED_MACOS_ENTITLEMENTS],
      },
      registeredUrlSchemes: [],
      signature: "ad-hoc",
    });
    expect(report.releaseManifest).toMatchObject({
      schemaVersion: 9,
      rendererVersion: "1.12.7",
      endpoints,
      patcher: {
        renderer: { formatVersion: 7, incisions: 6 },
        wrapper: { formatVersion: 5, incisions: 3 },
        cli: { formatVersion: 2, incisions: 2 },
      },
      reproduction: {
        officialDmgMatchedBaseline: true,
        sourceAppTreeMatchedBaseline: true,
        stagedCopyTreeMatchedSource: true,
        reviewedSourceRenderer: true,
        sourceWrapperMatchesBaseline: true,
        rendererByteIdentical: true,
        packagedRendererByteIdentical: true,
        packagedWrapperIntegrityVerified: true,
        packagedCliSocketVerified: true,
        reviewedCodeSigningPreserved: true,
        sourceCodeInventoryMatchedBaseline: true,
        packagedCodeInventoryMatchedSource: true,
      },
    });
    expect(JSON.parse(await Bun.file(manifestPath).text())).toEqual(
      report.releaseManifest,
    );
    expect(JSON.parse(await Bun.file(receiptPath).text())).toEqual(
      report.packageReceipt,
    );
    expect(() => assertBlackglassReleaseManifest(report.releaseManifest)).not.toThrow();
    const secondDirectory = join(directory, "independent-build");
    await mkdir(secondDirectory);
    const secondApp = join(secondDirectory, "Blackglass.app");
    const secondManifest = join(secondDirectory, "release-manifest.json");
    const secondReceipt = join(secondDirectory, "package-receipt.json");
    const secondPackageResult = Bun.spawnSync([
      "bun", "run", "tools/package-macos.ts", sourceApp, patchedPath, secondApp,
      "--control-origin", endpoints.controlOrigin, "--data-host", endpoints.dataHost,
      "--manifest", secondManifest, "--official-dmg", officialDmgPath,
      "--baseline", baselinePath, "--receipt", secondReceipt,
    ], { cwd: root, stdout: "pipe", stderr: "pipe" });
    expect(secondPackageResult.exitCode, secondPackageResult.stderr.toString()).toBe(0);
    const reproducibilityPath = join(directory, "client-reproducibility.json");
    const reproducibilityResult = Bun.spawnSync([
      "bun", "run", "tools/verify-macos-reproducibility.ts",
      outputApp, manifestPath, receiptPath,
      secondApp, secondManifest, secondReceipt, reproducibilityPath,
    ], { cwd: root, stdout: "pipe", stderr: "pipe" });
    expect(reproducibilityResult.exitCode, reproducibilityResult.stderr.toString()).toBe(0);
    const reproducibility = JSON.parse(await Bun.file(reproducibilityPath).text());
    expect(reproducibility).toMatchObject({
      schemaVersion: 4,
      passed: true,
      separateOutputs: true,
      independentPackageInvocations: true,
      blackglassVersion: "0.2.0",
      rendererVersion: "1.12.7",
      applicationTreeSha256: report.releaseManifest.macOS.applicationTreeSha256,
      codeInventorySha256: report.releaseManifest.macOS.codeInventory.sha256,
      rootMetadataSha256: report.releaseManifest.macOS.rootMetadata.sha256,
    });
    expect(JSON.stringify(reproducibility)).not.toContain(directory);
    expect(reproducibility.packageReceipts).toHaveLength(2);
    expect(reproducibility.packageReceipts[0].receipt.invocationId).not.toBe(
      reproducibility.packageReceipts[1].receipt.invocationId,
    );
    const copiedReceipt = join(secondDirectory, "copied-first-receipt.json");
    await copyFile(receiptPath, copiedReceipt);
    const copiedReceiptResult = Bun.spawnSync([
      "bun", "run", "tools/verify-macos-reproducibility.ts",
      outputApp, manifestPath, receiptPath,
      secondApp, secondManifest, copiedReceipt,
      join(directory, "copied-receipt-evidence.json"),
    ], { cwd: root, stdout: "pipe", stderr: "pipe" });
    expect(copiedReceiptResult.exitCode).not.toBe(0);
    expect(copiedReceiptResult.stderr.toString()).toContain(
      "distinct package invocations",
    );
    expect(() =>
      assertMacOSReproducibilityEvidenceBinds(
        { ...reproducibility, codeInventorySha256: "0".repeat(64) },
        {
          manifest: report.releaseManifest,
          releaseManifestSha256: reproducibility.releaseManifestSha256,
          artifact: report.releaseManifest.macOS,
        },
      ),
    ).toThrow("does not bind");
    const tamperedSource = structuredClone(report.releaseManifest);
    tamperedSource.source.rendererAsarSha256 = "0".repeat(64);
    expect(() => assertBlackglassReleaseManifest(tamperedSource)).toThrow(
      "artifact bindings",
    );
    const tamperedTree = structuredClone(report.releaseManifest);
    tamperedTree.macOS.applicationTreeIdentity.files += 1;
    expect(() => assertBlackglassReleaseManifest(tamperedTree)).toThrow(
      "counts are inconsistent",
    );

    const infoPlist = join(outputApp, "Contents/Info.plist");
    expect(plistString(infoPlist, "CFBundleIdentifier")).toBe("com.blackglass.app");
    expect(plistString(infoPlist, "CFBundleDisplayName")).toBe("Blackglass");
    expect(plistString(infoPlist, "CFBundleName")).toBe("Obsidian");
    expect(plistString(infoPlist, "CFBundleExecutable")).toBe("Obsidian");
    expect(plistString(infoPlist, "NSMicrophoneUsageDescription")).toBe(
      "Allow Blackglass to record audio.",
    );
    expect(await Bun.file(join(outputApp, "Contents/MacOS/Obsidian")).exists()).toBe(true);
    expect(hasPlistKey(infoPlist, "CFBundleURLTypes")).toBe(false);
    expect(hasPlistKey(infoPlist, "NSUbiquitousContainers")).toBe(false);
    for (const helper of upstreamHelperBundles()) {
      const helperInfoPlist = join(
        outputApp,
        "Contents/Frameworks",
        `${helper.name}.app/Contents/Info.plist`,
      );
      expect(plistString(helperInfoPlist, "CFBundleIdentifier")).toBe(helper.identifier);
      expect(plistString(helperInfoPlist, "CFBundleDisplayName")).toBe(helper.name);
      expect(plistString(helperInfoPlist, "CFBundleExecutable")).toBe(helper.name);
      expect(
        await Bun.file(
          join(outputApp, "Contents/Frameworks", `${helper.name}.app/Contents/MacOS`, helper.name),
        ).exists(),
      ).toBe(true);
    }
    expect(await inspectMacOSArtifact(outputApp)).toMatchObject({
      schemaVersion: 8,
      appBundleName: "Blackglass.app",
      bundleIdentifier: "com.blackglass.app",
      version: "1.12.7",
      bundleName: "Obsidian",
      displayName: "Blackglass",
      executableName: "Obsidian",
      cliExecutableName: "obsidian-cli",
      cliSocketName: ".blackglass-c.sock",
      cliSocketOccurrences: 2,
      rendererRuntimeHomeEnvironment: "BLACKGLASS_HOME",
      rendererCliRuntimeRootValidated: true,
      profileDirectory: "Blackglass",
      profileMode: 0o700,
      profilePathCanonicalAtSetup: true,
      explicitUserDataDirHonored: true,
      profileHomeEnvironment: "BLACKGLASS_HOME",
      dedicatedHomeValidated: true,
      nativeHomeFallbackPreserved: true,
      upstreamUpdatesDisabled: true,
      embeddedRendererOnly: true,
      helperBundleIdentifiers: [
        "md.obsidian.helper",
        "md.obsidian.helper.GPU",
        "md.obsidian.helper.Plugin",
        "md.obsidian.helper.Renderer",
      ],
      codeSigning: {
        formatVersion: 2,
        signature: "ad-hoc",
        allReviewedTargetsHardenedRuntime: true,
        allInventoryTargetsStrictlyVerified: true,
        allArchitecturesStrictlyVerified: true,
        strictInventoryTargets: compatibilityBaseline.sourceMacOSCodeInventory.entries.length,
        strictMachOTargets: compatibilityBaseline.sourceMacOSCodeInventory.entries.filter(
          (entry) => entry.kind === "mach-o",
        ).length,
        approvedEntitlements: [...APPROVED_MACOS_ENTITLEMENTS],
        targets: expectedPackagedSigningTargets(),
      },
      codeInventory: compatibilityBaseline.sourceMacOSCodeInventory,
      embeddedAsarSha256: createHash("sha256").update(patchedAsar).digest("hex"),
      registeredUrlSchemes: [],
    });

    const metadataProbe = join(outputApp, "Contents/Resources");
    runCommand(["xattr", "-w", "com.blackglass.unexpected", "blocked", metadataProbe]);
    await expect(inspectMacOSArtifact(outputApp)).rejects.toThrow(
      "unsupported extended attribute",
    );
    runCommand(["xattr", "-d", "com.blackglass.unexpected", metadataProbe]);
    runCommand(["chflags", "hidden", metadataProbe]);
    await expect(inspectMacOSArtifact(outputApp)).rejects.toThrow(
      "unsupported BSD flags",
    );
    runCommand(["chflags", "nohidden", metadataProbe]);
    runCommand(["chmod", "+a", "everyone deny delete", metadataProbe]);
    await expect(inspectMacOSArtifact(outputApp)).rejects.toThrow(
      "unsupported ACL",
    );
    runCommand(["chmod", "-N", metadataProbe]);
    await expect(inspectMacOSArtifact(outputApp)).resolves.toBeDefined();
    runCommand([
      "codesign",
      "--verify",
      "--strict",
      "--all-architectures",
      join(
        outputApp,
        "Contents/Resources/app.asar.unpacked/node_modules/stale-native/binding.node",
      ),
    ]);

    const strippedDirectory = join(directory, "stripped");
    await mkdir(strippedDirectory);
    const strippedApp = join(strippedDirectory, "Blackglass.app");
    runCommand(["ditto", outputApp, strippedApp]);
    runCommand(["codesign", "--force", "--deep", "--sign", "-", strippedApp]);
    await expect(inspectMacOSArtifact(strippedApp)).rejects.toThrow(
      "code-signing metadata",
    );

    const mismatchedDirectory = join(directory, "mismatched-endpoint");
    await mkdir(mismatchedDirectory);
    const mismatchedOutput = join(mismatchedDirectory, "Blackglass.app");
    const mismatchedManifest = join(mismatchedDirectory, "release.json");
    const mismatchedResult = Bun.spawnSync(
      [
        "bun",
        "run",
        "tools/package-macos.ts",
        sourceApp,
        patchedPath,
        mismatchedOutput,
        "--control-origin",
        "http://127.0.0.1:3010",
        "--data-host",
        endpoints.dataHost,
        "--manifest",
        mismatchedManifest,
        "--official-dmg",
        officialDmgPath,
        "--baseline",
        baselinePath,
      ],
      { cwd: root, stdout: "pipe", stderr: "pipe" },
    );
    expect(mismatchedResult.exitCode).not.toBe(0);
    expect(mismatchedResult.stderr.toString()).toContain(
      "not the byte-identical result",
    );
    expect(await Bun.file(mismatchedOutput).exists()).toBe(false);
    expect(await Bun.file(mismatchedManifest).exists()).toBe(false);

    const wrongDmg = join(directory, "wrong.dmg");
    await writeFile(wrongDmg, "not the reviewed release");
    const wrongDmgDirectory = join(directory, "wrong-dmg");
    await mkdir(wrongDmgDirectory);
    const wrongDmgOutput = join(wrongDmgDirectory, "Blackglass.app");
    const wrongDmgManifest = join(wrongDmgDirectory, "release.json");
    const wrongDmgResult = Bun.spawnSync([
      "bun", "run", "tools/package-macos.ts", sourceApp, patchedPath,
      wrongDmgOutput, "--control-origin", endpoints.controlOrigin,
      "--data-host", endpoints.dataHost, "--manifest", wrongDmgManifest,
      "--official-dmg", wrongDmg, "--baseline", baselinePath,
    ], { cwd: root, stdout: "pipe", stderr: "pipe" });
    expect(wrongDmgResult.exitCode).not.toBe(0);
    expect(wrongDmgResult.stderr.toString()).toContain("Official release DMG");
    expect(await Bun.file(wrongDmgOutput).exists()).toBe(false);
    expect(await Bun.file(wrongDmgManifest).exists()).toBe(false);

    const unexpectedCode = join(resources, "unexpected-native.node");
    await copyFile("/usr/bin/true", unexpectedCode);
    await chmod(unexpectedCode, 0o755);
    runCommand(["codesign", "--force", "--sign", "-", "--timestamp=none", unexpectedCode]);
    await writeFile(
      baselinePath,
      `${JSON.stringify({
        ...compatibilityBaseline,
        sourceAppTree: await computeTreeIdentity(sourceApp),
      }, null, 2)}\n`,
    );
    const unexpectedCodeDirectory = join(directory, "unexpected-code");
    await mkdir(unexpectedCodeDirectory);
    const unexpectedCodeResult = Bun.spawnSync([
      "bun", "run", "tools/package-macos.ts", sourceApp, patchedPath,
      join(unexpectedCodeDirectory, "Blackglass.app"),
      "--control-origin", endpoints.controlOrigin, "--data-host", endpoints.dataHost,
      "--manifest", join(unexpectedCodeDirectory, "release.json"),
      "--official-dmg", officialDmgPath, "--baseline", baselinePath,
    ], { cwd: root, stdout: "pipe", stderr: "pipe" });
    expect(unexpectedCodeResult.exitCode).not.toBe(0);
    expect(unexpectedCodeResult.stderr.toString()).toContain("code inventory");
    await rm(unexpectedCode);
    await writeFile(
      baselinePath,
      `${JSON.stringify(compatibilityBaseline, null, 2)}\n`,
    );

    await writeFile(join(resources, "unexpected.txt"), "mutated source");
    const changedSourceDirectory = join(directory, "changed-source");
    await mkdir(changedSourceDirectory);
    const changedSourceOutput = join(changedSourceDirectory, "Blackglass.app");
    const changedSourceManifest = join(changedSourceDirectory, "release.json");
    const changedSourceResult = Bun.spawnSync([
      "bun", "run", "tools/package-macos.ts", sourceApp, patchedPath,
      changedSourceOutput, "--control-origin", endpoints.controlOrigin,
      "--data-host", endpoints.dataHost, "--manifest", changedSourceManifest,
      "--official-dmg", officialDmgPath, "--baseline", baselinePath,
    ], { cwd: root, stdout: "pipe", stderr: "pipe" });
    expect(changedSourceResult.exitCode).not.toBe(0);
    expect(changedSourceResult.stderr.toString()).toContain("Source app tree");
    expect(await Bun.file(changedSourceOutput).exists()).toBe(false);
    expect(await Bun.file(changedSourceManifest).exists()).toBe(false);

    const helperWithoutEntitlements = join(
      sourceApp,
      "Contents/Frameworks/Obsidian Helper.app",
    );
    runCommand([
      "codesign",
      "--force",
      "--sign",
      "-",
      "--identifier",
      "md.obsidian.helper",
      "--options",
      "runtime",
      "--timestamp=none",
      helperWithoutEntitlements,
    ]);
    expect(() =>
      inspectSourceMacOSCodeSigning(
        sourceApp,
        compatibilityBaseline.sourceMacOSCodeInventory,
      )
    ).toThrow(
      "entitlements",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 120_000);

function makeRendererArchive(): Buffer {
  const controlExpression =
    '"https://"+[String.fromCharCode(97,112,105),"obsidian","md"].join(".")';
  const hostnameCondition =
    '!oee.call(h,".obsidian.md")&&"127.0.0.1"!==h';
  return makeArchive({
    "app.js": Buffer.from(
      `var dw=${controlExpression},mw=window.fetch;` +
        'function gw(path){return mw(dw+path,{method:"POST"})}' +
        `if(${hostnameCondition})throw Error();` +
        'gw("/user/signin");new WebSocket(url);socket.send({op:"ping"});' +
        'x.prototype.onMessage=function(e){var t=e.op;if("ready"===t)return};',
    ),
    "main.js": Buffer.from(
      'module.exports=function(c,i,l){const socket=D.join(!U&&process.env.XDG_RUNTIME_DIR||ce.homedir(),".obsidian-cli.sock");let g=D.join(u,"obsidian-cli");if(h.existsSync(g)){let w="/usr/local/bin/obsidian";ipcMain.on("is-dev",t=>{t.returnValue=l})}}',
    ),
    "starter.js": Buffer.from(
      `var sa=${controlExpression};gw("/user/signin");`,
    ),
    "index.html": Buffer.from('<script src="app.js"></script>'),
    "package.json": Buffer.from(JSON.stringify({ version: "1.12.7" })),
  });
}

async function testCompatibilityBaseline(
  sourceAsar: Buffer,
  sourceWrapperAsar: Buffer,
  sourceApp: string,
  officialDmgPath: string,
): Promise<CompatibilityBaseline> {
  const anchors: CompatibilityAnchor[] = [
    {
      id: "control-origin-constructor",
      file: "app.js",
      literal: 'String.fromCharCode(97,112,105),"obsidian","md"',
      expectedMatches: 1,
    },
    {
      id: "sync-websocket-host-authorization",
      file: "app.js",
      literal: '!oee.call(h,".obsidian.md")&&"127.0.0.1"!==h',
      expectedMatches: 1,
    },
    {
      id: "renderer-script-reference",
      file: "index.html",
      literal: "app.js",
      expectedMatches: 1,
    },
    {
      id: "desktop-is-dev-ipc-handler",
      file: "main.js",
      literal: 'ipcMain.on("is-dev"',
      expectedMatches: 1,
    },
  ];
  const discovered = discoverRendererRelease(sourceAsar, anchors);
  const unpackedJavaScriptFiles = await discoverUnpackedJavaScriptFiles(
    join(sourceApp, "Contents/Resources"),
  );
  const discoveredWithUnpacked = discoverRendererRelease(
    sourceAsar,
    anchors,
    unpackedJavaScriptFiles,
  );
  return {
    schemaVersion: 5,
    id: "synthetic-obsidian-1.12.7",
    rendererVersion: discovered.rendererVersion,
    officialDmgSha256: createHash("sha256")
      .update(Buffer.from(await Bun.file(officialDmgPath).arrayBuffer()))
      .digest("hex"),
    sourceAppTree: await computeTreeIdentity(sourceApp),
    sourceMacOSCodeInventory: await inspectMacOSCodeInventory(
      sourceApp,
      "source-contract",
    ),
    sourceAsarSha256: discovered.sourceAsarSha256,
    sourceWrapperAsarSha256: createHash("sha256")
      .update(sourceWrapperAsar)
      .digest("hex"),
    keyFiles: discoveredWithUnpacked.keyFiles,
    javaScriptFiles: discoveredWithUnpacked.javaScriptFiles,
    unpackedJavaScriptFiles: discoveredWithUnpacked.unpackedJavaScriptFiles,
    unpackedJavaScriptReview: {
      status: "reviewed",
      reviewedPaths: Object.keys(discoveredWithUnpacked.unpackedJavaScriptFiles),
    },
    anchors,
    controlPlaneRoutes: discoveredWithUnpacked.controlPlaneRoutes,
    controlPlaneRouteLocations: discoveredWithUnpacked.controlPlaneRouteLocations,
    controlPlaneRequestHelpers: discoveredWithUnpacked.controlPlaneRequestHelpers,
    networkConstructors: discoveredWithUnpacked.networkConstructors,
    syncOperations: discoveredWithUnpacked.syncOperations,
    syncOperationLocations: discoveredWithUnpacked.syncOperationLocations,
    syncMessageShapes: discoveredWithUnpacked.syncMessageShapes,
    syncMessageShapeLocations: discoveredWithUnpacked.syncMessageShapeLocations,
    syncInboundOperations: discoveredWithUnpacked.syncInboundOperations,
  };
}

function makeArchive(files: Record<string, Buffer>): Buffer {
  let offset = 0;
  const nodes: Record<string, unknown> = {};
  const payloads: Buffer[] = [];
  for (const [name, contents] of Object.entries(files)) {
    nodes[name] = {
      size: contents.length,
      offset: String(offset),
      integrity: {
        algorithm: "SHA256",
        hash: createHash("sha256").update(contents).digest("hex"),
      },
    };
    payloads.push(contents);
    offset += contents.length;
  }
  const json = Buffer.from(JSON.stringify({ files: nodes }), "utf8");
  const paddedStringLength = align4(json.length);
  const headerPayloadSize = 4 + paddedStringLength;
  const headerPickleSize = 4 + headerPayloadSize;
  const header = Buffer.alloc(8 + headerPickleSize);
  header.writeUInt32LE(4, 0);
  header.writeUInt32LE(headerPickleSize, 4);
  header.writeUInt32LE(headerPayloadSize, 8);
  header.writeUInt32LE(json.length, 12);
  json.copy(header, 16);
  return Buffer.concat([header, ...payloads]);
}

function align4(value: number): number {
  return (value + 3) & ~3;
}

function plistString(infoPlist: string, key: string): string {
  const result = Bun.spawnSync([
    "plutil",
    "-extract",
    key,
    "raw",
    "-o",
    "-",
    infoPlist,
  ]);
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  return result.stdout.toString().trim();
}

function hasPlistKey(infoPlist: string, key: string): boolean {
  return Bun.spawnSync(["plutil", "-type", key, infoPlist], {
    stdout: "ignore",
    stderr: "ignore",
  }).exitCode === 0;
}

function upstreamHelperBundles(): Array<{ name: string; identifier: string }> {
  return [
    { name: "Obsidian Helper", identifier: "md.obsidian.helper" },
    { name: "Obsidian Helper (GPU)", identifier: "md.obsidian.helper.GPU" },
    { name: "Obsidian Helper (Plugin)", identifier: "md.obsidian.helper.Plugin" },
    { name: "Obsidian Helper (Renderer)", identifier: "md.obsidian.helper.Renderer" },
  ];
}

function sourceHelperBundles(frameworks: string): Promise<void>[] {
  return upstreamHelperBundles().map(async (helper) => {
    const contents = join(frameworks, `${helper.name}.app/Contents`);
    const executableDirectory = join(contents, "MacOS");
    await mkdir(executableDirectory, { recursive: true });
    await Promise.all([
      writeFile(join(contents, "Info.plist"), helperInfoPlist(helper.name, helper.identifier)),
      copyFile("/usr/bin/true", join(executableDirectory, helper.name)),
    ]);
    await chmod(join(executableDirectory, helper.name), 0o755);
  });
}

function sourceFrameworkBundles(frameworks: string): Promise<void>[] {
  const definitions = [
    { name: "Electron Framework", identifier: "com.github.Electron.framework" },
    { name: "Mantle", identifier: "org.mantle.Mantle" },
    { name: "ReactiveObjC", identifier: "com.electron.reactive" },
    { name: "Squirrel", identifier: "com.github.Squirrel" },
  ];
  return definitions.map(async ({ name, identifier }) => {
    const framework = join(frameworks, `${name}.framework`);
    const versions = join(framework, "Versions");
    const current = join(versions, "A");
    const resources = join(current, "Resources");
    await mkdir(resources, { recursive: true });
    await Promise.all([
      copyFile("/usr/bin/true", join(current, name)),
      writeFile(
        join(resources, "Info.plist"),
        frameworkInfoPlist(name, identifier),
      ),
      symlink("A", join(versions, "Current")),
      symlink(`Versions/Current/${name}`, join(framework, name)),
      symlink("Versions/Current/Resources", join(framework, "Resources")),
    ]);
    await chmod(join(current, name), 0o755);
    if (name === "Electron Framework") {
      const helpers = join(current, "Helpers");
      await mkdir(helpers, { recursive: true });
      await copyFile(
        "/usr/bin/true",
        join(helpers, "chrome_crashpad_handler"),
      );
      await chmod(join(helpers, "chrome_crashpad_handler"), 0o755);
    }
    if (name === "Squirrel") {
      await copyFile("/usr/bin/true", join(resources, "ShipIt"));
      await chmod(join(resources, "ShipIt"), 0o755);
    }
  });
}

function helperInfoPlist(name: string, identifier: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleDisplayName</key><string>${name}</string>
  <key>CFBundleExecutable</key><string>${name}</string>
  <key>CFBundleIdentifier</key><string>${identifier}</string>
</dict></plist>
`;
}

function frameworkInfoPlist(name: string, identifier: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleExecutable</key><string>${name}</string>
  <key>CFBundleIdentifier</key><string>${identifier}</string>
  <key>CFBundlePackageType</key><string>FMWK</string>
</dict></plist>
`;
}

function signSyntheticSource(appPath: string, entitlementsPath: string): void {
  const targets = [
    {
      path: join(
        appPath,
        "Contents/Frameworks/Squirrel.framework/Versions/A/Resources/ShipIt",
      ),
      identifier: "ShipIt",
      entitlements: true,
    },
    {
      path: join(
        appPath,
        "Contents/Frameworks/Electron Framework.framework/Versions/A/Helpers/chrome_crashpad_handler",
      ),
      identifier: "chrome_crashpad_handler",
      entitlements: true,
    },
    ...[
      ["Electron Framework", "com.github.Electron.framework"],
      ["Mantle", "org.mantle.Mantle"],
      ["ReactiveObjC", "com.electron.reactive"],
      ["Squirrel", "com.github.Squirrel"],
    ].map(([name, identifier]) => ({
      path: join(appPath, "Contents/Frameworks", `${name}.framework`),
      identifier: identifier!,
      entitlements: false,
    })),
    {
      path: join(appPath, "Contents/MacOS/obsidian-cli"),
      identifier: "obsidian-cli",
      entitlements: true,
    },
    ...upstreamHelperBundles().map((helper) => ({
      path: join(appPath, "Contents/Frameworks", `${helper.name}.app`),
      identifier: helper.identifier,
      entitlements: true,
    })),
    { path: appPath, identifier: "md.obsidian", entitlements: true },
  ];
  for (const target of targets) {
    const arguments_ = [
      "codesign",
      "--force",
      "--sign",
      "-",
      "--identifier",
      target.identifier,
      "--options",
      "runtime",
      "--timestamp=none",
    ];
    if (target.entitlements) {
      arguments_.push(
        "--entitlements",
        entitlementsPath,
        "--generate-entitlement-der",
      );
    }
    arguments_.push(target.path);
    runCommand(arguments_);
  }
  runCommand(["codesign", "--verify", "--deep", "--strict", appPath]);
}

function expectedPackagedSigningTargets(): Array<Record<string, string>> {
  return [
    {
      role: "application",
      identifier: "com.blackglass.app",
      entitlementPolicy: "approved",
    },
    {
      role: "cli",
      identifier: "obsidian-cli",
      entitlementPolicy: "approved",
    },
    {
      role: "helper",
      identifier: "md.obsidian.helper",
      entitlementPolicy: "approved",
    },
    {
      role: "helper",
      identifier: "md.obsidian.helper.GPU",
      entitlementPolicy: "approved",
    },
    {
      role: "helper",
      identifier: "md.obsidian.helper.Plugin",
      entitlementPolicy: "approved",
    },
    {
      role: "helper",
      identifier: "md.obsidian.helper.Renderer",
      entitlementPolicy: "approved",
    },
    {
      role: "auxiliary",
      identifier: "ShipIt",
      entitlementPolicy: "approved",
    },
    {
      role: "auxiliary",
      identifier: "chrome_crashpad_handler",
      entitlementPolicy: "approved",
    },
    {
      role: "framework",
      identifier: "com.github.Electron.framework",
      entitlementPolicy: "none",
    },
    {
      role: "framework",
      identifier: "org.mantle.Mantle",
      entitlementPolicy: "none",
    },
    {
      role: "framework",
      identifier: "com.electron.reactive",
      entitlementPolicy: "none",
    },
    {
      role: "framework",
      identifier: "com.github.Squirrel",
      entitlementPolicy: "none",
    },
  ];
}

function runCommand(arguments_: string[]): void {
  const result = Bun.spawnSync(arguments_, { stdout: "pipe", stderr: "pipe" });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
}

function sourceWrapperMain(): string {
  return `const {app} = require('electron');
const path = require('path');
let currentBaseVersion = app.getVersion();
let currentPackageVersion = currentBaseVersion;
let dataPath = app.getPath('userData');

function pad(number) {
\tif (number < 10) {
\t\treturn '0' + number;
\t}
\treturn number;
}

function stamp() {
\tlet d = new Date();
\treturn d.getUTCFullYear() +
\t\t'-' + pad(d.getUTCMonth() + 1) +
\t\t'-' + pad(d.getUTCDate()) +
\t\t' ' + pad(d.getUTCHours()) +
\t\t':' + pad(d.getUTCMinutes()) +
\t\t':' + pad(d.getUTCSeconds());
}

function logger(logfile) {
\tlet fileout = fs.openSync(logfile, 'a');
\tlet stdout = process.stdout;

\tstdout.on('error', function(e) {
\t\t// \`write\` failed. Do nothing...
\t});

\tlet fn = function () {
\t\tlet data = stamp() + ' ' + util.format.apply(null, arguments) + os.EOL;

\t\ttry {
\t\t\tfs.writeSync(fileout, data);
\t\t\t// Don't output to stdout if the app requests silence mode (to avoid polluting CLI outputs)
\t\t\tif (!silence) stdout.write(data);
\t\t}
\t\tcatch (e) {
\t\t\t// Failed to write to log
\t\t}
\t};

\tfn.end = function () {
\t\tfs.closeSync(fileout);
\t};

\treturn fn;
}

let updatePromise = app.whenReady();
let queueUpdate = (manual) => {
\tlet fn = () => update(manual);
\tupdatePromise = updatePromise.then(fn, fn);
};
setInterval(queueUpdate, 60 * 60 * 1000);
queueUpdate();
let updatedAsarPath = '';
let version = '';
let candidateFile = '';
function loadApp(asarPath) {
	let fn = require(path.join(asarPath, 'main.js'));
	if (fn) {
		fn(asarPath, updateEvents);
		return true;
	}
	return false;
}
if (isV2MoreRecent(app.getVersion(), version)) {
\t\tupdatedAsarPath = path.join(dataPath, candidateFile);
\t\tupdatedAsarVersion = version;
\t}
`;
}

function sourceInfoPlist(wrapperSha256: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleDisplayName</key><string>Obsidian</string>
  <key>CFBundleExecutable</key><string>Obsidian</string>
  <key>CFBundleIdentifier</key><string>md.obsidian</string>
  <key>CFBundleName</key><string>Obsidian</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.12.7</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>ElectronAsarIntegrity</key><dict>
    <key>Resources/app.asar</key><dict>
      <key>algorithm</key><string>SHA256</string>
      <key>hash</key><string>${wrapperSha256}</string>
    </dict>
  </dict>
  <key>CFBundleURLTypes</key><array><dict>
    <key>CFBundleTypeRole</key><string>Editor</string>
    <key>CFBundleURLName</key><string>Obsidian</string>
    <key>CFBundleURLSchemes</key><array><string>obsidian</string></array>
  </dict></array>
  <key>NSUbiquitousContainers</key><dict><key>iCloud.md.obsidian</key><dict/></dict>
  <key>NSMicrophoneUsageDescription</key><string>Allow Obsidian to record audio.</string>
</dict></plist>
`;
}
