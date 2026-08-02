import { createHash } from "node:crypto";
import {
  AsarArchive,
  asarHeaderSha256,
  replacePackedAsarEntry,
} from "../../../tools/asar";
import { BLACKGLASS_HOME_ENVIRONMENT } from "./runtime-home";

export const WRAPPER_PATCH_FORMAT_VERSION = 5;
export const WRAPPER_INCISION_COUNT = 3;
export const WRAPPER_PROFILE_MODE = 0o700;

const PROFILE_PATH_START = `let currentBaseVersion = app.getVersion();
let currentPackageVersion = currentBaseVersion;
let dataPath = app.getPath('userData');`;
const PROFILE_PATH_END = `	fn.end = function () {
		fs.closeSync(fileout);
	};

	return fn;
}`;
const PROFILE_PATH_SPAN_SHA256 =
  "e3136fcfce4c5cc87edafb0d211ccc729010be525e77b63684a0a05a9023c369";

const APPLICATION_NAME = "Blackglass" as const;
const APPLICATION_NAME_MARKER = `app.setName('${APPLICATION_NAME}');`;
const PROFILE_PATH_SAFETY_PRELUDE = `${APPLICATION_NAME_MARKER}
let B=process.env.${BLACKGLASS_HOME_ENVIRONMENT},S=B&&fs.statSync(B);
if(B&&(B[0]!=='/'||fs.realpathSync(B)!==B||!S.isDirectory()||(S.mode&511)!==448||S.uid!==process.getuid()))throw Error('Unsafe home');
let H=B||process.env.HOME,dataPath=path.resolve(app.commandLine.getSwitchValue('user-data-dir')||H?.[0]==='/'&&H+'/Library/Application Support/Blackglass');`;
const PROFILE_PATH_REPLACEMENT = `${PROFILE_PATH_SAFETY_PRELUDE}
fs.mkdirSync(dataPath,{recursive:true,mode:448});
if(fs.realpathSync(dataPath)!==dataPath)throw Error('Unsafe path');
fs.chmodSync(dataPath,448);
app.setPath('userData',dataPath);
app.setPath('sessionData',dataPath);
let currentBaseVersion=app.getVersion(),currentPackageVersion=currentBaseVersion;
let stamp=()=>new Date().toISOString().replace('T',' ').slice(0,19);
function logger(l){let f=fs.openSync(l,'a'),s=process.stdout;s.on('error',()=>{});let n=function(){let d=stamp()+' '+util.format.apply(null,arguments)+os.EOL;try{fs.writeSync(f,d);if(!silence)s.write(d)}catch{}};n.end=()=>fs.closeSync(f);return n}`;

const UPDATER_QUEUE_ANCHOR = `let queueUpdate = (manual) => {
	let fn = () => update(manual);
	updatePromise = updatePromise.then(fn, fn);
};`;

const UPDATER_QUEUE_REPLACEMENT = "let queueUpdate=()=>{};";
const UPDATED_ASAR_SELECTION_ANCHORS = [`if (isV2MoreRecent(app.getVersion(), version)) {
		updatedAsarPath = path.join(dataPath, candidateFile);
		updatedAsarVersion = version;
	}`,
`if (version && (isV2MoreRecent(appVersion, version) || appVersion === version)) {
		updatedAsarPath = path.join(dataPath, candidateFile);
		updatedAsarVersion = version;
	}`] as const;
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
const LEGACY_RENDERER_EXPORT_SIGNATURE = "module.exports=function(c,i,l){";
const CURRENT_RENDERER_EXPORT_SIGNATURE = "module.exports=function(i,e){";
const RENDERER_IS_DEV_BINDING =
  'ipcMain.on("is-dev",t=>{t.returnValue=l})';

