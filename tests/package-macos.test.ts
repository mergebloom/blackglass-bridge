import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "bun:test";
import { patchAsar } from "../packages/client-adapter/src/patch";
import { inspectMacOSArtifact } from "../tools/macos-artifact";
import { asarHeaderSha256 } from "../tools/asar";
import { assertBridgeReleaseManifest } from "../tools/release-manifest";
import {
  discoverRendererRelease,
  discoverUnpackedJavaScriptFiles,
  type CompatibilityAnchor,
  type CompatibilityBaseline,
} from "../tools/release-compatibility";
import { computeTreeIdentity } from "../tools/tree-identity";

const root = resolve(import.meta.dir, "..");

test("macOS packaging gives Blackglass Bridge an independent identity", async () => {
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
    const officialDmgPath = join(directory, "Obsidian-1.12.7.dmg");
    await Promise.all([
      writeFile(join(resources, "obsidian.asar"), sourceAsar),
      writeFile(join(resources, "app.asar"), sourceWrapperAsar),
      writeFile(patchedPath, patchedAsar),
      writeFile(join(contents, "Info.plist"), sourceInfoPlist(sourceWrapperSha256)),
      writeFile(officialDmgPath, "synthetic official DMG"),
      copyFile("/usr/bin/true", join(executableDirectory, "Obsidian")),
      ...sourceHelperBundles(frameworks),
    ]);
    await chmod(join(executableDirectory, "Obsidian"), 0o755);
    await writeFile(
      baselinePath,
      `${JSON.stringify(await testCompatibilityBaseline(
        sourceAsar,
        sourceWrapperAsar,
        sourceApp,
        officialDmgPath,
      ), null, 2)}\n`,
    );

    const outputApp = join(directory, "Blackglass Bridge.app");
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
      bundleIdentifier: "com.blackglass.bridge",
      bundleName: "Obsidian",
      displayName: "Blackglass Bridge",
      executableName: "Obsidian",
      profileDirectory: "Blackglass Bridge",
      explicitUserDataDirHonored: true,
      upstreamUpdatesDisabled: true,
      embeddedRendererOnly: true,
      helperBundleIdentifiers: [
        "md.obsidian.helper",
        "md.obsidian.helper.GPU",
        "md.obsidian.helper.Plugin",
        "md.obsidian.helper.Renderer",
      ],
      registeredUrlSchemes: [],
      signature: "ad-hoc",
    });
    expect(report.releaseManifest).toMatchObject({
      schemaVersion: 2,
      rendererVersion: "1.12.7",
      endpoints,
      patcher: {
        renderer: { formatVersion: 2, incisions: 2 },
        wrapper: { formatVersion: 1, incisions: 3 },
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
      },
    });
    expect(JSON.parse(await Bun.file(manifestPath).text())).toEqual(
      report.releaseManifest,
    );
    expect(() => assertBridgeReleaseManifest(report.releaseManifest)).not.toThrow();
    const tamperedSource = structuredClone(report.releaseManifest);
    tamperedSource.source.rendererAsarSha256 = "0".repeat(64);
    expect(() => assertBridgeReleaseManifest(tamperedSource)).toThrow(
      "artifact bindings",
    );
    const tamperedTree = structuredClone(report.releaseManifest);
    tamperedTree.macOS.applicationTreeIdentity.files += 1;
    expect(() => assertBridgeReleaseManifest(tamperedTree)).toThrow(
      "counts are inconsistent",
    );

    const infoPlist = join(outputApp, "Contents/Info.plist");
    expect(plistString(infoPlist, "CFBundleIdentifier")).toBe("com.blackglass.bridge");
    expect(plistString(infoPlist, "CFBundleDisplayName")).toBe("Blackglass Bridge");
    expect(plistString(infoPlist, "CFBundleName")).toBe("Obsidian");
    expect(plistString(infoPlist, "CFBundleExecutable")).toBe("Obsidian");
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
      bundleIdentifier: "com.blackglass.bridge",
      version: "1.12.7",
      bundleName: "Obsidian",
      displayName: "Blackglass Bridge",
      executableName: "Obsidian",
      profileDirectory: "Blackglass Bridge",
      explicitUserDataDirHonored: true,
      upstreamUpdatesDisabled: true,
      embeddedRendererOnly: true,
      helperBundleIdentifiers: [
        "md.obsidian.helper",
        "md.obsidian.helper.GPU",
        "md.obsidian.helper.Plugin",
        "md.obsidian.helper.Renderer",
      ],
      embeddedAsarSha256: createHash("sha256").update(patchedAsar).digest("hex"),
      registeredUrlSchemes: [],
    });

    const mismatchedOutput = join(directory, "Mismatched Bridge.app");
    const mismatchedManifest = join(directory, "mismatched-release.json");
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
    const wrongDmgOutput = join(directory, "Wrong DMG Bridge.app");
    const wrongDmgManifest = join(directory, "wrong-dmg-release.json");
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

    await writeFile(join(resources, "unexpected.txt"), "mutated source");
    const changedSourceOutput = join(directory, "Changed Source Bridge.app");
    const changedSourceManifest = join(directory, "changed-source-release.json");
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
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);

function makeRendererArchive(): Buffer {
  const controlExpression =
    '"https://"+[String.fromCharCode(97,112,105),"obsidian","md"].join(".")';
  const hostnameCondition =
    '!oee.call(h,".obsidian.md")&&"127.0.0.1"!==h';
  return makeArchive({
    "app.js": Buffer.from(
      `var dw=${controlExpression};if(${hostnameCondition})throw Error();` +
        'gw("/user/signin");socket.send({op:"ping"});',
    ),
    "main.js": Buffer.from('ipcMain.on("is-dev",()=>{});'),
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
    schemaVersion: 3,
    id: "synthetic-obsidian-1.12.7",
    rendererVersion: discovered.rendererVersion,
    officialDmgSha256: createHash("sha256")
      .update(Buffer.from(await Bun.file(officialDmgPath).arrayBuffer()))
      .digest("hex"),
    sourceAppTree: await computeTreeIdentity(sourceApp),
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
\treturn () => {};
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
</dict></plist>
`;
}
