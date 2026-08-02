import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import * as nodePath from "node:path";
import { expect, test } from "bun:test";
import {
  inspectEmbeddedRendererDevModeContract,
  inspectPatchedMacOSWrapperAsar,
  patchMacOSWrapperAsar,
  patchMacOSWrapperMain,
} from "../packages/client-adapter/src/wrapper";

test("macOS wrapper uses an isolated profile and disables upstream updates", () => {
  const upstreamMain = Buffer.from(wrapperMain());
  const upstream = makeArchive("main.js", upstreamMain);
  const generated = patchMacOSWrapperAsar(upstream);

  expect(generated.buffer.length).toBe(upstream.length);
  expect(generated.report).toMatchObject({
    patchFormatVersion: 5,
    incisionCount: 3,
    profileDirectory: "Blackglass",
    applicationName: "Blackglass",
    profileMode: 0o700,
    profilePathCanonicalAtSetup: true,
    explicitUserDataDirHonored: true,
    profileHomeEnvironment: "BLACKGLASS_HOME",
    dedicatedHomeValidated: true,
    nativeHomeFallbackPreserved: true,
    upstreamUpdatesDisabled: true,
    embeddedRendererOnly: true,
  });
  expect(generated.report.mainAfterSha256).not.toBe(
    generated.report.mainBeforeSha256,
  );
  expect(inspectPatchedMacOSWrapperAsar(generated.buffer)).toEqual({
    profileDirectory: "Blackglass",
    applicationName: "Blackglass",
    profileMode: 0o700,
    profilePathCanonicalAtSetup: true,
    explicitUserDataDirHonored: true,
    profileHomeEnvironment: "BLACKGLASS_HOME",
    dedicatedHomeValidated: true,
    nativeHomeFallbackPreserved: true,
    upstreamUpdatesDisabled: true,
    embeddedRendererOnly: true,
  });
});

test("macOS wrapper prefers BLACKGLASS_HOME while preserving native HOME fallback", () => {
  const patched = patchMacOSWrapperMain(Buffer.from(wrapperMain())).toString("utf8");

  expect(patched).toContain(
    "app.setName('Blackglass');",
  );
  expect(patched).toContain(
    "let B=process.env.BLACKGLASS_HOME,S=B&&fs.statSync(B);",
  );
  expect(patched).toContain(
    "let H=B||process.env.HOME,dataPath=path.resolve(app.commandLine.getSwitchValue('user-data-dir')",
  );
  expect(patched).toContain(
    "H?.[0]==='/'&&H+'/Library/Application Support/Blackglass'",
  );
  expect(patched).toContain("app.setPath('userData',dataPath);");
  expect(patched).toContain("app.setPath('sessionData',dataPath);");
  expect(patched).toContain("fs.chmodSync(dataPath,448);");
  expect(patched).toContain("fs.realpathSync(dataPath)!==dataPath");
});

