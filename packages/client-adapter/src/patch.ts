import { createHash } from "node:crypto";
import { AsarArchive, replacePackedAsarEntry } from "../../../tools/asar";
import {
  BLACKGLASS_CLI_SOCKET_NAME,
  UPSTREAM_CLI_SOCKET_NAME,
} from "../../../tools/cli-binary";
import { BLACKGLASS_HOME_ENVIRONMENT } from "./runtime-home";
import type { RendererIncision, RendererReplacement } from "./incision";

export { BLACKGLASS_CLI_SOCKET_NAME } from "../../../tools/cli-binary";
export const BLACKGLASS_CLI_COMMAND_NAME = "blackglass";
export const BLACKGLASS_CLI_COMMAND_PATH = "/usr/local/bin/blackglass";
export const BLACKGLASS_CLI_EXECUTABLE_ENVIRONMENT = "BGCLI" as const;

export const RENDERER_PATCH_FORMAT_VERSION = 9;
export const RENDERER_INCISION_COUNT = 6;

export interface AdapterOptions {
  controlOrigin: string;
  dataHost: string;
}

export interface AdapterReport {
  patchFormatVersion: typeof RENDERER_PATCH_FORMAT_VERSION;
  incisionCount: typeof RENDERER_INCISION_COUNT;
  controlOrigin: string;
  dataHost: string;
  cliSocketName: typeof BLACKGLASS_CLI_SOCKET_NAME;
  cliCommandName: typeof BLACKGLASS_CLI_COMMAND_NAME;
  cliCommandPath: typeof BLACKGLASS_CLI_COMMAND_PATH;
  cliExecutableEnvironment: typeof BLACKGLASS_CLI_EXECUTABLE_ENVIRONMENT;
  runtimeHomeEnvironment: typeof BLACKGLASS_HOME_ENVIRONMENT;
  upstreamSha256: string;
  patchedSha256: string;
  rendererBeforeSha256: string;
  rendererAfterSha256: string;
  starterBeforeSha256: string;
  starterAfterSha256: string;
  mainBeforeSha256: string;
  mainAfterSha256: string;
}

export function patchRenderer(
  renderer: Buffer,
  options: AdapterOptions,
  incisions: readonly RendererIncision[],
): Buffer {
  const canonical = canonicalAdapterOptions(options);
  return applyReviewedIncisions(renderer, incisions, canonical);
}

export function patchStarterRenderer(
  starter: Buffer,
  options: AdapterOptions,
  incisions: readonly RendererIncision[],
): Buffer {
  return applyReviewedIncisions(starter, incisions, canonicalAdapterOptions(options));
}

export function patchMainProcess(
  main: Buffer,
  incisions: readonly RendererIncision[],
): Buffer {
  if (UPSTREAM_CLI_SOCKET_NAME.length !== BLACKGLASS_CLI_SOCKET_NAME.length) {
    throw new Error("CLI socket replacement must preserve byte length");
  }
  return applyReviewedIncisions(main, incisions, undefined);
}

export function inspectPatchedMainProcess(
  main: Buffer,
): {
  cliSocketName: typeof BLACKGLASS_CLI_SOCKET_NAME;
  runtimeHomeEnvironment: typeof BLACKGLASS_HOME_ENVIRONMENT;
  cliCommandName: typeof BLACKGLASS_CLI_COMMAND_NAME;
  cliExecutableEnvironment: typeof BLACKGLASS_CLI_EXECUTABLE_ENVIRONMENT;
  runtimeRootValidated: true;
} {
  const source = main.toString("utf8");
  try {
    new Function(source);
  } catch (error) {
    throw new Error(`Patched renderer main.js is not valid JavaScript: ${String(error)}`);
  }
  requireExactlyOnce(source, BLACKGLASS_CLI_SOCKET_NAME, "patched CLI socket name");
  requireExactlyOnce(source, `process.env.${BLACKGLASS_HOME_ENVIRONMENT}`, "patched CLI runtime root");
  requireExactlyOnce(source, BLACKGLASS_CLI_COMMAND_PATH, "patched CLI registration");
  requireExactlyOnce(source, `process.env.${BLACKGLASS_CLI_EXECUTABLE_ENVIRONMENT}`, "patched CLI executable binding");
  if (
    source.includes(UPSTREAM_CLI_SOCKET_NAME) ||
    source.includes("/usr/local/bin/obsidian")
  ) {
    throw new Error("Patched renderer main.js retains an upstream CLI anchor");
  }
  return {
    cliSocketName: BLACKGLASS_CLI_SOCKET_NAME,
    runtimeHomeEnvironment: BLACKGLASS_HOME_ENVIRONMENT,
    cliCommandName: BLACKGLASS_CLI_COMMAND_NAME,
    cliExecutableEnvironment: BLACKGLASS_CLI_EXECUTABLE_ENVIRONMENT,
    runtimeRootValidated: true,
  };
}

