import { createHash } from "node:crypto";
import { AsarArchive, replacePackedAsarEntry } from "../../../tools/asar";
import {
  BRIDGE_CLI_SOCKET_NAME,
  UPSTREAM_CLI_SOCKET_NAME,
} from "../../../tools/cli-binary";

const CONTROL_ORIGIN_EXPRESSION =
  '"https://"+[String.fromCharCode(97,112,105),"obsidian","md"].join(".")';
const DATA_HOST_CONDITION =
  '!oee.call(h,".obsidian.md")&&"127.0.0.1"!==h';
export { BRIDGE_CLI_SOCKET_NAME } from "../../../tools/cli-binary";
const UPSTREAM_CLI_REGISTRATION =
  'let g=D.join(u,"obsidian-cli");if(h.existsSync(g)){let w="/usr/local/bin/obsidian";';
const BRIDGE_CLI_REGISTRATION =
  'let g=u+"/obsidian-cli";if(h.existsSync(g)){let w="/usr/local/bin/blackglass";';
export const BRIDGE_CLI_COMMAND_NAME = "blackglass";
export const BRIDGE_CLI_COMMAND_PATH = "/usr/local/bin/blackglass";

export const RENDERER_PATCH_FORMAT_VERSION = 5;
export const RENDERER_INCISION_COUNT = 5;

export interface AdapterOptions {
  controlOrigin: string;
  dataHost: string;
}

export interface AdapterReport {
  patchFormatVersion: typeof RENDERER_PATCH_FORMAT_VERSION;
  incisionCount: typeof RENDERER_INCISION_COUNT;
  controlOrigin: string;
  dataHost: string;
  cliSocketName: typeof BRIDGE_CLI_SOCKET_NAME;
  cliCommandName: typeof BRIDGE_CLI_COMMAND_NAME;
  cliCommandPath: typeof BRIDGE_CLI_COMMAND_PATH;
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
): Buffer {
  const canonical = canonicalAdapterOptions(options);
  const source = renderer.toString("utf8");
  const controlReplacement = paddedExpression(
    JSON.stringify(canonical.controlOrigin),
    CONTROL_ORIGIN_EXPRESSION.length,
    "control origin",
  );
  const data = parseDataHost(canonical.dataHost);
  const dataReplacement = paddedExpression(
    `u.host!==${JSON.stringify(data.host)}`,
    DATA_HOST_CONDITION.length,
    "data host",
  );

  let patched = replaceExactlyOnce(
    source,
    CONTROL_ORIGIN_EXPRESSION,
    controlReplacement,
    "control origin expression",
  );
  patched = replaceExactlyOnce(
    patched,
    DATA_HOST_CONDITION,
    dataReplacement,
    "Sync hostname condition",
  );

  const output = Buffer.from(patched, "utf8");
  if (output.length !== renderer.length) {
    throw new Error("Renderer patch unexpectedly changed the byte length");
  }
  return output;
}

export function patchStarterRenderer(
  starter: Buffer,
  options: AdapterOptions,
): Buffer {
  const canonical = canonicalAdapterOptions(options);
  const source = starter.toString("utf8");
  const controlReplacement = paddedExpression(
    JSON.stringify(canonical.controlOrigin),
    CONTROL_ORIGIN_EXPRESSION.length,
    "starter control origin",
  );
  const patched = replaceExactlyOnce(
    source,
    CONTROL_ORIGIN_EXPRESSION,
    controlReplacement,
    "starter control origin expression",
  );
  const output = Buffer.from(patched, "utf8");
  if (output.length !== starter.length) {
    throw new Error("Starter patch unexpectedly changed the byte length");
  }
  return output;
}

export function patchMainProcess(main: Buffer): Buffer {
  if (UPSTREAM_CLI_SOCKET_NAME.length !== BRIDGE_CLI_SOCKET_NAME.length) {
    throw new Error("CLI socket replacement must preserve byte length");
  }
  const source = main.toString("utf8");
  let patched = replaceExactlyOnce(
    source,
    UPSTREAM_CLI_SOCKET_NAME,
    BRIDGE_CLI_SOCKET_NAME,
    "CLI socket name",
  );
  patched = replaceExactlyOnce(
    patched,
    UPSTREAM_CLI_REGISTRATION,
    paddedSource(
      BRIDGE_CLI_REGISTRATION,
      UPSTREAM_CLI_REGISTRATION.length,
      "CLI registration",
    ),
    "CLI registration target",
  );
  const output = Buffer.from(patched, "utf8");
  if (output.length !== main.length) {
    throw new Error("Main-process patch unexpectedly changed the byte length");
  }
  return output;
}

export function patchAsar(
  upstream: Buffer,
  options: AdapterOptions,
): { buffer: Buffer; report: AdapterReport } {
  const canonical = canonicalAdapterOptions(options);
  const archive = AsarArchive.fromBuffer(upstream);
  const rendererBefore = archive.read("app.js");
  const starterBefore = archive.read("starter.js");
  const mainBefore = archive.read("main.js");
  const rendererAfter = patchRenderer(rendererBefore, canonical);
  const starterAfter = patchStarterRenderer(starterBefore, canonical);
  const mainAfter = patchMainProcess(mainBefore);
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
      cliSocketName: BRIDGE_CLI_SOCKET_NAME,
      cliCommandName: BRIDGE_CLI_COMMAND_NAME,
      cliCommandPath: BRIDGE_CLI_COMMAND_PATH,
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

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
