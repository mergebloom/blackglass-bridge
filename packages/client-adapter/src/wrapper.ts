import { createHash } from "node:crypto";
import {
  AsarArchive,
  asarHeaderSha256,
  replacePackedAsarEntry,
} from "../../../tools/asar";
import { BLACKGLASS_HOME_ENVIRONMENT } from "./runtime-home";
import type {
  RendererRuntimeContract,
  WrapperIncision,
  WrapperReplacement,
} from "./incision";

export const WRAPPER_PATCH_FORMAT_VERSION = 6;
export const WRAPPER_INCISION_COUNT = 3;
export const WRAPPER_PROFILE_MODE = 0o700;

const APPLICATION_NAME = "Blackglass" as const;
const APPLICATION_NAME_MARKER = `app.setName('${APPLICATION_NAME}');`;
const PROFILE_PATH_SAFETY_PRELUDE = `${APPLICATION_NAME_MARKER}
let B=process.env.${BLACKGLASS_HOME_ENVIRONMENT},S=B&&fs.statSync(B);
if(B&&(B[0]!=='/'||fs.realpathSync(B)!==B||!S.isDirectory()||(S.mode&511)!==448||S.uid!==process.getuid()))throw Error('Unsafe home');
let H=B||process.env.HOME,P=app.commandLine.getSwitchValue('user-data-dir'),dataPath=path.resolve(P||H?.[0]==='/'&&H+'/Library/Application Support/Blackglass');`;
const PROFILE_PATH_REPLACEMENT = `${PROFILE_PATH_SAFETY_PRELUDE}
let O=path.resolve(process.env.HOME+'/Library/Application Support/obsidian');if(dataPath===O||dataPath.startsWith(O+path.sep))throw Error('Unsafe profile');
fs.mkdirSync(dataPath,{recursive:true,mode:448});
if(fs.realpathSync(dataPath)!==dataPath)throw Error('Unsafe path');
fs.chmodSync(dataPath,448);
app.setPath('userData',dataPath);
app.setPath('sessionData',dataPath);
let currentBaseVersion=app.getVersion(),currentPackageVersion=currentBaseVersion;
function logger(l){let f=fs.openSync(l,'a'),n=(...a)=>{try{fs.writeSync(f,util.format(...a)+os.EOL)}catch{}};n.end=()=>fs.closeSync(f);return n}`;

const UPDATER_QUEUE_REPLACEMENT = "let queueUpdate=()=>{};";
const UPDATED_ASAR_SELECTION_REPLACEMENT = "if(false){}";
const PROFILE_MARKER = "app.setPath('userData',dataPath);";
const SESSION_MARKER = "app.setPath('sessionData',dataPath);";
const EXPLICIT_PROFILE_MARKER =
  "app.commandLine.getSwitchValue('user-data-dir')";
const PROFILE_MODE_MARKER = "fs.chmodSync(dataPath,448);";
const PROFILE_CANONICAL_MARKER = "fs.realpathSync(dataPath)!==dataPath";
const UPDATER_DISABLED_MARKER = UPDATER_QUEUE_REPLACEMENT;
const EMBEDDED_RENDERER_MARKER = UPDATED_ASAR_SELECTION_REPLACEMENT;

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
  incisions: readonly WrapperIncision[],
): { buffer: Buffer; report: WrapperPatchReport } {
  const archive = AsarArchive.fromBuffer(upstream);
  const mainBefore = archive.read("main.js");
  const mainAfter = patchMacOSWrapperMain(mainBefore, incisions);
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
  contract: RendererRuntimeContract,
): {
  wrapperRendererArguments: 2;
  rendererDevModeArgument: 3 | null;
  packagedDevelopmentMode: false;
} {
  AsarArchive.fromBuffer(rendererAsar).read("main.js");
  inspectPatchedMacOSWrapperAsar(wrapperAsar);
  return {
    wrapperRendererArguments: 2,
    rendererDevModeArgument: contract.rendererDevModeArgument,
    packagedDevelopmentMode: false,
  };
}

export function patchMacOSWrapperMain(
  main: Buffer,
  incisions: readonly WrapperIncision[],
): Buffer {
  if (incisions.length !== WRAPPER_INCISION_COUNT) {
    throw new Error(`Expected ${WRAPPER_INCISION_COUNT} reviewed wrapper incisions`);
  }
  const output = Buffer.from(main);
  const ranges = [...incisions].sort((left, right) => left.offset - right.offset);
  let previousEnd = 0;
  for (const incision of ranges) {
    if (
      incision.file !== "main.js" ||
      !Number.isSafeInteger(incision.offset) ||
      !Number.isSafeInteger(incision.length) ||
      incision.offset < previousEnd ||
      incision.length < 1 ||
      incision.offset + incision.length > main.length ||
      !/^[a-f0-9]{64}$/u.test(incision.sha256)
    ) {
      throw new Error(`Invalid or overlapping wrapper incision: ${incision.id}`);
    }
    const original = main.subarray(incision.offset, incision.offset + incision.length);
    if (sha256(original) !== incision.sha256) {
      throw new Error(`Reviewed wrapper incision hash mismatch: ${incision.id}`);
    }
    Buffer.from(wrapperReplacement(incision.replacement, incision.length), "utf8")
      .copy(output, incision.offset);
    previousEnd = incision.offset + incision.length;
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
  if (main.indexOf(APPLICATION_NAME_MARKER) > main.indexOf(PROFILE_MARKER)) {
    throw new Error("Blackglass application name must be set before profile initialization");
  }
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

function wrapperReplacement(kind: WrapperReplacement, length: number): string {
  const replacement = kind === "profile-bootstrap"
    ? PROFILE_PATH_REPLACEMENT
    : kind === "disable-updater"
      ? UPDATER_QUEUE_REPLACEMENT
      : kind === "embedded-renderer-only"
        ? UPDATED_ASAR_SELECTION_REPLACEMENT
        : (() => { throw new Error(`Unknown wrapper incision: ${kind satisfies never}`); })();
  return paddedReplacement(replacement, length, kind);
}

function paddedReplacement(value: string, length: number, label: string): string {
  if (value.length > length) {
    throw new Error(
      `Configured wrapper ${label} replacement is too long (${value.length} > ${length})`,
    );
  }
  return value.padEnd(length, " ");
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
