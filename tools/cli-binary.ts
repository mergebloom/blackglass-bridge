import { createHash } from "node:crypto";

export const UPSTREAM_CLI_SOCKET_NAME = ".obsidian-cli.sock";
export const BLACKGLASS_CLI_SOCKET_NAME = ".blackglass-b.sock";
export const CLI_BINARY_PATCH_FORMAT_VERSION = 1;
export const CLI_BINARY_INCISION_COUNT = 2;

export interface CliBinaryPatchReport {
  patchFormatVersion: typeof CLI_BINARY_PATCH_FORMAT_VERSION;
  incisionCount: typeof CLI_BINARY_INCISION_COUNT;
  socketName: typeof BLACKGLASS_CLI_SOCKET_NAME;
  upstreamSha256: string;
  patchedSha256: string;
}

export function patchCliBinary(
  upstream: Buffer,
): { buffer: Buffer; report: CliBinaryPatchReport } {
  if (UPSTREAM_CLI_SOCKET_NAME.length !== BLACKGLASS_CLI_SOCKET_NAME.length) {
    throw new Error("CLI socket replacement must preserve byte length");
  }
  if (countOccurrences(upstream, Buffer.from(BLACKGLASS_CLI_SOCKET_NAME)) !== 0) {
    throw new Error("Upstream CLI already contains the Blackglass socket name");
  }
  const needle = Buffer.from(UPSTREAM_CLI_SOCKET_NAME);
  const replacement = Buffer.from(BLACKGLASS_CLI_SOCKET_NAME);
  const offsets = occurrenceOffsets(upstream, needle);
  if (offsets.length !== CLI_BINARY_INCISION_COUNT) {
    throw new Error(
      `Upstream CLI socket must occur ${CLI_BINARY_INCISION_COUNT} times, found ${offsets.length}`,
    );
  }
  const output = Buffer.from(upstream);
  for (const offset of offsets) replacement.copy(output, offset);
  inspectPatchedCliBinary(output);
  return {
    buffer: output,
    report: {
      patchFormatVersion: CLI_BINARY_PATCH_FORMAT_VERSION,
      incisionCount: CLI_BINARY_INCISION_COUNT,
      socketName: BLACKGLASS_CLI_SOCKET_NAME,
      upstreamSha256: sha256(upstream),
      patchedSha256: sha256(output),
    },
  };
}

export function inspectPatchedCliBinary(binary: Buffer): {
  socketName: typeof BLACKGLASS_CLI_SOCKET_NAME;
  socketOccurrences: typeof CLI_BINARY_INCISION_COUNT;
  sha256: string;
} {
  const upstreamOccurrences = countOccurrences(
    binary,
    Buffer.from(UPSTREAM_CLI_SOCKET_NAME),
  );
  const blackglassOccurrences = countOccurrences(
    binary,
    Buffer.from(BLACKGLASS_CLI_SOCKET_NAME),
  );
  if (
    upstreamOccurrences !== 0 ||
    blackglassOccurrences !== CLI_BINARY_INCISION_COUNT
  ) {
    throw new Error(
      `Patched CLI socket inventory is invalid: upstream=${upstreamOccurrences}, blackglass=${blackglassOccurrences}`,
    );
  }
  return {
    socketName: BLACKGLASS_CLI_SOCKET_NAME,
    socketOccurrences: CLI_BINARY_INCISION_COUNT,
    sha256: sha256(binary),
  };
}

function occurrenceOffsets(input: Buffer, needle: Buffer): number[] {
  const offsets: number[] = [];
  let offset = 0;
  while (offset <= input.length - needle.length) {
    const found = input.indexOf(needle, offset);
    if (found === -1) break;
    offsets.push(found);
    offset = found + needle.length;
  }
  return offsets;
}

function countOccurrences(input: Buffer, needle: Buffer): number {
  return occurrenceOffsets(input, needle).length;
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
