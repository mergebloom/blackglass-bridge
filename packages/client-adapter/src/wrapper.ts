import { createHash } from "node:crypto";
import {
  AsarArchive,
  asarHeaderSha256,
  replacePackedAsarEntry,
} from "../../../tools/asar";

export const WRAPPER_PATCH_FORMAT_VERSION = 1;
export const WRAPPER_INCISION_COUNT = 3;

const PROFILE_PATH_ANCHOR = `let currentBaseVersion = app.getVersion();
let currentPackageVersion = currentBaseVersion;
let dataPath = app.getPath('userData');

function pad(number) {
	if (number < 10) {
		return '0' + number;
	}
	return number;
}

function stamp() {
	let d = new Date();
	return d.getUTCFullYear() +
		'-' + pad(d.getUTCMonth() + 1) +
		'-' + pad(d.getUTCDate()) +
		' ' + pad(d.getUTCHours()) +
		':' + pad(d.getUTCMinutes()) +
		':' + pad(d.getUTCSeconds());
}

function logger(logfile) {
	let fileout = fs.openSync(logfile, 'a');
	let stdout = process.stdout;

	stdout.on('error', function(e) {
		// \`write\` failed. Do nothing...
	});`;

const PROFILE_PATH_REPLACEMENT = `let requestedDataPath=app.commandLine.getSwitchValue('user-data-dir');
let dataPath=requestedDataPath?path.resolve(requestedDataPath):path.join(app.getPath('appData'),'Blackglass Bridge');
fs.mkdirSync(dataPath,{recursive:true});
app.setPath('userData',dataPath);
app.setPath('sessionData',dataPath);
let currentBaseVersion=app.getVersion(),currentPackageVersion=currentBaseVersion;
function pad(n){return n<10?'0'+n:n}
function stamp(){return new Date().toISOString().slice(0,19).replace('T',' ')}
function logger(logfile){let fileout=fs.openSync(logfile,'a'),stdout=process.stdout;stdout.on('error',function(){})`;

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
const UPDATER_DISABLED_MARKER = UPDATER_QUEUE_REPLACEMENT;
const EMBEDDED_RENDERER_MARKER = UPDATED_ASAR_SELECTION_REPLACEMENT;

export interface WrapperPatchReport {
  patchFormatVersion: typeof WRAPPER_PATCH_FORMAT_VERSION;
  incisionCount: typeof WRAPPER_INCISION_COUNT;
  profileDirectory: "Blackglass Bridge";
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

export function patchMacOSWrapperMain(main: Buffer): Buffer {
  const source = main.toString("utf8");
  let patched = replaceExactlyOnce(
    source,
    PROFILE_PATH_ANCHOR,
    paddedReplacement(PROFILE_PATH_REPLACEMENT, PROFILE_PATH_ANCHOR.length, "profile"),
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
  requireExactlyOnce(main, UPDATER_DISABLED_MARKER, "patched wrapper updater marker");
  requireExactlyOnce(main, EMBEDDED_RENDERER_MARKER, "embedded renderer marker");
  if (
    main.includes(PROFILE_PATH_ANCHOR) ||
    main.includes(UPDATER_QUEUE_ANCHOR) ||
    main.includes(UPDATED_ASAR_SELECTION_ANCHOR)
  ) {
    throw new Error("Patched wrapper still contains an upstream safety anchor");
  }
  return {
    profileDirectory: "Blackglass Bridge",
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
