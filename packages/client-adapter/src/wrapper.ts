import { createHash } from "node:crypto";
import {
  AsarArchive,
  asarHeaderSha256,
  replacePackedAsarEntry,
} from "../../../tools/asar";

export const WRAPPER_PATCH_FORMAT_VERSION = 2;
export const WRAPPER_INCISION_COUNT = 3;
export const WRAPPER_PROFILE_MODE = 0o700;

const PROFILE_PATH_START = `let currentBaseVersion = app.getVersion();
let currentPackageVersion = currentBaseVersion;
let dataPath = app.getPath('userData');`;
const PROFILE_PATH_END = `stdout.on('error', function(e) {
		// \`write\` failed. Do nothing...
	});`;
const PROFILE_PATH_SPAN_SHA256 =
  "1710f7c386568d09f00721ea42f35cfd952f4ab41870db028dd5a464d32c0068";

const PROFILE_PATH_REPLACEMENT = `let dataPath=path.resolve(app.commandLine.getSwitchValue('user-data-dir')||app.getPath('appData')+'/Blackglass Bridge');
fs.mkdirSync(dataPath,{recursive:true,mode:448});
if(fs.realpathSync(dataPath)!==dataPath||!fs.statSync(dataPath).isDirectory())throw Error('Unsafe path');
fs.chmodSync(dataPath,448);
app.setPath('userData',dataPath);
app.setPath('sessionData',dataPath);
let currentBaseVersion=app.getVersion(),currentPackageVersion=currentBaseVersion;
let stamp=()=>new Date().toISOString().replace('T',' ').slice(0,19);
function logger(l){let fileout=fs.openSync(l,'a'),stdout=process.stdout;stdout.on('error',()=>{})`;

const UPDATER_QUEUE_ANCHOR = `let queueUpdate = (manual) => {
	let fn = () => update(manual);
	updatePromise = updatePromise.then(fn, fn);
};`;

const UPDATER_QUEUE_REPLACEMENT = "let queueUpdate=()=>{};";
const UPDATED_ASAR_SELECTION_ANCHOR = `if (isV2MoreRecent(app.getVersion(), version)) {
		updatedAsarPath = path.join(dataPath, candidateFile);
		updatedAsarVersion = version;
	}`;
const UPDATED_ASAR_SELECTION_REPLACEMENT = "if(false){}";
const PROFILE_MARKER = "app.setPath('userData',dataPath);";
const SESSION_MARKER = "app.setPath('sessionData',dataPath);";
const EXPLICIT_PROFILE_MARKER =
  "app.commandLine.getSwitchValue('user-data-dir')";
const PROFILE_MODE_MARKER = "fs.chmodSync(dataPath,448);";
const PROFILE_CANONICAL_MARKER = "fs.realpathSync(dataPath)!==dataPath";
const UPDATER_DISABLED_MARKER = UPDATER_QUEUE_REPLACEMENT;
const EMBEDDED_RENDERER_MARKER = UPDATED_ASAR_SELECTION_REPLACEMENT;
const WRAPPER_RENDERER_CALL = "fn(asarPath, updateEvents);";
const RENDERER_EXPORT_SIGNATURE = "module.exports=function(c,i,l){";
const RENDERER_IS_DEV_BINDING =
  'ipcMain.on("is-dev",t=>{t.returnValue=l})';

export interface WrapperPatchReport {
  patchFormatVersion: typeof WRAPPER_PATCH_FORMAT_VERSION;
  incisionCount: typeof WRAPPER_INCISION_COUNT;
  profileDirectory: "Blackglass Bridge";
  profileMode: typeof WRAPPER_PROFILE_MODE;
  profilePathCanonicalAtSetup: true;
  explicitUserDataDirHonored: true;
  upstreamUpdatesDisabled: true;
  embeddedRendererOnly: true;
  upstreamSha256: string;
  patchedSha256: string;
  upstreamHeaderSha256: string;
  patchedHeaderSha256: string;
  mainBeforeSha256: string;
  mainAfterSha256: string;
}

export function patchMacOSWrapperAsar(
  upstream: Buffer,
): { buffer: Buffer; report: WrapperPatchReport } {
  const archive = AsarArchive.fromBuffer(upstream);
  const mainBefore = archive.read("main.js");
  const mainAfter = patchMacOSWrapperMain(mainBefore);
  const output = replacePackedAsarEntry(upstream, "main.js", mainAfter);
  inspectPatchedMacOSWrapperAsar(output);
  return {
    buffer: output,
    report: {
      patchFormatVersion: WRAPPER_PATCH_FORMAT_VERSION,
      incisionCount: WRAPPER_INCISION_COUNT,
      profileDirectory: "Blackglass Bridge",
      profileMode: WRAPPER_PROFILE_MODE,
      profilePathCanonicalAtSetup: true,
      explicitUserDataDirHonored: true,
      upstreamUpdatesDisabled: true,
      embeddedRendererOnly: true,
      upstreamSha256: sha256(upstream),
      patchedSha256: sha256(output),
      upstreamHeaderSha256: asarHeaderSha256(upstream),
      patchedHeaderSha256: asarHeaderSha256(output),
      mainBeforeSha256: sha256(mainBefore),
      mainAfterSha256: sha256(mainAfter),
    },
  };
}

