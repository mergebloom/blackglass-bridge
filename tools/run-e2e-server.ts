import { readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { parseStrictFlags } from "./cli-flags";
import { readPreparedE2ERun } from "./e2e-network";
import {
  assertServerArtifactSourceRevision,
  exactServerSourceRevision,
  inspectServerArtifact,
} from "./server-artifact";

const [rootArgument, ...flags] = Bun.argv.slice(2);
const parsedFlags = parseStrictFlags(flags, {
  valueFlags: ["--identity-out", "--expected-server-source-revision"],
});
const identityArgument = parsedFlags.values.get("--identity-out");
const expectedSourceRevisionArgument = parsedFlags.values.get(
  "--expected-server-source-revision",
);
if (!rootArgument || !identityArgument || !expectedSourceRevisionArgument) {
  console.error(
    "Usage: bun run tools/run-e2e-server.ts <run-directory> " +
      "--identity-out <identity.json> " +
      "--expected-server-source-revision <full-Git-commit>",
  );
  process.exit(2);
}
const expectedSourceRevision = exactServerSourceRevision(
  expectedSourceRevisionArgument,
  "Expected server source revision",
);

const preparedRun = await readPreparedE2ERun(rootArgument);
const root = preparedRun.root;
const { network, endpoints } = preparedRun.manifest;
const identityPath = resolve(identityArgument);
if (
  dirname(identityPath) !== root ||
  !/^server-[a-z0-9-]+\.json$/u.test(basename(identityPath))
) {
  throw new Error("Server identity must be a server-*.json file directly inside the E2E run");
}
const credentials = JSON.parse(
  await readFile(resolve(root, "credentials.json"), "utf8"),
) as {
  email: string;
  password: string;
  secondary?: { email: string; password: string; name: string };
  outsider?: { email: string; password: string; name: string };
};
const binary = resolve(
  process.env.BLACKGLASS_SERVER_BINARY ??
    process.env.SELFHOST_SERVER_BINARY ??
    resolve(import.meta.dir, "../../blackglass-server/apps/server-rust/target/release/blackglass-server"),
);
if (!(await Bun.file(binary).exists())) {
  throw new Error(
    `Blackglass Server release does not exist: ${binary}. Build the sibling ` +
      "blackglass-server project or set BLACKGLASS_SERVER_BINARY.",
  );
}
const artifact = await inspectServerArtifact(binary);
assertServerArtifactSourceRevision(artifact, expectedSourceRevision);
await recordArtifact(artifact);
const inheritedEnvironment = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => !name.startsWith("SELFHOST_")),
);
const databasePath = resolve(root, "server.sqlite");
if (!(await Bun.file(databasePath).exists())) {
  provisionUser(binary, databasePath, credentials.email, "E2E user", credentials.password);
  if (credentials.secondary) {
    provisionUser(
      binary,
      databasePath,
      credentials.secondary.email,
      credentials.secondary.name,
      credentials.secondary.password,
    );
  }
  if (credentials.outsider) {
    provisionUser(
      binary,
      databasePath,
      credentials.outsider.email,
      credentials.outsider.name,
      credentials.outsider.password,
    );
  }
}

const child = Bun.spawn([binary, "serve"], {
  cwd: root,
  stdout: "inherit",
  stderr: "inherit",
  env: {
    ...inheritedEnvironment,
    SELFHOST_BIND_HOST: "127.0.0.1",
    SELFHOST_CONTROL_PORT: String(network.control.upstreamPort),
    SELFHOST_DATA_PORT: String(network.data.upstreamPort),
    // The packaged client must exercise the exact production hostname. The
    // scoped Electron resolver rule sends it to the loopback TLS proxy; using a
    // loopback host here would leave the data-host incision unqualified.
    SELFHOST_DATA_HOST: network.data.publicHost,
    SELFHOST_DATABASE: databasePath,
    SELFHOST_STAGING_DIR: resolve(root, "uploads"),
    SELFHOST_PER_FILE_MAX: String(200 * 1024 * 1024),
    SELFHOST_ALLOWED_ORIGIN: "app://obsidian.md",
    SELFHOST_MAX_CONCURRENT_UPLOADS: "4",
    SELFHOST_MAX_WS_CONNECTIONS: "8",
    // Manual desktop qualification can include a long source-loss recovery
    // drill. Keep its session valid for a full working day while remaining far
    // below the server's production maximum.
    SELFHOST_SESSION_TTL_SECONDS: String(24 * 60 * 60),
    SELFHOST_SHARING_ENABLED: "true",
    SELFHOST_LOG_FORMAT: "pretty",
  },
});

