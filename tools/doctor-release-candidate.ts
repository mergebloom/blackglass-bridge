import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseStrictFlags } from "./cli-flags";
import { assertMacOSLaunchPreflight } from "./macos-launch-smoke";
import { inspectMacOSLaunchPreflight } from "./macos-preflight";
import {
  assertPathWithin,
  canonicalExistingPath,
  pathExists,
} from "./path-safety";
import {
  assertReleaseCandidateMatchesCheckouts,
  parseReleaseCandidate,
  releaseCandidateSha256,
} from "./release-candidate";

const [candidateArgument, ...flags] = Bun.argv.slice(2);
const parsed = parseStrictFlags(flags, {
  valueFlags: ["--server-repo", "--app"],
  booleanFlags: ["--require-gui", "--require-stable-signing"],
});
const serverArgument = parsed.values.get("--server-repo");
if (!candidateArgument || !serverArgument) usage();

const clientRoot = resolve(import.meta.dir, "..");
const candidatesRoot = await canonicalExistingPath(
  resolve(clientRoot, ".data/release-candidates"),
  "release candidates root",
  "directory",
);
const candidatePath = await canonicalExistingPath(
  candidateArgument,
  "release candidate",
  "file",
);
assertPathWithin(candidatePath, candidatesRoot, "release candidate");
const serverRoot = await canonicalExistingPath(serverArgument, "server repository", "directory");
const candidate = parseReleaseCandidate(await readFile(candidatePath));
await assertReleaseCandidateMatchesCheckouts({ candidate, clientRoot, serverRoot });

const requiredCommands = ["bun", "cargo", "git", "jq", "docker"];
const commands = Object.fromEntries(
  requiredCommands.map((command) => [command, Bun.which(command)]),
);
for (const [command, path] of Object.entries(commands)) {
  if (!path) throw new Error(`Release candidate doctor requires ${command}`);
}

const releaseOutputs = await inspectServerReleaseOutputs(serverRoot, candidate);
const nativeBinary = join(serverRoot, "apps/server-rust/target/release/blackglass-server");
let nativeServer: "missing" | "exact" | "stale" = "missing";
if (await pathExists(nativeBinary)) {
  const info = Bun.spawnSync([nativeBinary, "build-info"], { stdout: "pipe", stderr: "pipe" });
  if (info.exitCode === 0) {
    const value = JSON.parse(info.stdout.toString("utf8")) as Record<string, unknown>;
    nativeServer =
      value.name === "blackglass-server" &&
        value.version === candidate.server.version &&
        value.sourceRevision === candidate.server.revision
        ? "exact"
        : "stale";
  } else {
    nativeServer = "stale";
  }
}

const signing = inspectSigningIdentities();
if (parsed.booleans.has("--require-stable-signing") && !signing.stableIdentityAvailable) {
  throw new Error(
    "No stable macOS code-signing identity is available; ad-hoc signatures can trigger repeated Keychain approval",
  );
}

let gui: { checked: false } | {
  checked: true;
  unlocked: true;
  ports: number[];
  stableSigningIdentityAvailable: boolean;
} = { checked: false };
if (parsed.booleans.has("--require-gui")) {
  const expectedApp = parsed.values.has("--app")
    ? await canonicalExistingPath(parsed.values.get("--app")!, "Blackglass app", "directory")
    : "/private/tmp/blackglass-release-doctor/Blackglass Bridge.app";
  const snapshot = await inspectMacOSLaunchPreflight();
  assertMacOSLaunchPreflight(snapshot, expectedApp);
  const ports = [3000, 3003, 8443, 9320, 9321, 9322, 9323];
  for (const port of ports) assertPortUnused(port);
  gui = {
    checked: true,
    unlocked: true,
    ports,
    stableSigningIdentityAvailable: signing.stableIdentityAvailable,
  };
}

console.log(JSON.stringify({
  passed: true,
  candidateSha256: releaseCandidateSha256(candidate),
  clientRevision: candidate.client.revision,
  serverRevision: candidate.server.revision,
  commands,
  nativeServer,
  releaseOutputs,
  signing,
  gui,
}, null, 2));

async function inspectServerReleaseOutputs(
  serverRoot: string,
  candidate: ReturnType<typeof parseReleaseCandidate>,
): Promise<Record<string, "missing" | "exact">> {
  const states: Record<string, "missing" | "exact"> = {};
  for (const target of ["linux-amd64", "linux-arm64"] as const) {
    const prefix = join(
      serverRoot,
      "artifacts/releases",
      `blackglass-server-v${candidate.server.version}-${target}`,
    );
    const paths = [prefix, `${prefix}.sha256`, `${prefix}.tar.gz`, `${prefix}.tar.gz.sha256`];
    const present = (await Promise.all(paths.map(pathExists))).filter(Boolean).length;
    if (present === 0) {
      states[target] = "missing";
      continue;
    }
    if (present !== paths.length) {
      throw new Error(`Partial existing ${target} release artifact set`);
    }
    const verified = Bun.spawnSync([
      join(serverRoot, "ops/verify-linux-release.sh"),
      target,
      `${prefix}.tar.gz`,
      prefix,
      candidate.server.revision,
    ], { cwd: serverRoot, stdout: "pipe", stderr: "pipe" });
    if (verified.exitCode !== 0) {
      throw new Error(
        `Existing ${target} release artifacts do not match the candidate: ` +
          verified.stderr.toString("utf8").trim(),
      );
    }
    states[target] = "exact";
  }
  return states;
}

function inspectSigningIdentities(): {
  stableIdentityAvailable: boolean;
  validIdentityCount: number;
} {
  if (process.platform !== "darwin") {
    return { stableIdentityAvailable: false, validIdentityCount: 0 };
  }
  const result = Bun.spawnSync(
    ["/usr/bin/security", "find-identity", "-v", "-p", "codesigning"],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (result.exitCode !== 0) throw new Error("Unable to inspect macOS signing identities");
  const match = result.stdout.toString("utf8").match(/(\d+) valid identities found/u);
  const validIdentityCount = match ? Number(match[1]) : 0;
  return { stableIdentityAvailable: validIdentityCount > 0, validIdentityCount };
}

function assertPortUnused(port: number): void {
  const result = Bun.spawnSync(
    ["/usr/sbin/lsof", "-nP", `-iTCP:${port}`, "-sTCP:LISTEN"],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (result.exitCode === 0 && result.stdout.length > 0) {
    throw new Error(`Required E2E port ${port} is already in use`);
  }
  if (result.exitCode !== 0 && result.exitCode !== 1) {
    throw new Error(`Unable to inspect required E2E port ${port}`);
  }
}

function usage(): never {
  console.error(
    "Usage: bun run tools/doctor-release-candidate.ts <candidate.json> " +
      "--server-repo <blackglass-server> [--app <Blackglass Bridge.app>] " +
      "[--require-gui] [--require-stable-signing]",
  );
  process.exit(2);
}
