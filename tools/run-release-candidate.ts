import { createHash } from "node:crypto";
import { readFileSync, unlinkSync } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { parseStrictFlags } from "./cli-flags";
import {
  assertPathWithin,
  canonicalExistingPath,
  canonicalOutputPath,
  pathExists,
} from "./path-safety";
import {
  assertReleaseCandidateMatchesCheckouts,
  parseReleaseCandidate,
  releaseCandidateSha256,
} from "./release-candidate";

const PIPELINE_STATE_SCHEMA_VERSION = 2;

interface PipelineState {
  schemaVersion: typeof PIPELINE_STATE_SCHEMA_VERSION;
  candidateSha256: string;
  completed: Array<{ stage: string; key: string; completedAt: string }>;
}

interface Stage {
  name: string;
  command: string[];
  cwd: string;
  outputs?: string[];
  environment?: Record<string, string>;
  revalidateOnResume?: boolean;
  resumeKey?: string;
}

const [candidateArgument, ...flagArguments] = Bun.argv.slice(2);
const parsed = parseStrictFlags(flagArguments, {
  valueFlags: [
    "--server-repo",
    "--renderer",
    "--official-app",
    "--official-dmg",
    "--run",
  ],
  booleanFlags: [
    "--prepare-client",
    "--full-checks",
    "--linux",
    "--require-gui",
    "--require-stable-signing",
  ],
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
const candidateSha256 = releaseCandidateSha256(candidate);

const workRoot = resolve(clientRoot, ".data/release-work", candidateSha256);
await mkdir(workRoot, { recursive: true, mode: 0o700 });
const lockPath = join(workRoot, "pipeline.lock");
const lockBytes = `${JSON.stringify({
  schemaVersion: 1,
  candidateSha256,
  pid: process.pid,
  startedAt: new Date().toISOString(),
})}\n`;
try {
  await writeFile(lockPath, lockBytes, { flag: "wx", mode: 0o600 });
} catch (error) {
  if ((error as NodeJS.ErrnoException).code === "EEXIST") {
    throw new Error(
      `Another release runner owns ${lockPath}; inspect that process before removing a stale lock`,
    );
  }
  throw error;
}
let lockOwned = true;
const releasePipelineLock = (): void => {
  if (!lockOwned) return;
  if (readFileSync(lockPath, "utf8") !== lockBytes) {
    throw new Error("Refusing to remove a changed release pipeline lock");
  }
  unlinkSync(lockPath);
  lockOwned = false;
};
process.on("exit", releasePipelineLock);
const statePath = join(workRoot, "pipeline-state.json");
const state = await readState(statePath, candidateSha256);

// The doctor is deliberately never cached. Every resume revalidates both clean
// checkouts, existing release outputs, tools, signing state, and (when asked)
// the live desktop before any expensive stage starts.
const doctorCommand = [
  Bun.which("bun") ?? "bun",
  "run",
  "tools/doctor-release-candidate.ts",
  candidatePath,
  "--server-repo",
  serverRoot,
];
if (parsed.booleans.has("--require-stable-signing")) {
  doctorCommand.push("--require-stable-signing");
}
await run({ name: "doctor", command: doctorCommand, cwd: clientRoot });

const stages: Stage[] = [
  {
    name: "client-fast-checks",
    command: [Bun.which("bun") ?? "bun", "run", "check:fast"],
    cwd: clientRoot,
  },
  {
    name: "server-fast-checks",
    command: [Bun.which("bun") ?? "bun", "run", "check:fast"],
    cwd: serverRoot,
  },
];
if (parsed.booleans.has("--full-checks")) {
  stages.push(
    {
      name: "client-full-checks",
      command: [Bun.which("bun") ?? "bun", "run", "check:full"],
      cwd: clientRoot,
    },
    {
      name: "server-full-checks",
      command: [Bun.which("bun") ?? "bun", "run", "check:full"],
      cwd: serverRoot,
    },
  );
}
stages.push({
  name: "server-native-release",
  command: [join(serverRoot, "ops/build-release.sh")],
  cwd: serverRoot,
  outputs: [join(serverRoot, "apps/server-rust/target/release/blackglass-server")],
  environment: { BLACKGLASS_TESTED_SOURCE_REVISION: candidate.server.revision },
  revalidateOnResume: true,
});
if (parsed.booleans.has("--linux")) {
  for (const target of ["linux-amd64", "linux-arm64"] as const) {
    const prefix = join(
      serverRoot,
      "artifacts/releases",
      `blackglass-server-v${candidate.server.version}-${target}`,
    );
    stages.push({
      name: `server-${target}-release`,
      command: [join(serverRoot, "ops/build-linux-release.sh"), target],
      cwd: serverRoot,
      outputs: [prefix, `${prefix}.sha256`, `${prefix}.tar.gz`, `${prefix}.tar.gz.sha256`],
      environment: { BLACKGLASS_TESTED_SOURCE_REVISION: candidate.server.revision },
      revalidateOnResume: true,
    });
  }
}

let packagedApp: string | undefined;
if (parsed.booleans.has("--prepare-client")) {
  const rendererVersion = requiredValue("--renderer");
  const officialApp = await canonicalExistingPath(
    requiredValue("--official-app"),
    "official Obsidian app",
    "directory",
  );
  const officialDmg = await canonicalExistingPath(
    requiredValue("--official-dmg"),
    "official Obsidian DMG",
    "file",
  );
  const runArgument = requiredValue("--run");
  const renderer = candidate.renderers.find((entry) => entry.version === rendererVersion);
  if (!renderer) throw new Error(`Renderer ${rendererVersion} is not in this release candidate`);
  const actualDmgSha256 = await sha256File(officialDmg);
  if (actualDmgSha256 !== renderer.officialDmgSha256) {
    throw new Error("Official DMG does not match the immutable release candidate");
  }

  const rendererRoot = join(workRoot, `obsidian-${rendererVersion}`);
  const firstRoot = join(rendererRoot, "package-a");
  const secondRoot = join(rendererRoot, "package-b");
  await mkdir(firstRoot, { recursive: true, mode: 0o700 });
  await mkdir(secondRoot, { recursive: true, mode: 0o700 });
  const baseline = join(clientRoot, `compatibility/obsidian-${rendererVersion}.json`);
  const sourceAsar = join(officialApp, "Contents/Resources/obsidian.asar");
  const patchedAsar = join(rendererRoot, "blackglass.asar");
  const firstApp = join(firstRoot, "Blackglass.app");
  const firstManifest = join(firstRoot, "release.json");
  const firstReceipt = join(firstRoot, "package-receipt.json");
  const secondApp = join(secondRoot, "Blackglass.app");
  const secondManifest = join(secondRoot, "release.json");
  const secondReceipt = join(secondRoot, "package-receipt.json");
  const reproducibility = join(rendererRoot, "reproducibility.json");
  const runRoot = await safeE2EOutputPath(clientRoot, runArgument);
  packagedApp = firstApp;

  stages.push(
    {
      name: `client-${rendererVersion}-patch`,
      command: [
        Bun.which("bun") ?? "bun", "run", "tools/patch-client.ts", sourceAsar, patchedAsar,
        "--control-origin", candidate.endpoints.controlOrigin,
        "--data-host", candidate.endpoints.dataHost,
        "--resources", join(officialApp, "Contents/Resources"),
        "--baseline", baseline,
      ],
      cwd: clientRoot,
      outputs: [patchedAsar],
    },
    packageStage("a", firstApp, firstManifest, firstReceipt),
    packageStage("b", secondApp, secondManifest, secondReceipt),
    {
      name: `client-${rendererVersion}-reproducibility`,
      command: [
        Bun.which("bun") ?? "bun", "run", "tools/verify-macos-reproducibility.ts",
        firstApp, firstManifest, firstReceipt,
        secondApp, secondManifest, secondReceipt,
        reproducibility,
      ],
      cwd: clientRoot,
      outputs: [reproducibility],
    },
    {
      name: `client-${rendererVersion}-e2e-prepare`,
      resumeKey: runScopedStageKey(
        `client-${rendererVersion}-e2e-prepare`,
        clientRoot,
        runRoot,
      ),
      command: [
        Bun.which("bun") ?? "bun", "run", "tools/prepare-e2e.ts", runRoot, patchedAsar,
        "--app", firstApp,
        "--release-manifest", firstManifest,
        "--package-receipt", firstReceipt,
        "--second-app", secondApp,
        "--second-release-manifest", secondManifest,
        "--second-package-receipt", secondReceipt,
        "--reproducibility-evidence", reproducibility,
      ],
      cwd: clientRoot,
      outputs: [
        join(runRoot, "run-manifest.json"),
        join(runRoot, "blackglass-release-manifest.json"),
        join(runRoot, "client-artifact.json"),
        join(runRoot, "client-reproducibility.json"),
        join(runRoot, "credentials.json"),
      ],
    },
    {
      name: `client-${rendererVersion}-e2e-tls`,
      resumeKey: runScopedStageKey(
        `client-${rendererVersion}-e2e-tls`,
        clientRoot,
        runRoot,
      ),
      command: [Bun.which("bun") ?? "bun", "run", "tools/prepare-e2e-tls.ts", runRoot],
      cwd: clientRoot,
      outputs: [
        join(runRoot, "tls-certificate.pem"),
        join(runRoot, "tls-private-key.pem"),
        join(runRoot, "tls-metadata.json"),
      ],
    },
  );

  function packageStage(
    suffix: string,
    app: string,
    manifest: string,
    receipt: string,
  ): Stage {
    return {
      name: `client-${rendererVersion}-package-${suffix}`,
      command: [
        Bun.which("bun") ?? "bun", "run", "tools/package-macos.ts",
        officialApp, patchedAsar, app,
        "--control-origin", candidate.endpoints.controlOrigin,
        "--data-host", candidate.endpoints.dataHost,
        "--manifest", manifest,
        "--receipt", receipt,
        "--official-dmg", officialDmg,
        "--baseline", baseline,
      ],
      cwd: clientRoot,
      outputs: [app, manifest, receipt],
    };
  }
}

for (const stage of stages) {
  await assertReleaseCandidateMatchesCheckouts({ candidate, clientRoot, serverRoot });
  if (isComplete(state, stage) && !stage.revalidateOnResume) {
    await assertOutputsComplete(stage);
    console.log(`[resume] ${stage.name}`);
    continue;
  }
  if (
    !stage.revalidateOnResume &&
    stage.outputs &&
    (await outputsPresent(stage.outputs)) === "complete"
  ) {
    console.log(`[recover] ${stage.name}`);
  } else {
    await assertNoPartialOutputs(stage);
    await run(stage);
  }
  if (!isComplete(state, stage)) {
    state.completed.push({
      stage: stage.name,
      key: stageResumeKey(stage),
      completedAt: new Date().toISOString(),
    });
  }
  await writeState(statePath, state);
}

if (parsed.booleans.has("--require-gui")) {
  if (!packagedApp) throw new Error("--require-gui requires --prepare-client");
  await run({
    name: "gui-doctor",
    command: [...doctorCommand, "--require-gui", "--app", packagedApp],
    cwd: clientRoot,
  });
}

releasePipelineLock();
process.off("exit", releasePipelineLock);
console.log(JSON.stringify({
  passed: true,
  candidateSha256,
  statePath,
  completedStages: state.completed.map((entry) => entry.stage),
  guiReady: parsed.booleans.has("--require-gui"),
}, null, 2));

function requiredValue(name: string): string {
  const value = parsed.values.get(name);
  if (!value) throw new Error(`${name} is required with --prepare-client`);
  return value;
}

async function safeE2EOutputPath(root: string, argument: string): Promise<string> {
  const e2eRoot = resolve(root, ".data/e2e");
  await mkdir(e2eRoot, { recursive: true, mode: 0o700 });
  const absolute = resolve(argument);
  const output = await pathExists(absolute)
    ? await canonicalExistingPath(absolute, "E2E run directory", "directory")
    : await canonicalOutputPath(absolute, "E2E run directory");
  assertPathWithin(output, e2eRoot, "E2E run directory");
  return output;
}

async function run(stage: Stage): Promise<void> {
  console.log(`[run] ${stage.name}`);
  const child = Bun.spawn(stage.command, {
    cwd: stage.cwd,
    env: { ...process.env, ...stage.environment },
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await child.exited;
  if (exitCode !== 0) throw new Error(`${stage.name} failed with exit code ${exitCode}`);
}

async function readState(path: string, expectedCandidate: string): Promise<PipelineState> {
  if (!(await pathExists(path))) {
    return { schemaVersion: PIPELINE_STATE_SCHEMA_VERSION, candidateSha256: expectedCandidate, completed: [] };
  }
  const value = JSON.parse(await readFile(path, "utf8")) as Partial<PipelineState>;
  if (
    value.schemaVersion !== PIPELINE_STATE_SCHEMA_VERSION ||
    value.candidateSha256 !== expectedCandidate ||
    !Array.isArray(value.completed) ||
    value.completed.some((entry) =>
      typeof entry?.stage !== "string" ||
      typeof entry.key !== "string" ||
      typeof entry.completedAt !== "string" ||
      !Number.isFinite(Date.parse(entry.completedAt))
    )
  ) {
    throw new Error("Release pipeline state is malformed or belongs to another candidate");
  }
  return value as PipelineState;
}

async function writeState(path: string, state: PipelineState): Promise<void> {
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`);
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  try {
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

function isComplete(state: PipelineState, stage: Stage): boolean {
  return state.completed.some((entry) => entry.key === stageResumeKey(stage));
}

function stageResumeKey(stage: Stage): string {
  return stage.resumeKey ?? stage.name;
}

function runScopedStageKey(stage: string, root: string, runRoot: string): string {
  const runPath = relative(resolve(root, ".data/e2e"), runRoot);
  const digest = createHash("sha256").update(runPath).digest("hex");
  return `${stage}:run-${digest}`;
}

async function outputsPresent(paths: string[]): Promise<"missing" | "partial" | "complete"> {
  const present = await Promise.all(paths.map(pathExists));
  if (present.every(Boolean)) return "complete";
  if (present.every((value) => !value)) return "missing";
  return "partial";
}

async function assertOutputsComplete(stage: Stage): Promise<void> {
  if (stage.outputs && (await outputsPresent(stage.outputs)) !== "complete") {
    throw new Error(`Completed stage ${stage.name} has missing or partial outputs`);
  }
}

async function assertNoPartialOutputs(stage: Stage): Promise<void> {
  if (stage.outputs && (await outputsPresent(stage.outputs)) === "partial") {
    throw new Error(`Stage ${stage.name} has partial outputs; preserve them for diagnosis and use a new candidate run`);
  }
}

async function sha256File(path: string): Promise<string> {
  const file = await stat(path);
  if (!file.isFile()) throw new Error(`Expected a file: ${path}`);
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

function usage(): never {
  console.error(
    "Usage: bun run tools/run-release-candidate.ts <candidate.json> " +
      "--server-repo <blackglass-server> [--full-checks] [--linux] " +
      "[--prepare-client --renderer <version> --official-app <Obsidian.app> " +
      "--official-dmg <Obsidian.dmg> --run <.data/e2e/name>] " +
      "[--require-gui] [--require-stable-signing]",
  );
  process.exit(2);
}
