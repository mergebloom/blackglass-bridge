import { createHash } from "node:crypto";
import { AsarArchive, replacePackedAsarEntry } from "../../../tools/asar";
import { BLACKGLASS_CLI_EXECUTABLE_ENVIRONMENT } from "./patch";

export const LINUX_RENDERER_PATCH_FORMAT_VERSION = 1;
export const LINUX_CLI_REGISTRATION_INCISION = {
  id: "desktop-cli-linux-registration",
  file: "main.js",
  offset: 194_419,
  length: 92,
  sha256: "63d8c1a8a79f02dadc731ec0aa79ae81b0d3b6d0e82273240c26c110cfe8fadc",
} as const;
export const LINUX_CLI_COMMAND_PATH = "~/.local/bin/blackglass" as const;

interface LinuxRegistrationIncision {
  offset: number;
  length: number;
  sha256: string;
}

export interface LinuxRendererPatchReport {
  patchFormatVersion: typeof LINUX_RENDERER_PATCH_FORMAT_VERSION;
  incision: typeof LINUX_CLI_REGISTRATION_INCISION;
  cliCommandPath: typeof LINUX_CLI_COMMAND_PATH;
  cliExecutableEnvironment: typeof BLACKGLASS_CLI_EXECUTABLE_ENVIRONMENT;
  beforeSha256: string;
  afterSha256: string;
  mainBeforeSha256: string;
  mainAfterSha256: string;
}

export function patchLinuxMainProcess(main: Buffer): Buffer {
  return patchReviewedLinuxRegistration(main, LINUX_CLI_REGISTRATION_INCISION);
}

export function patchReviewedLinuxRegistration(
  main: Buffer,
  incision: LinuxRegistrationIncision,
): Buffer {
  const original = main.subarray(incision.offset, incision.offset + incision.length);
  if (sha256(original) !== incision.sha256) {
    throw new Error("Reviewed Linux CLI registration incision changed");
  }
  const match = /^let ([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\.join\(([A-Za-z_$][\w$]*),"obsidian-cli"\),([A-Za-z_$][\w$]*)=\2\.join\(([A-Za-z_$][\w$]*)\.homedir\(\),"\.local","bin"\),([A-Za-z_$][\w$]*)=\2\.join\(\4,"obsidian"\);$/u
    .exec(original.toString("utf8"));
  if (!match) throw new Error("Reviewed Linux CLI registration shape changed");
  const replacement = `let ${match[1]}=process.env.${BLACKGLASS_CLI_EXECUTABLE_ENVIRONMENT},${match[4]}=${match[2]}.join(${match[5]}.homedir(),".local","bin"),${match[6]}=${match[2]}.join(${match[4]},"blackglass");`;
  if (Buffer.byteLength(replacement, "utf8") > incision.length) {
    throw new Error("Linux CLI registration replacement exceeds its reviewed incision");
  }
  const output = Buffer.from(main);
  Buffer.from(replacement.padEnd(incision.length, " "), "utf8")
    .copy(output, incision.offset);
  inspectPatchedLinuxMainProcess(output, incision);
  return output;
}

export function inspectPatchedLinuxMainProcess(
  main: Buffer,
  incision: LinuxRegistrationIncision = LINUX_CLI_REGISTRATION_INCISION,
): void {
  const source = main.toString("utf8");
  try { new Function(source); }
  catch (error) {
    throw new Error(`Linux-patched renderer main.js is invalid: ${String(error)}`);
  }
  const registration = main.subarray(incision.offset, incision.offset + incision.length)
    .toString("utf8").trimEnd();
  if (
    !/^let [A-Za-z_$][\w$]*=process\.env\.BGCLI,[A-Za-z_$][\w$]*=[A-Za-z_$][\w$]*\.join\([A-Za-z_$][\w$]*\.homedir\(\),"\.local","bin"\),[A-Za-z_$][\w$]*=[A-Za-z_$][\w$]*\.join\([A-Za-z_$][\w$]*,"blackglass"\);$/u.test(registration) ||
    registration.includes("obsidian")
  ) throw new Error("Linux CLI registration is not isolated to Blackglass");
}

export function patchLinuxRendererAsar(
  upstream: Buffer,
): { buffer: Buffer; report: LinuxRendererPatchReport } {
  const archive = AsarArchive.fromBuffer(upstream);
  const mainBefore = archive.read("main.js");
  const mainAfter = patchLinuxMainProcess(mainBefore);
  const output = replacePackedAsarEntry(upstream, "main.js", mainAfter);
  inspectPatchedLinuxMainProcess(AsarArchive.fromBuffer(output).read("main.js"));
  return {
    buffer: output,
    report: {
      patchFormatVersion: LINUX_RENDERER_PATCH_FORMAT_VERSION,
      incision: LINUX_CLI_REGISTRATION_INCISION,
      cliCommandPath: LINUX_CLI_COMMAND_PATH,
      cliExecutableEnvironment: BLACKGLASS_CLI_EXECUTABLE_ENVIRONMENT,
      beforeSha256: sha256(upstream),
      afterSha256: sha256(output),
      mainBeforeSha256: sha256(mainBefore),
      mainAfterSha256: sha256(mainAfter),
    },
  };
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
