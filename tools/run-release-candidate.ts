import { createHash } from "node:crypto";
import { readFileSync, unlinkSync } from "node:fs";
import { lstat, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { parseStrictFlags } from "./cli-flags";
import { computeTreeIdentity } from "./tree-identity";
import {
  DEFAULT_E2E_SCENARIO,
  parseE2EScenarioId,
  preparedE2EScenarioId,
} from "./e2e-scenario";
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
import { releaseStageResumeDecision } from "./release-stage-resume";

const PIPELINE_STATE_SCHEMA_VERSION = 3;

interface OutputIdentity {
  path: string;
  kind: "file" | "directory";
  sha256: string;
}

interface PipelineState {
  schemaVersion: typeof PIPELINE_STATE_SCHEMA_VERSION;
  candidateSha256: string;
  completed: Array<{
    stage: string;
    key: string;
    completedAt: string;
    outputs: OutputIdentity[];
  }>;
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
    "--scenario",
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
  const scenarioId = parseE2EScenarioId(
    parsed.values.get("--scenario") ?? DEFAULT_E2E_SCENARIO,
  );
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
  const existingRunManifest = join(runRoot, "run-manifest.json");
  if (await pathExists(existingRunManifest)) {
    const existing = JSON.parse(await readFile(existingRunManifest, "utf8")) as {
      scenarioId?: unknown;
    };
    if (preparedE2EScenarioId(existing.scenarioId) !== scenarioId) {
      throw new Error(
        `E2E run is already bound to ${preparedE2EScenarioId(existing.scenarioId)}; refusing ${scenarioId}`,
      );
    }
  }
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
        "--scenario", scenarioId,
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
  const decision = releaseStageResumeDecision({
    hasReceipt: isComplete(state, stage),
    revalidateOnResume: stage.revalidateOnResume === true,
  });
  if (decision !== "run-new") {
    await assertCompletedStageUnchanged(state, stage);
  }
  if (decision === "resume") {
    console.log(`[resume] ${stage.name}`);
    continue;
  }
  if (decision === "run-new") await assertNoUnboundOutputs(stage);
  await run(stage);
  if (!isComplete(state, stage)) {
    state.completed.push({
      stage: stage.name,
      key: stageResumeKey(stage),
      completedAt: new Date().toISOString(),
      outputs: await outputIdentities(stage),
    });
  } else {
    const entry = completedEntry(state, stage);
    entry.completedAt = new Date().toISOString();
    entry.outputs = await outputIdentities(stage);
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
      !Number.isFinite(Date.parse(entry.completedAt)) ||
      !Array.isArray(entry.outputs) ||
      entry.outputs.some((output) =>
        typeof output?.path !== "string" ||
        (output.kind !== "file" && output.kind !== "directory") ||
        !/^[a-f0-9]{64}$/u.test(output.sha256)
      )
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

function completedEntry(state: PipelineState, stage: Stage): PipelineState["completed"][number] {
  const entries = state.completed.filter((entry) => entry.key === stageResumeKey(stage));
  if (entries.length !== 1) throw new Error(`Release stage state is duplicated: ${stage.name}`);
  return entries[0]!;
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

async function assertNoUnboundOutputs(stage: Stage): Promise<void> {
  if (!stage.outputs) return;
  const present = await outputsPresent(stage.outputs);
  if (present !== "missing") {
    throw new Error(
      `Stage ${stage.name} has ${present} outputs without an exact completed-stage receipt; ` +
        "preserve them for diagnosis and use a new candidate run",
    );
  }
}

async function assertCompletedStageUnchanged(state: PipelineState, stage: Stage): Promise<void> {
  const expected = completedEntry(state, stage).outputs;
  const actual = await outputIdentities(stage);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Completed stage ${stage.name} outputs changed after their receipt was written`);
  }
}

async function outputIdentities(stage: Stage): Promise<OutputIdentity[]> {
  const identities: OutputIdentity[] = [];
  for (const path of stage.outputs ?? []) {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink()) throw new Error(`Stage output must not be a symlink: ${path}`);
    if (metadata.isFile()) {
      identities.push({ path, kind: "file", sha256: await sha256File(path) });
    } else if (metadata.isDirectory()) {
      identities.push({ path, kind: "directory", sha256: (await computeTreeIdentity(path)).sha256 });
    } else {
      throw new Error(`Unsupported stage output type: ${path}`);
    }
  }
  return identities;
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
      "[--scenario <scenario-id>] " +
      "[--require-gui] [--require-stable-signing]",
  );
  process.exit(2);
}