export function inspectEmbeddedRendererDevModeContract(
  rendererAsar: Buffer,
  wrapperAsar: Buffer,
): {
  wrapperRendererArguments: 2;
  rendererDevModeArgument: 3;
  packagedDevelopmentMode: false;
} {
  const rendererMain = AsarArchive.fromBuffer(rendererAsar)
    .read("main.js")
    .toString("utf8");
  const wrapperMain = AsarArchive.fromBuffer(wrapperAsar)
    .read("main.js")
    .toString("utf8");
  requireExactlyOnce(
    wrapperMain,
    WRAPPER_RENDERER_CALL,
    "wrapper two-argument renderer invocation",
  );
  requireExactlyOnce(
    rendererMain,
    RENDERER_EXPORT_SIGNATURE,
    "renderer three-argument export",
  );
  requireExactlyOnce(
    rendererMain,
    RENDERER_IS_DEV_BINDING,
    "renderer development-mode argument binding",
  );
  return {
    wrapperRendererArguments: 2,
    rendererDevModeArgument: 3,
    packagedDevelopmentMode: false,
  };
}

export function patchMacOSWrapperMain(main: Buffer): Buffer {
  const source = main.toString("utf8");
  let patched = replaceExactBoundedSpan(
    source,
    PROFILE_PATH_START,
    PROFILE_PATH_END,
    PROFILE_PATH_SPAN_SHA256,
    PROFILE_PATH_REPLACEMENT,
    "wrapper profile anchor",
  );
  patched = replaceExactlyOnce(
    patched,
    UPDATER_QUEUE_ANCHOR,
    paddedReplacement(
      UPDATER_QUEUE_REPLACEMENT,
      UPDATER_QUEUE_ANCHOR.length,
      "updater",
    ),
    "wrapper updater anchor",
  );
  patched = replaceExactlyOnce(
    patched,
    UPDATED_ASAR_SELECTION_ANCHOR,
    paddedReplacement(
      UPDATED_ASAR_SELECTION_REPLACEMENT,
      UPDATED_ASAR_SELECTION_ANCHOR.length,
      "updated renderer selection",
    ),
    "wrapper updated renderer selection anchor",
  );
  const output = Buffer.from(patched, "utf8");
  if (output.length !== main.length) {
    throw new Error("Wrapper patch unexpectedly changed the byte length");
  }
  return output;
}

export function inspectPatchedMacOSWrapperAsar(wrapper: Buffer): {
  profileDirectory: "Blackglass Bridge";
  profileMode: typeof WRAPPER_PROFILE_MODE;
  profilePathCanonicalAtSetup: true;
  explicitUserDataDirHonored: true;
  upstreamUpdatesDisabled: true;
  embeddedRendererOnly: true;
} {
  const main = AsarArchive.fromBuffer(wrapper).read("main.js").toString("utf8");
  try {
    new Function(main);
  } catch (error) {
    throw new Error(`Patched wrapper main.js is not valid JavaScript: ${String(error)}`);
  }
  requireExactlyOnce(main, PROFILE_MARKER, "patched wrapper profile marker");
  requireExactlyOnce(main, SESSION_MARKER, "patched wrapper session marker");
  requireExactlyOnce(
    main,
    EXPLICIT_PROFILE_MARKER,
    "patched wrapper explicit profile marker",
  );
  requireExactlyOnce(main, PROFILE_MODE_MARKER, "patched wrapper profile mode marker");
  requireExactlyOnce(
    main,
    PROFILE_CANONICAL_MARKER,
    "patched wrapper canonical profile marker",
  );
  requireExactlyOnce(main, UPDATER_DISABLED_MARKER, "patched wrapper updater marker");
  requireExactlyOnce(main, EMBEDDED_RENDERER_MARKER, "embedded renderer marker");
  if (
    main.includes(PROFILE_PATH_START) ||
    main.includes(PROFILE_PATH_END) ||
    main.includes(UPDATER_QUEUE_ANCHOR) ||
    main.includes(UPDATED_ASAR_SELECTION_ANCHOR)
  ) {
    throw new Error("Patched wrapper still contains an upstream safety anchor");
  }
  return {
    profileDirectory: "Blackglass Bridge",
    profileMode: WRAPPER_PROFILE_MODE,
    profilePathCanonicalAtSetup: true,
    explicitUserDataDirHonored: true,
    upstreamUpdatesDisabled: true,
    embeddedRendererOnly: true,
  };
}

function paddedReplacement(value: string, length: number, label: string): string {
  if (value.length > length) {
    throw new Error(`Configured wrapper ${label} replacement is too long`);
  }
  return value.padEnd(length, " ");
}

function replaceExactBoundedSpan(
  input: string,
  startMarker: string,
  endMarker: string,
  expectedSha256: string,
  replacement: string,
  label: string,
): string {
  requireExactlyOnce(input, startMarker, `${label} start`);
  requireExactlyOnce(input, endMarker, `${label} end`);
  const start = input.indexOf(startMarker);
  const end = input.indexOf(endMarker) + endMarker.length;
  if (end <= start) throw new Error(`${label} boundaries are out of order`);
  const span = input.slice(start, end);
  if (sha256(Buffer.from(span, "utf8")) !== expectedSha256) {
    throw new Error(`${label} span does not match the reviewed wrapper`);
  }
  return (
    input.slice(0, start) +
    paddedReplacement(replacement, span.length, label) +
    input.slice(end)
  );
}

function replaceExactlyOnce(
  input: string,
  needle: string,
  replacement: string,
  label: string,
): string {
  requireExactlyOnce(input, needle, label);
  return input.replace(needle, replacement);
}

function requireExactlyOnce(input: string, needle: string, label: string): void {
  const first = input.indexOf(needle);
  if (first === -1 || input.indexOf(needle, first + needle.length) !== -1) {
    throw new Error(`${label} must match exactly once`);
  }
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