export interface WrapperPatchReport {
  patchFormatVersion: typeof WRAPPER_PATCH_FORMAT_VERSION;
  incisionCount: typeof WRAPPER_INCISION_COUNT;
  profileDirectory: "Blackglass";
  applicationName: typeof APPLICATION_NAME;
  profileMode: typeof WRAPPER_PROFILE_MODE;
  profilePathCanonicalAtSetup: true;
  explicitUserDataDirHonored: true;
  profileHomeEnvironment: typeof BLACKGLASS_HOME_ENVIRONMENT;
  dedicatedHomeValidated: true;
  nativeHomeFallbackPreserved: true;
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
      profileDirectory: "Blackglass",
      applicationName: APPLICATION_NAME,
      profileMode: WRAPPER_PROFILE_MODE,
      profilePathCanonicalAtSetup: true,
      explicitUserDataDirHonored: true,
      profileHomeEnvironment: BLACKGLASS_HOME_ENVIRONMENT,
      dedicatedHomeValidated: true,
      nativeHomeFallbackPreserved: true,
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
  rendererDevModeArgument: 3 | null;
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
  const legacy = countOccurrences(rendererMain, LEGACY_RENDERER_EXPORT_SIGNATURE);
  const current = countOccurrences(rendererMain, CURRENT_RENDERER_EXPORT_SIGNATURE);
  if (legacy + current !== 1) {
    throw new Error(
      `renderer reviewed export signature must match exactly once (found ${legacy + current})`,
    );
  }
  if (legacy === 1) {
    requireExactlyOnce(
      rendererMain,
      RENDERER_IS_DEV_BINDING,
      "renderer development-mode argument binding",
    );
  } else if (rendererMain.includes('"is-dev"')) {
    throw new Error("two-argument renderer unexpectedly retains a development-mode IPC binding");
  }
  return {
    wrapperRendererArguments: 2,
    rendererDevModeArgument: legacy === 1 ? 3 : null,
    packagedDevelopmentMode: false,
  };
}

export function patchMacOSWrapperMain(main: Buffer): Buffer {
  const source = main.toString("utf8");
  const updatedAsarSelectionAnchor = selectExactlyOneVariant(
    source,
    UPDATED_ASAR_SELECTION_ANCHORS,
    "wrapper updated renderer selection anchor",
  );
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
    updatedAsarSelectionAnchor,
    paddedReplacement(
      UPDATED_ASAR_SELECTION_REPLACEMENT,
      updatedAsarSelectionAnchor.length,
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
  profileDirectory: "Blackglass";
  applicationName: typeof APPLICATION_NAME;
  profileMode: typeof WRAPPER_PROFILE_MODE;
  profilePathCanonicalAtSetup: true;
  explicitUserDataDirHonored: true;
  profileHomeEnvironment: typeof BLACKGLASS_HOME_ENVIRONMENT;
  dedicatedHomeValidated: true;
  nativeHomeFallbackPreserved: true;
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
  requireExactlyOnce(main, APPLICATION_NAME_MARKER, "patched application name marker");
  requireExactlyOnce(main, SESSION_MARKER, "patched wrapper session marker");
  requireExactlyOnce(
    main,
    EXPLICIT_PROFILE_MARKER,
    "patched wrapper explicit profile marker",
  );
  requireExactlyOnce(
    main,
    PROFILE_PATH_SAFETY_PRELUDE,
    "patched wrapper dedicated-home safety prelude",
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
    UPDATED_ASAR_SELECTION_ANCHORS.some((anchor) => main.includes(anchor))
  ) {
    throw new Error("Patched wrapper still contains an upstream safety anchor");
  }
  return {
    profileDirectory: "Blackglass",
    applicationName: APPLICATION_NAME,
    profileMode: WRAPPER_PROFILE_MODE,
    profilePathCanonicalAtSetup: true,
    explicitUserDataDirHonored: true,
    profileHomeEnvironment: BLACKGLASS_HOME_ENVIRONMENT,
    dedicatedHomeValidated: true,
    nativeHomeFallbackPreserved: true,
    upstreamUpdatesDisabled: true,
    embeddedRendererOnly: true,
  };
}

function selectExactlyOneVariant<T extends string>(
  source: string,
  variants: readonly T[],
  label: string,
): T {
  const matches = variants.filter((variant) => source.includes(variant));
  if (matches.length !== 1) {
    throw new Error(`${label} must match exactly once (found ${matches.length})`);
  }
  return matches[0]!;
}

function countOccurrences(source: string, needle: string): number {
  return source.split(needle).length - 1;
}

function paddedReplacement(value: string, length: number, label: string): string {
  if (value.length > length) {
    throw new Error(
      `Configured wrapper ${label} replacement is too long (${value.length} > ${length})`,
    );
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
