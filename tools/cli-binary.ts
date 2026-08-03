import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const UPSTREAM_CLI_SOCKET_NAME = ".obsidian-cli.sock";
export const BLACKGLASS_CLI_SOCKET_NAME = ".blackglass-c.sock";
export const CLI_BINARY_PATCH_FORMAT_VERSION = 2;
export const CLI_BINARY_INCISION_COUNT = 2;

export interface CliBinaryPatchReport {
  patchFormatVersion: typeof CLI_BINARY_PATCH_FORMAT_VERSION;
  incisionCount: typeof CLI_BINARY_INCISION_COUNT;
  socketName: typeof BLACKGLASS_CLI_SOCKET_NAME;
  upstreamSha256: string;
  patchedSha256: string;
}

export const BLACKGLASS_CLI_IDENTIFIER = "com.blackglass.cli";

export async function writeSignedPatchedCliBinary(
  upstream: Buffer,
  output: string,
): Promise<{ patchedSha256: string; executableSha256: string }> {
  if (process.platform !== "darwin") {
    throw new Error("The locally adapted CLI can only be signed on macOS");
  }
  const generated = patchCliBinary(upstream);
  await writeFile(output, generated.buffer, { flag: "wx", mode: 0o700 });
  await chmod(output, 0o700);
  const signed = Bun.spawnSync([
    "/usr/bin/codesign",
    "--force",
    "--sign",
    "-",
    "--timestamp=none",
    "--identifier",
    BLACKGLASS_CLI_IDENTIFIER,
    output,
  ], { stdout: "pipe", stderr: "pipe" });
  if (signed.exitCode !== 0) {
    throw new Error(
      `Unable to ad-hoc sign the locally adapted CLI: ${signed.stderr.toString("utf8").trim()}`,
    );
  }
  const verified = Bun.spawnSync(
    ["/usr/bin/codesign", "--verify", "--strict", "--verbose=2", output],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (verified.exitCode !== 0) {
    throw new Error(
      `Locally adapted CLI signature verification failed: ${verified.stderr.toString("utf8").trim()}`,
    );
  }
  const details = Bun.spawnSync(
    ["/usr/bin/codesign", "--display", "--verbose=2", output],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (
    details.exitCode !== 0 ||
    !details.stderr.toString("utf8").split("\n").includes(`Identifier=${BLACKGLASS_CLI_IDENTIFIER}`)
  ) {
    throw new Error("Locally adapted CLI has an unexpected code-signing identifier");
  }
  return {
    patchedSha256: generated.report.patchedSha256,
    executableSha256: sha256(await readFile(output)),
  };
}

export async function signedPatchedCliBinarySha256(upstream: Buffer): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "blackglass-cli-identity-"));
  try {
    const output = join(root, "blackglass-cli");
    return (await writeSignedPatchedCliBinary(upstream, output)).executableSha256;
  } finally {
    await rm(root, { recursive: true, force: false });
  }
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
