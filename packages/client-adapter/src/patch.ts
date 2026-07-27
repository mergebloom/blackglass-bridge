import { createHash } from "node:crypto";
import type { AsarIntegrity } from "../../../tools/asar";
import { AsarArchive } from "../../../tools/asar";

const CONTROL_ORIGIN_EXPRESSION =
  '"https://"+[String.fromCharCode(97,112,105),"obsidian","md"].join(".")';
const DATA_HOST_CONDITION =
  '!oee.call(h,".obsidian.md")&&"127.0.0.1"!==h';

export interface AdapterOptions {
  controlOrigin: string;
  dataHost: string;
}

export interface AdapterReport {
  controlOrigin: string;
  dataHost: string;
  upstreamSha256: string;
  patchedSha256: string;
  rendererBeforeSha256: string;
  rendererAfterSha256: string;
}

export function patchRenderer(
  renderer: Buffer,
  options: AdapterOptions,
): Buffer {
  validateOptions(options);
  const source = renderer.toString("utf8");
  const controlReplacement = paddedExpression(
    JSON.stringify(removeTrailingSlash(options.controlOrigin)),
    CONTROL_ORIGIN_EXPRESSION.length,
    "control origin",
  );
  const dataHostname = parseDataHost(options.dataHost).hostname;
  const dataReplacement = paddedExpression(
    `h!==${JSON.stringify(dataHostname)}`,
    DATA_HOST_CONDITION.length,
    "data hostname",
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

export function patchAsar(
  upstream: Buffer,
  options: AdapterOptions,
): { buffer: Buffer; report: AdapterReport } {
  const archive = AsarArchive.fromBuffer(upstream);
  const rendererBefore = archive.read("app.js");
  const rendererAfter = patchRenderer(rendererBefore, options);
  const rendererNode = archive.get("app.js");
  if (!rendererNode?.integrity) {
    throw new Error("app.js has no ASAR integrity metadata");
  }

  updateIntegrity(rendererNode.integrity, rendererAfter);
  const data = Buffer.from(upstream.subarray(archive.dataOffset));
  const range = archive.contentRange("app.js");
  rendererAfter.copy(data, range.start - archive.dataOffset);
  const header = buildHeader(archive.header);
  const output = Buffer.concat([header, data]);

  // Re-open and verify the generated artifact before returning it.
  const generated = AsarArchive.fromBuffer(output);
  const verifiedRenderer = generated.read("app.js");
  if (!verifiedRenderer.equals(rendererAfter)) {
    throw new Error("Generated ASAR did not preserve the patched renderer");
  }

  return {
    buffer: output,
    report: {
      controlOrigin: removeTrailingSlash(options.controlOrigin),
      dataHost: options.dataHost,
      upstreamSha256: sha256(upstream),
      patchedSha256: sha256(output),
      rendererBeforeSha256: sha256(rendererBefore),
      rendererAfterSha256: sha256(rendererAfter),
    },
  };
}

function validateOptions(options: AdapterOptions): void {
  const control = new URL(options.controlOrigin);
  if (control.username || control.password || control.search || control.hash) {
    throw new Error("Control origin must not contain credentials, query, or hash");
  }
  if (control.pathname !== "/" && control.pathname !== "") {
    throw new Error("Control origin must not contain a path");
  }
  const isLoopback = control.hostname === "127.0.0.1" || control.hostname === "localhost";
  if (control.protocol !== "https:" && !(control.protocol === "http:" && isLoopback)) {
    throw new Error("Control origin must use HTTPS, except on loopback");
  }
  parseDataHost(options.dataHost);
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
  if (!parsed.hostname) {
    throw new Error("Data host must include a hostname");
  }
  return parsed;
}

function removeTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
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

function updateIntegrity(integrity: AsarIntegrity, content: Buffer): void {
  const algorithm = integrity.algorithm.toLowerCase().replaceAll("-", "");
  integrity.hash = createHash(algorithm).update(content).digest("hex");
  if (integrity.blockSize && integrity.blocks) {
    const blocks: string[] = [];
    for (let offset = 0; offset < content.length; offset += integrity.blockSize) {
      blocks.push(
        createHash(algorithm)
          .update(content.subarray(offset, offset + integrity.blockSize))
          .digest("hex"),
      );
    }
    integrity.blocks = blocks;
  }
}

function buildHeader(headerValue: unknown): Buffer {
  const json = Buffer.from(JSON.stringify(headerValue), "utf8");
  const paddedStringLength = align4(json.length);
  const headerPayloadSize = 4 + paddedStringLength;
  const headerPickleSize = 4 + headerPayloadSize;
  const output = Buffer.alloc(8 + headerPickleSize);
  output.writeUInt32LE(4, 0);
  output.writeUInt32LE(headerPickleSize, 4);
  output.writeUInt32LE(headerPayloadSize, 8);
  output.writeUInt32LE(json.length, 12);
  json.copy(output, 16);
  return output;
}

function align4(value: number): number {
  return (value + 3) & ~3;
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