test("macOS wrapper isolates BLACKGLASS_HOME, falls back to HOME, and honors explicit profile", () => {
  const root = fs.realpathSync(
    fs.mkdtempSync(nodePath.join(tmpdir(), "blackglass-wrapper-profile-")),
  );
  try {
    const patched = patchMacOSWrapperMain(Buffer.from(wrapperMain())).toString("utf8");
    const nativeHome = nodePath.join(root, "native-home");
    const dedicatedHome = nodePath.join(root, "dedicated-home");
    fs.mkdirSync(nativeHome, { mode: 0o700 });
    fs.mkdirSync(dedicatedHome, { mode: 0o700 });
    fs.chmodSync(nativeHome, 0o700);
    fs.chmodSync(dedicatedHome, 0o700);

    const defaultPaths = executeWrapper(patched, {
      nativeHome,
      blackglassHome: dedicatedHome,
    });
    const defaultProfile = nodePath.join(
      dedicatedHome,
      "Library/Application Support/Blackglass",
    );
    expect(defaultPaths).toEqual({
      userData: defaultProfile,
      sessionData: defaultProfile,
    });
    expect(fs.lstatSync(defaultProfile).mode & 0o777).toBe(0o700);
    expect(fs.existsSync(
      nodePath.join(
        nativeHome,
        "Library/Application Support/Blackglass",
      ),
    )).toBe(false);

    const nativePaths = executeWrapper(patched, { nativeHome });
    expect(nativePaths.userData).toBe(
      nodePath.join(
        nativeHome,
        "Library/Application Support/Blackglass",
      ),
    );
    for (const unsafeNativeHome of [undefined, "", "relative/home"]) {
      expect(() =>
        executeWrapper(patched, { nativeHome: unsafeNativeHome }),
      ).toThrow();
    }

    const explicitProfile = nodePath.join(root, "explicit");
    fs.mkdirSync(explicitProfile, { mode: 0o777 });
    fs.chmodSync(explicitProfile, 0o777);
    for (const irrelevantNativeHome of [undefined, "", "relative/home"]) {
      const explicitPaths = executeWrapper(patched, {
        explicitProfile,
        nativeHome: irrelevantNativeHome,
      });
      expect(explicitPaths.userData).toBe(explicitProfile);
      expect(explicitPaths.sessionData).toBe(explicitProfile);
    }
    expect(fs.lstatSync(explicitProfile).mode & 0o777).toBe(0o700);

    const target = nodePath.join(root, "target");
    const link = nodePath.join(root, "dedicated-link");
    fs.mkdirSync(target, { mode: 0o700 });
    fs.chmodSync(target, 0o700);
    fs.symlinkSync(target, link);
    expect(() =>
      executeWrapper(patched, {
        nativeHome,
        blackglassHome: link,
      }),
    ).toThrow("Unsafe home");

    const weakModeHome = nodePath.join(root, "weak-mode-home");
    fs.mkdirSync(weakModeHome, { mode: 0o755 });
    fs.chmodSync(weakModeHome, 0o755);
    expect(() =>
      executeWrapper(patched, {
        nativeHome,
        blackglassHome: weakModeHome,
      }),
    ).toThrow("Unsafe home");

    const relativeDedicatedHome = nodePath.relative(process.cwd(), dedicatedHome);
    expect(() =>
      executeWrapper(patched, {
        nativeHome,
        blackglassHome: relativeDedicatedHome,
      }),
    ).toThrow("Unsafe home");

    const explicitLink = nodePath.join(root, "explicit-link");
    fs.symlinkSync(target, explicitLink);
    expect(() =>
      executeWrapper(patched, {
        explicitProfile: explicitLink,
        nativeHome,
        blackglassHome: dedicatedHome,
      }),
    ).toThrow(
      "Unsafe path",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("macOS wrapper patch fails closed when an anchor is ambiguous", () => {
  const upstream = Buffer.from(`${wrapperMain()}${wrapperMain()}`);
  expect(() => patchMacOSWrapperMain(upstream)).toThrow("must match exactly once");
});

test("wrapper inspection rejects disabled home checks and changed native fallback", () => {
  const patched = patchMacOSWrapperMain(Buffer.from(wrapperMain())).toString("utf8");
  expect(() => inspectPatchedMacOSWrapperAsar(
    makeArchive("main.js", Buffer.from(patched)),
  )).not.toThrow();
  for (const changed of [
    patched.replace("if(B&&(", "if(0&&("),
    patched.replace("B||process.env.HOME", "B||process.env.PATH"),
  ]) {
    expect(() => inspectPatchedMacOSWrapperAsar(
      makeArchive("main.js", Buffer.from(changed)),
    )).toThrow("safety prelude");
  }
});

test("macOS wrapper rejects missing boundaries and altered reviewed spans", () => {
  expect(() =>
    patchMacOSWrapperMain(
      Buffer.from(wrapperMain().replace("let currentBaseVersion", "let otherVersion")),
    ),
  ).toThrow("start must match exactly once");
  expect(() =>
    patchMacOSWrapperMain(
      Buffer.from(wrapperMain().replace("function stamp()", "function changedStamp()")),
    ),
  ).toThrow("span does not match the reviewed wrapper");
});

test("packaged wrapper keeps the renderer's development fallback dormant", () => {
  const wrapper = makeArchive("main.js", Buffer.from(wrapperMain()));
  const renderer = makeArchive(
    "main.js",
    Buffer.from(
      'module.exports=function(c,i,l){ipcMain.on("is-dev",t=>{t.returnValue=l})}',
    ),
  );
  expect(inspectEmbeddedRendererDevModeContract(renderer, wrapper)).toEqual({
    wrapperRendererArguments: 2,
    rendererDevModeArgument: 3,
    packagedDevelopmentMode: false,
  });

  const unsafeWrapper = makeArchive(
    "main.js",
    Buffer.from(
      wrapperMain().replace(
        "fn(asarPath, updateEvents);",
        "fn(asarPath, updateEvents, true);",
      ),
    ),
  );
  expect(() =>
    inspectEmbeddedRendererDevModeContract(renderer, unsafeWrapper),
  ).toThrow("two-argument renderer invocation");
});

test("packaged 1.13 renderer has no development-mode argument or IPC fallback", () => {
  const wrapper = makeArchive("main.js", Buffer.from(wrapperMainCurrent()));
  const renderer = makeArchive(
    "main.js",
    Buffer.from("module.exports=function(i,e){return i+e}"),
  );
  expect(inspectEmbeddedRendererDevModeContract(renderer, wrapper)).toEqual({
    wrapperRendererArguments: 2,
    rendererDevModeArgument: null,
    packagedDevelopmentMode: false,
  });
  expect(() => patchMacOSWrapperMain(Buffer.from(wrapperMainCurrent()))).not.toThrow();
});

function wrapperMain(): string {
  return `let currentBaseVersion = app.getVersion();
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

function wrapperMainCurrent(): string {
  return wrapperMain().replace(
    `if (isV2MoreRecent(app.getVersion(), version)) {
\t\tupdatedAsarPath = path.join(dataPath, candidateFile);
\t\tupdatedAsarVersion = version;
\t}`,
    `let appVersion = app.getVersion();
\tif (version && (isV2MoreRecent(appVersion, version) || appVersion === version)) {
\t\tupdatedAsarPath = path.join(dataPath, candidateFile);
\t\tupdatedAsarVersion = version;
\t}`,
  );
}

function executeWrapper(
  source: string,
  options: {
    explicitProfile?: string;
    nativeHome?: string | undefined;
    blackglassHome?: string | undefined;
  },
): Record<string, string> {
  const paths: Record<string, string> = {};
  const app = {
    commandLine: { getSwitchValue: () => options.explicitProfile ?? "" },
    getPath: (name: string) => {
      throw new Error(`Unexpected app path: ${name}`);
    },
    getVersion: () => "1.12.7",
    setName: () => undefined,
    setPath: (name: string, value: string) => {
      paths[name] = value;
    },
    whenReady: () => Promise.resolve(),
  };
  new Function(
    "app",
    "fs",
    "path",
    "process",
    "setInterval",
    "isV2MoreRecent",
    source,
  )(
    app,
    fs,
    nodePath,
    {
      env: {
        ...(options.nativeHome === undefined ? {} : { HOME: options.nativeHome }),
        ...(options.blackglassHome === undefined
          ? {}
          : { BLACKGLASS_HOME: options.blackglassHome }),
      },
      getuid: () => process.getuid!(),
      stdout: { on: () => undefined },
    },
    () => undefined,
    () => false,
  );
  return paths;
}

function makeArchive(filename: string, content: Buffer): Buffer {
  const hash = createHash("sha256").update(content).digest("hex");
  const header = Buffer.from(
    JSON.stringify({
      files: {
        [filename]: {
          size: content.length,
          offset: "0",
          integrity: {
            algorithm: "SHA256",
            hash,
            blockSize: 4_194_304,
            blocks: [hash],
          },
        },
      },
    }),
    "utf8",
  );
  const paddedStringLength = (header.length + 3) & ~3;
  const headerPayloadSize = 4 + paddedStringLength;
  const headerPickleSize = 4 + headerPayloadSize;
  const output = Buffer.alloc(8 + headerPickleSize + content.length);
  output.writeUInt32LE(4, 0);
  output.writeUInt32LE(headerPickleSize, 4);
  output.writeUInt32LE(headerPayloadSize, 8);
  output.writeUInt32LE(header.length, 12);
  header.copy(output, 16);
  content.copy(output, 8 + headerPickleSize);
  return output;
}
