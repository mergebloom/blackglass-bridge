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
    patchFormatVersion: 2,
    incisionCount: 3,
    profileDirectory: "Blackglass Bridge",
    profileMode: 0o700,
    profilePathCanonicalAtSetup: true,
    explicitUserDataDirHonored: true,
    upstreamUpdatesDisabled: true,
    embeddedRendererOnly: true,
  });
  expect(generated.report.mainAfterSha256).not.toBe(
    generated.report.mainBeforeSha256,
  );
  expect(inspectPatchedMacOSWrapperAsar(generated.buffer)).toEqual({
    profileDirectory: "Blackglass Bridge",
    profileMode: 0o700,
    profilePathCanonicalAtSetup: true,
    explicitUserDataDirHonored: true,
    upstreamUpdatesDisabled: true,
    embeddedRendererOnly: true,
  });
});

test("macOS wrapper honors an explicit disposable user-data directory", () => {
  const patched = patchMacOSWrapperMain(Buffer.from(wrapperMain())).toString("utf8");

  expect(patched).toContain(
    "let dataPath=path.resolve(app.commandLine.getSwitchValue('user-data-dir')",
  );
  expect(patched).toContain(
    "app.getPath('appData')+'/Blackglass Bridge'",
  );
  expect(patched).toContain("app.setPath('userData',dataPath);");
  expect(patched).toContain("app.setPath('sessionData',dataPath);");
  expect(patched).toContain("fs.chmodSync(dataPath,448);");
  expect(patched).toContain("fs.realpathSync(dataPath)!==dataPath");
});

test("macOS wrapper enforces mode 0700 for default and explicit profiles", () => {
  const root = fs.realpathSync(
    fs.mkdtempSync(nodePath.join(tmpdir(), "blackglass-wrapper-profile-")),
  );
  try {
    const patched = patchMacOSWrapperMain(Buffer.from(wrapperMain())).toString("utf8");
    const defaultPaths = executeWrapper(patched, root, "");
    const defaultProfile = nodePath.join(root, "Blackglass Bridge");
    expect(defaultPaths).toEqual({
      userData: defaultProfile,
      sessionData: defaultProfile,
    });
    expect(fs.lstatSync(defaultProfile).mode & 0o777).toBe(0o700);

    const explicitProfile = nodePath.join(root, "explicit");
    fs.mkdirSync(explicitProfile, { mode: 0o777 });
    fs.chmodSync(explicitProfile, 0o777);
    const explicitPaths = executeWrapper(patched, root, explicitProfile);
    expect(explicitPaths.userData).toBe(explicitProfile);
    expect(explicitPaths.sessionData).toBe(explicitProfile);
    expect(fs.lstatSync(explicitProfile).mode & 0o777).toBe(0o700);

    const target = nodePath.join(root, "target");
    const link = nodePath.join(root, "profile-link");
    fs.mkdirSync(target);
    fs.symlinkSync(target, link);
    expect(() => executeWrapper(patched, root, link)).toThrow(
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

function executeWrapper(
  source: string,
  appData: string,
  explicitProfile: string,
): Record<string, string> {
  const paths: Record<string, string> = {};
  const app = {
    commandLine: { getSwitchValue: () => explicitProfile },
    getPath: (name: string) => {
      if (name !== "appData") throw new Error(`Unexpected app path: ${name}`);
      return appData;
    },
    getVersion: () => "1.12.7",
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
    { stdout: { on: () => undefined } },
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
