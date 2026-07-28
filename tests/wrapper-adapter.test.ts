import { createHash } from "node:crypto";
import { expect, test } from "bun:test";
import {
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
    patchFormatVersion: 1,
    incisionCount: 3,
    profileDirectory: "Blackglass Bridge",
    explicitUserDataDirHonored: true,
    upstreamUpdatesDisabled: true,
    embeddedRendererOnly: true,
  });
  expect(generated.report.mainAfterSha256).not.toBe(
    generated.report.mainBeforeSha256,
  );
  expect(inspectPatchedMacOSWrapperAsar(generated.buffer)).toEqual({
    profileDirectory: "Blackglass Bridge",
    explicitUserDataDirHonored: true,
    upstreamUpdatesDisabled: true,
    embeddedRendererOnly: true,
  });
});

test("macOS wrapper honors an explicit disposable user-data directory", () => {
  const patched = patchMacOSWrapperMain(Buffer.from(wrapperMain())).toString("utf8");

  expect(patched).toContain(
    "let requestedDataPath=app.commandLine.getSwitchValue('user-data-dir');",
  );
  expect(patched).toContain(
    "requestedDataPath?path.resolve(requestedDataPath):path.join(app.getPath('appData'),'Blackglass Bridge')",
  );
  expect(patched).toContain("app.setPath('userData',dataPath);");
  expect(patched).toContain("app.setPath('sessionData',dataPath);");
});

test("macOS wrapper patch fails closed when an anchor is ambiguous", () => {
  const upstream = Buffer.from(`${wrapperMain()}${wrapperMain()}`);
  expect(() => patchMacOSWrapperMain(upstream)).toThrow("must match exactly once");
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
if (isV2MoreRecent(app.getVersion(), version)) {
\t\tupdatedAsarPath = path.join(dataPath, candidateFile);
\t\tupdatedAsarVersion = version;
\t}
`;
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
