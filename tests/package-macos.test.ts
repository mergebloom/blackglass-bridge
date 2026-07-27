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
import { inspectMacOSArtifact } from "../tools/macos-artifact";

const root = resolve(import.meta.dir, "..");

test("macOS packaging gives Blackglass Bridge an independent identity", async () => {
  if (process.platform !== "darwin") return;

  const directory = await mkdtemp(join(tmpdir(), "blackglass-package-test-"));
  try {
    const sourceApp = join(directory, "Obsidian.app");
    const contents = join(sourceApp, "Contents");
    const resources = join(contents, "Resources");
    const executableDirectory = join(contents, "MacOS");
    await Promise.all([
      mkdir(resources, { recursive: true }),
      mkdir(executableDirectory, { recursive: true }),
    ]);

    const sourceAsar = makeArchive({
      "app.js": Buffer.from("source renderer"),
      "package.json": Buffer.from(JSON.stringify({ version: "1.12.7" })),
    });
    const patchedAsar = makeArchive({
      "app.js": Buffer.from("patched renderer"),
      "package.json": Buffer.from(JSON.stringify({ version: "1.12.7" })),
    });
    const patchedPath = join(directory, "patched.asar");
    await Promise.all([
      writeFile(join(resources, "obsidian.asar"), sourceAsar),
      writeFile(patchedPath, patchedAsar),
      writeFile(join(contents, "Info.plist"), sourceInfoPlist()),
      copyFile("/usr/bin/true", join(executableDirectory, "Obsidian")),
    ]);
    await chmod(join(executableDirectory, "Obsidian"), 0o755);

    const outputApp = join(directory, "Blackglass Bridge.app");
    const packageResult = Bun.spawnSync([
      "bun",
      "run",
      "tools/package-macos.ts",
      sourceApp,
      patchedPath,
      outputApp,
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
      bundleName: "Blackglass Bridge",
      displayName: "Blackglass Bridge",
      executableName: "Blackglass Bridge",
      registeredUrlSchemes: [],
      signature: "ad-hoc",
    });

    const infoPlist = join(outputApp, "Contents/Info.plist");
    expect(plistString(infoPlist, "CFBundleIdentifier")).toBe("com.blackglass.bridge");
    expect(plistString(infoPlist, "CFBundleName")).toBe("Blackglass Bridge");
    expect(hasPlistKey(infoPlist, "CFBundleURLTypes")).toBe(false);
    expect(hasPlistKey(infoPlist, "NSUbiquitousContainers")).toBe(false);
    expect(await inspectMacOSArtifact(outputApp)).toMatchObject({
      bundleIdentifier: "com.blackglass.bridge",
      version: "1.12.7",
      executableName: "Blackglass Bridge",
      embeddedAsarSha256: createHash("sha256").update(patchedAsar).digest("hex"),
      registeredUrlSchemes: [],
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);

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

function sourceInfoPlist(): string {
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
  <key>CFBundleURLTypes</key><array><dict>
    <key>CFBundleTypeRole</key><string>Editor</string>
    <key>CFBundleURLName</key><string>Obsidian</string>
    <key>CFBundleURLSchemes</key><array><string>obsidian</string></array>
  </dict></array>
  <key>NSUbiquitousContainers</key><dict><key>iCloud.md.obsidian</key><dict/></dict>
</dict></plist>
`;
}