export function patchAsar(
  upstream: Buffer,
  options: AdapterOptions,
  incisions: readonly RendererIncision[],
): { buffer: Buffer; report: AdapterReport } {
  const canonical = canonicalAdapterOptions(options);
  const archive = AsarArchive.fromBuffer(upstream);
  const rendererBefore = archive.read("app.js");
  const starterBefore = archive.read("starter.js");
  const mainBefore = archive.read("main.js");
  const rendererAfter = patchRenderer(
    rendererBefore,
    canonical,
    incisions.filter((incision) => incision.file === "app.js"),
  );
  const starterAfter = patchStarterRenderer(
    starterBefore,
    canonical,
    incisions.filter((incision) => incision.file === "starter.js"),
  );
  const mainAfter = patchMainProcess(
    mainBefore,
    incisions.filter((incision) => incision.file === "main.js"),
  );
  const rendererOutput = replacePackedAsarEntry(upstream, "app.js", rendererAfter);
  const starterOutput = replacePackedAsarEntry(rendererOutput, "starter.js", starterAfter);
  const output = replacePackedAsarEntry(starterOutput, "main.js", mainAfter);

  // Re-open and verify the generated artifact before returning it.
  const generated = AsarArchive.fromBuffer(output);
  const verifiedRenderer = generated.read("app.js");
  const verifiedStarter = generated.read("starter.js");
  const verifiedMain = generated.read("main.js");
  if (
    !verifiedRenderer.equals(rendererAfter) ||
    !verifiedStarter.equals(starterAfter) ||
    !verifiedMain.equals(mainAfter)
  ) {
    throw new Error("Generated ASAR did not preserve all patched entries");
  }

  return {
    buffer: output,
    report: {
      patchFormatVersion: RENDERER_PATCH_FORMAT_VERSION,
      incisionCount: RENDERER_INCISION_COUNT,
      controlOrigin: canonical.controlOrigin,
      dataHost: canonical.dataHost,
      cliSocketName: BLACKGLASS_CLI_SOCKET_NAME,
      cliCommandName: BLACKGLASS_CLI_COMMAND_NAME,
      cliCommandPath: BLACKGLASS_CLI_COMMAND_PATH,
      cliExecutableEnvironment: BLACKGLASS_CLI_EXECUTABLE_ENVIRONMENT,
      runtimeHomeEnvironment: BLACKGLASS_HOME_ENVIRONMENT,
      upstreamSha256: sha256(upstream),
      patchedSha256: sha256(output),
      rendererBeforeSha256: sha256(rendererBefore),
      rendererAfterSha256: sha256(rendererAfter),
      starterBeforeSha256: sha256(starterBefore),
      starterAfterSha256: sha256(starterAfter),
      mainBeforeSha256: sha256(mainBefore),
      mainAfterSha256: sha256(mainAfter),
    },
  };
}

function applyReviewedIncisions(
  source: Buffer,
  incisions: readonly RendererIncision[],
  options: AdapterOptions | undefined,
): Buffer {
  if (incisions.length === 0) throw new Error("Reviewed incision plan is empty");
  const output = Buffer.from(source);
  const ranges = [...incisions].sort((left, right) => left.offset - right.offset);
  let previousEnd = 0;
  for (const incision of ranges) {
    if (
      !Number.isSafeInteger(incision.offset) ||
      !Number.isSafeInteger(incision.length) ||
      incision.offset < previousEnd ||
      incision.length < 1 ||
      incision.offset + incision.length > source.length ||
      !/^[a-f0-9]{64}$/u.test(incision.sha256)
    ) {
      throw new Error(`Invalid or overlapping reviewed incision: ${incision.id}`);
    }
    const original = source.subarray(incision.offset, incision.offset + incision.length);
    if (sha256(original) !== incision.sha256) {
      throw new Error(`Reviewed incision hash mismatch: ${incision.id}`);
    }
    const replacement = rendererReplacement(incision.replacement, original, incision.length, options);
    replacement.copy(output, incision.offset);
    previousEnd = incision.offset + incision.length;
  }
  if (output.length !== source.length) throw new Error("Incision changed source byte length");
  return output;
}

