import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import { basename, resolve } from "node:path";

export interface ServerArtifact {
  schemaVersion: 1;
  name: "blackglass-server";
  version: string;
  binaryPath: string;
  binaryName: string;
  sha256: string;
  bytes: number;
  architecture: string;
}

export async function inspectServerArtifact(binaryArgument: string): Promise<ServerArtifact> {
  const binaryPath = resolve(binaryArgument);
  const file = await lstat(binaryPath);
  if (!file.isFile()) throw new Error(`Server artifact is not a file: ${binaryPath}`);

  const versionOutput = runText([binaryPath, "--version"]);
  const match = /^blackglass-server ([0-9A-Za-z.+_-]+)$/.exec(versionOutput);
  if (!match?.[1]) {
    throw new Error(`Unexpected server version output: ${versionOutput}`);
  }
  const description = runText(["file", "-b", binaryPath]);
  const bytes = Buffer.from(await Bun.file(binaryPath).arrayBuffer());
  return {
    schemaVersion: 1,
    name: "blackglass-server",
    version: match[1],
    binaryPath,
    binaryName: basename(binaryPath),
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: file.size,
    architecture: parseArchitecture(description),
  };
}

export function publicServerArtifact(artifact: ServerArtifact): Omit<ServerArtifact, "binaryPath"> {
  const { binaryPath: _binaryPath, ...published } = artifact;
  return published;
}

export function parseArchitecture(description: string): string {
  const normalized = description.toLowerCase();
  if (normalized.includes("universal binary")) return "universal";
  if (normalized.includes("arm64") || normalized.includes("aarch64")) return "arm64";
  if (normalized.includes("x86_64") || normalized.includes("x86-64")) return "x86_64";
  return "unknown";
}

function runText(arguments_: string[]): string {
  const result = Bun.spawnSync(arguments_, { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    throw new Error(Buffer.from(result.stderr).toString("utf8").trim());
  }
  return Buffer.from(result.stdout).toString("utf8").trim();
}