const startedAt = new Date().toISOString();
const ready = await waitForHealth(child);
const readyAt = new Date().toISOString();
let processIdentity = {
  schemaVersion: 2,
  pid: child.pid,
  startedAt,
  readyAt,
  stoppedAt: null as string | null,
  exitCode: null as number | null,
  gracefulShutdown: null as boolean | null,
  binaryPath: binary,
  expectedSourceRevision,
  artifact,
  databasePath,
  stagingPath: resolve(root, "uploads"),
  controlOrigin: endpoints.controlOrigin,
  dataHost: endpoints.dataHost,
  ready,
};
await writeIdentity(processIdentity, true);
console.log(
  `Blackglass Server E2E control plane ready at http://${network.control.upstreamHost}:${network.control.upstreamPort}`,
);
console.log(
  `Blackglass Server E2E data plane ready at ws://${network.data.upstreamHost}:${network.data.upstreamPort}`,
);

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  child.kill("SIGTERM");
  const exitCode = await child.exited;
  processIdentity = {
    ...processIdentity,
    stoppedAt: new Date().toISOString(),
    exitCode,
    gracefulShutdown: true,
  };
  await writeIdentity(processIdentity, false);
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
const exitCode = await child.exited;
if (!shuttingDown) {
  processIdentity = {
    ...processIdentity,
    stoppedAt: new Date().toISOString(),
    exitCode,
    gracefulShutdown: false,
  };
  await writeIdentity(processIdentity, false);
  process.exit(exitCode);
}

async function waitForHealth(
  processHandle: ReturnType<typeof Bun.spawn>,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (processHandle.exitCode !== null) {
      throw new Error(`Rust E2E server exited early with ${processHandle.exitCode}`);
    }
    try {
      const response = await fetch(
        `http://${network.control.upstreamHost}:${network.control.upstreamPort}/ready`,
      );
      if (response.ok) return await response.json() as Record<string, unknown>;
    } catch {}
    await Bun.sleep(50);
  }
  throw new Error("Rust E2E server did not become ready");
}

async function writeIdentity(value: typeof processIdentity, exclusive: boolean): Promise<void> {
  if (exclusive && await Bun.file(identityPath).exists()) {
    throw new Error(`Refusing to overwrite server identity: ${identityPath}`);
  }
  const temporary = `${identityPath}.next`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  await rename(temporary, identityPath);
}

async function recordArtifact(value: Awaited<ReturnType<typeof inspectServerArtifact>>): Promise<void> {
  const output = resolve(root, "server-artifact.json");
  if (await Bun.file(output).exists()) {
    const existing = JSON.parse(await readFile(output, "utf8")) as typeof value;
    if (
      existing.schemaVersion !== value.schemaVersion ||
      existing.sha256 !== value.sha256 ||
      existing.version !== value.version ||
      existing.sourceRevision !== value.sourceRevision
    ) {
      throw new Error(
        `E2E run is already bound to server ${existing.sha256}; refusing ${value.sha256}`,
      );
    }
    return;
  }
  const temporary = `${output}.next`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  await rename(temporary, output);
}

function provisionUser(
  executable: string,
  database: string,
  email: string,
  name: string,
  password: string,
): void {
  const result = Bun.spawnSync(
    [executable, "user", "create", database, email, name],
    {
      stdin: Buffer.from(`${password}\n`),
      stdout: "pipe",
      stderr: "pipe",
      env: Object.fromEntries(
        Object.entries(process.env).filter(([key]) => !key.startsWith("SELFHOST_")),
      ),
    },
  );
  if (result.exitCode !== 0) {
    const error = result.stderr.toString("utf8").trim();
    throw new Error(`Could not provision offline E2E account: ${error || "unknown error"}`);
  }
}
