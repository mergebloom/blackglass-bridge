import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import * as nodePath from "node:path";
import { expect, test } from "bun:test";
import type { WrapperIncision } from "../packages/client-adapter/src/incision";
import {
  inspectEmbeddedRendererDevModeContract,
  inspectPatchedMacOSWrapperAsar,
  patchMacOSWrapperAsar,
  patchMacOSWrapperMain,
} from "../packages/client-adapter/src/wrapper";

test("uses hash-bound wrapper incisions for isolated state and disabled updates", () => {
  const fixture = syntheticWrapper();
  const generated = patchMacOSWrapperAsar(makeArchive("main.js", fixture.source), fixture.incisions);
  expect(generated.report).toMatchObject({
    patchFormatVersion: 6,
    incisionCount: 3,
    profileDirectory: "Blackglass",
    applicationName: "Blackglass",
    profileMode: 0o700,
    upstreamUpdatesDisabled: true,
    embeddedRendererOnly: true,
  });
  expect(inspectPatchedMacOSWrapperAsar(generated.buffer)).toMatchObject({
    applicationName: "Blackglass",
    dedicatedHomeValidated: true,
    upstreamUpdatesDisabled: true,
    embeddedRendererOnly: true,
  });
});

test("intrinsically rejects the normal Obsidian profile", () => {
  const fixture = syntheticWrapper();
  const patched = patchMacOSWrapperMain(fixture.source, fixture.incisions).toString("utf8");
  const root = fs.realpathSync(fs.mkdtempSync(nodePath.join(tmpdir(), "blackglass-wrapper-")));
  try {
    const nativeHome = nodePath.join(root, "home");
    const dedicatedHome = nodePath.join(root, "blackglass-home");
    fs.mkdirSync(nativeHome, { recursive: true, mode: 0o700 });
    fs.mkdirSync(dedicatedHome, { recursive: true, mode: 0o700 });
    fs.chmodSync(nativeHome, 0o700);
    fs.chmodSync(dedicatedHome, 0o700);

    const defaults = executeProfilePrelude(patched, { nativeHome, blackglassHome: dedicatedHome });
    expect(defaults.userData).toBe(
      nodePath.join(dedicatedHome, "Library/Application Support/Blackglass"),
    );
    expect(fs.lstatSync(defaults.userData!).mode & 0o777).toBe(0o700);

    const explicit = nodePath.join(root, "disposable-profile");
    const explicitPaths = executeProfilePrelude(patched, {
      nativeHome,
      blackglassHome: dedicatedHome,
      explicitProfile: explicit,
    });
    expect(explicitPaths.userData).toBe(explicit);

    const normal = nodePath.join(nativeHome, "Library/Application Support/obsidian");
    expect(() => executeProfilePrelude(patched, {
      nativeHome,
      blackglassHome: dedicatedHome,
      explicitProfile: normal,
    })).toThrow("Unsafe profile");
    expect(() => executeProfilePrelude(patched, {
      nativeHome,
      blackglassHome: dedicatedHome,
      explicitProfile: nodePath.join(normal, "nested"),
    })).toThrow("Unsafe profile");

    const target = nodePath.join(root, "target");
    const link = nodePath.join(root, "home-link");
    fs.mkdirSync(target, { mode: 0o700 });
    fs.symlinkSync(target, link);
    expect(() => executeProfilePrelude(patched, { nativeHome, blackglassHome: link }))
      .toThrow("Unsafe home");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("fails closed when a wrapper range changes, overlaps, or is out of bounds", () => {
  const fixture = syntheticWrapper();
  expect(() => patchMacOSWrapperMain(fixture.source, [
    { ...fixture.incisions[0]!, sha256: "0".repeat(64) },
    ...fixture.incisions.slice(1),
  ])).toThrow("hash mismatch");
  expect(() => patchMacOSWrapperMain(fixture.source, [
    fixture.incisions[0]!,
    { ...fixture.incisions[1]!, offset: fixture.incisions[0]!.offset + 1 },
    fixture.incisions[2]!,
  ])).toThrow("overlapping");
  expect(() => patchMacOSWrapperMain(fixture.source, [
    ...fixture.incisions.slice(0, 2),
    { ...fixture.incisions[2]!, offset: fixture.source.length + 1 },
  ])).toThrow("Invalid");
});

test("runtime contract is reviewed metadata bound to the exact renderer baseline", () => {
  const fixture = syntheticWrapper();
  const wrapper = patchMacOSWrapperAsar(makeArchive("main.js", fixture.source), fixture.incisions).buffer;
  const renderer = makeArchive("main.js", Buffer.from("module.exports=()=>42"));
  expect(inspectEmbeddedRendererDevModeContract(renderer, wrapper, {
    wrapperRendererArguments: 2,
    rendererDevModeArgument: null,
  })).toEqual({
    wrapperRendererArguments: 2,
    rendererDevModeArgument: null,
    packagedDevelopmentMode: false,
  });
});

function syntheticWrapper(): { source: Buffer; incisions: WrapperIncision[] } {
  const profile = " ".repeat(1400);
  const updater = " ".repeat(160);
  const embedded = " ".repeat(220);
  const source = Buffer.from(`${profile}\n${updater}\n${embedded}`);
  return {
    source,
    incisions: [
      incision("profile", source, 0, profile.length, "profile-bootstrap"),
      incision("updater", source, profile.length + 1, updater.length, "disable-updater"),
      incision(
        "renderer",
        source,
        profile.length + 1 + updater.length + 1,
        embedded.length,
        "embedded-renderer-only",
      ),
    ],
  };
}

function incision(
  id: string,
  source: Buffer,
  offset: number,
  length: number,
  replacement: WrapperIncision["replacement"],
): WrapperIncision {
  return {
    id,
    file: "main.js",
    offset,
    length,
    sha256: createHash("sha256").update(source.subarray(offset, offset + length)).digest("hex"),
    replacement,
  };
}

function executeProfilePrelude(
  source: string,
  options: { nativeHome: string; blackglassHome?: string; explicitProfile?: string },
): Record<string, string> {
  const paths: Record<string, string> = {};
  const app = {
    commandLine: { getSwitchValue: () => options.explicitProfile ?? "" },
    getVersion: () => "1.0.0",
    setName: () => undefined,
    setPath: (name: string, value: string) => { paths[name] = value; },
  };
  new Function(
    "app", "fs", "path", "process", "util", "os", "silence",
    `${source}\nreturn true;`,
  )(
    app,
    fs,
    nodePath,
    {
      env: {
        HOME: options.nativeHome,
        ...(options.blackglassHome ? { BLACKGLASS_HOME: options.blackglassHome } : {}),
      },
      getuid: () => process.getuid!(),
      stdout: { on: () => undefined },
    },
    { format: () => "" },
    { EOL: "\n" },
    true,
  );
  return paths;
}

function makeArchive(filename: string, content: Buffer): Buffer {
  const hash = createHash("sha256").update(content).digest("hex");
  const header = Buffer.from(JSON.stringify({
    files: {
      [filename]: {
        size: content.length,
        offset: "0",
        integrity: { algorithm: "SHA256", hash, blockSize: 4_194_304, blocks: [hash] },
      },
    },
  }));
  const padded = (header.length + 3) & ~3;
  const output = Buffer.alloc(16 + padded + content.length);
  output.writeUInt32LE(4, 0);
  output.writeUInt32LE(8 + padded, 4);
  output.writeUInt32LE(4 + padded, 8);
  output.writeUInt32LE(header.length, 12);
  header.copy(output, 16);
  content.copy(output, 16 + padded);
  return output;
}