function rendererReplacement(
  kind: RendererReplacement,
  original: Buffer,
  length: number,
  options: AdapterOptions | undefined,
): Buffer {
  let replacement: string;
  if (kind === "control-origin") {
    if (!options) throw new Error("Control-origin incision requires endpoint options");
    replacement = JSON.stringify(options.controlOrigin);
  } else if (kind === "data-host-guard") {
    if (!options) throw new Error("Data-host incision requires endpoint options");
    replacement = `u.host!==${JSON.stringify(parseDataHost(options.dataHost).host)}`;
  } else if (kind === "cli-socket") {
    replacement = BLACKGLASS_CLI_SOCKET_NAME;
  } else if (kind === "cli-runtime-home") {
    const source = original.toString("utf8");
    const matches = [...source.matchAll(/([A-Za-z_$][\w$]*)\.homedir\(\)/gu)];
    if (matches.length !== 1) throw new Error("Reviewed CLI runtime incision has an unknown shape");
    replacement = `process.env.${BLACKGLASS_HOME_ENVIRONMENT}||${matches[0]![1]}.homedir()`;
  } else if (kind === "cli-registration") {
    const source = original.toString("utf8");
    const match = /^let ([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\.join\(([A-Za-z_$][\w$]*),"obsidian-cli"\);if\(([A-Za-z_$][\w$]*)\.existsSync\(\1\)\)\{let ([A-Za-z_$][\w$]*)="\/usr\/local\/bin\/obsidian";$/u.exec(source);
    if (!match) throw new Error("Reviewed CLI registration incision has an unknown shape");
    replacement = `let ${match[1]}=process.env.${BLACKGLASS_CLI_EXECUTABLE_ENVIRONMENT};if(${match[4]}.existsSync(${match[1]})){let ${match[5]}="${BLACKGLASS_CLI_COMMAND_PATH}";`;
  } else {
    throw new Error(`Unknown renderer incision replacement: ${kind satisfies never}`);
  }
  return Buffer.from(paddedSource(replacement, length, kind), "utf8");
}

export function canonicalAdapterOptions(options: AdapterOptions): AdapterOptions {
  if (
    options.controlOrigin.trim() !== options.controlOrigin ||
    options.dataHost.trim() !== options.dataHost
  ) {
    throw new Error("Endpoint values must not contain surrounding whitespace");
  }

  let control: URL;
  try {
    control = new URL(options.controlOrigin);
  } catch {
    throw new Error("Control origin is not a valid absolute URL");
  }
  if (control.username || control.password || control.search || control.hash) {
    throw new Error("Control origin must not contain credentials, query, or hash");
  }
  if (control.pathname !== "/" && control.pathname !== "") {
    throw new Error("Control origin must not contain a path");
  }
  if (control.hostname.endsWith(".")) {
    throw new Error("Control origin hostname must not have a trailing dot");
  }
  if (control.port === "0") {
    throw new Error("Control origin port must be between 1 and 65535");
  }
  validateNetworkHostname(control.hostname, "Control origin");
  const isLoopback =
    control.hostname === "127.0.0.1" ||
    control.hostname === "localhost" ||
    control.hostname === "[::1]";
  if (control.protocol !== "https:" && !(control.protocol === "http:" && isLoopback)) {
    throw new Error("Control origin must use HTTPS, except on loopback");
  }
  if (control.origin !== options.controlOrigin) {
    throw new Error(`Control origin is not canonical; use ${control.origin}`);
  }

  const data = parseDataHost(options.dataHost);
  if (data.hostname.endsWith(".")) {
    throw new Error("Data hostname must not have a trailing dot");
  }
  if (data.port === "0") {
    throw new Error("Data host port must be between 1 and 65535");
  }
  const deceptiveInsecurePrefix =
    (data.hostname.startsWith("localhost") && data.hostname !== "localhost") ||
    (data.hostname.startsWith("127.0.0.1") && data.hostname !== "127.0.0.1");
  const unsupportedLoopback =
    data.hostname === "[::1]" ||
    (/^127(?:\.\d{1,3}){3}$/u.test(data.hostname) &&
      data.hostname !== "127.0.0.1");
  if (deceptiveInsecurePrefix || unsupportedLoopback) {
    throw new Error(
      "Data hostname must match the renderer's exact plaintext loopback rules",
    );
  }
  if (data.host !== options.dataHost) {
    throw new Error(`Data host is not canonical; use ${data.host}`);
  }

  return { controlOrigin: control.origin, dataHost: data.host };
}

function parseDataHost(host: string): URL {
  if (
    host.includes("/") ||
    host.includes("@") ||
    host.startsWith("ws:") ||
    host.startsWith("wss:")
  ) {
    throw new Error("Data host must be a hostname with an optional port");
  }
  const parsed = new URL(`wss://${host}`);
  if (
    !parsed.hostname ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    parsed.pathname !== "/"
  ) {
    throw new Error("Data host must include a hostname");
  }
  validateDataHostname(parsed.hostname, parsed.port);
  return parsed;
}

function validateDataHostname(hostname: string, port: string): void {
  validateNetworkHostname(hostname, "Data host");

  if (hostname.startsWith("[") && hostname.endsWith("]")) {
    const address = hostname.slice(1, -1);
    if (address === "::1") {
      throw new Error("Data host must not use an unusable IPv6 address");
    }
    return;
  }

  const ipv4Parts = hostname.split(".");
  if (
    ipv4Parts.length === 4 &&
    ipv4Parts.every((part) => /^\d+$/u.test(part))
  ) {
    const octets = ipv4Parts.map(Number);
    const first = octets[0]!;
    if (first === 127 && (hostname !== "127.0.0.1" || !port)) {
      throw new Error("Data host must not use an unusable IPv4 address");
    }
    return;
  }

  if (
    (hostname === "localhost" && !port) ||
    (hostname.startsWith("localhost") && hostname !== "localhost") ||
    (hostname.startsWith("127.0.0.1") && hostname !== "127.0.0.1")
  ) {
    throw new Error("Data host must be a canonical hostname with valid DNS labels");
  }
}

function validateNetworkHostname(hostname: string, label: string): void {
  if (hostname.startsWith("[") && hostname.endsWith("]")) {
    const address = hostname.slice(1, -1).toLowerCase();
    if (address === "::" || address.startsWith("ff")) {
      throw new Error(`${label} must not use an unusable IPv6 address`);
    }
    return;
  }

  const ipv4Parts = hostname.split(".");
  if (
    ipv4Parts.length === 4 &&
    ipv4Parts.every((part) => /^\d+$/u.test(part))
  ) {
    const octets = ipv4Parts.map(Number);
    const first = octets[0]!;
    if (
      octets.some((octet) => octet < 0 || octet > 255) ||
      hostname === "0.0.0.0" ||
      hostname === "255.255.255.255" ||
      (first >= 224 && first <= 239)
    ) {
      throw new Error(`${label} must not use an unusable IPv4 address`);
    }
    return;
  }

  if (/^[\d.]+$/u.test(hostname)) {
    throw new Error(`${label} contains an invalid IPv4 address`);
  }
  if (
    hostname.length > 253 ||
    !hostname.split(".").every(
      (part) =>
        part.length > 0 &&
        part.length <= 63 &&
        /^[a-z0-9-]+$/u.test(part) &&
        !part.startsWith("-") &&
        !part.endsWith("-"),
    )
  ) {
    throw new Error(`${label} must be a canonical hostname with valid DNS labels`);
  }
}

function paddedExpression(
  expression: string,
  targetLength: number,
  label: string,
): string {
  if (expression.length > targetLength) {
    throw new Error(
      `Configured ${label} is too long for the deterministic 1.12.7 incision`,
    );
  }
  return expression.padEnd(targetLength, " ");
}

function paddedSource(replacement: string, targetLength: number, label: string): string {
  if (replacement.length > targetLength) {
    throw new Error(`${label} does not fit the fixed-length incision`);
  }
  return `${replacement}${" ".repeat(targetLength - replacement.length)}`;
}

function replaceExactlyOnce(
  input: string,
  needle: string,
  replacement: string,
  label: string,
): string {
  const first = input.indexOf(needle);
  if (first === -1 || input.indexOf(needle, first + needle.length) !== -1) {
    throw new Error(`${label} must match exactly once`);
  }
  return input.slice(0, first) + replacement + input.slice(first + needle.length);
}

function requireExactlyOnce(input: string, needle: string, label: string): void {
  const first = input.indexOf(needle);
  if (first === -1 || input.indexOf(needle, first + needle.length) !== -1) {
    throw new Error(`${label} must appear exactly once`);
  }
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
