import { readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { inspectServerArtifact } from "./server-artifact";

const rootArgument = Bun.argv[2];
if (!rootArgument) {
  console.error("Usage: bun run tools/run-e2e-server.ts <run-directory>");
  process.exit(2);
}

const root = resolve(rootArgument);
const credentials = JSON.parse(
  await readFile(resolve(root, "credentials.json"), "utf8"),
) as { email: string; password: string };
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
await recordArtifact(artifact);

const child = Bun.spawn([binary, "serve"], {
  cwd: root,
  stdout: "inherit",
  stderr: "inherit",
  env: {
    ...process.env,
    SELFHOST_BIND_HOST: "127.0.0.1",
    SELFHOST_CONTROL_PORT: "3000",
    SELFHOST_DATA_PORT: "3003",
    SELFHOST_DATA_HOST: "127.0.0.1:3003",
    SELFHOST_DATABASE: resolve(root, "server.sqlite"),
    SELFHOST_STAGING_DIR: resolve(root, "uploads"),
    SELFHOST_EMAIL: credentials.email,
    SELFHOST_PASSWORD: credentials.password,
    SELFHOST_ALLOW_PLAINTEXT_PASSWORD: "1",
    SELFHOST_NAME: "E2E user",
    SELFHOST_PER_FILE_MAX: String(200 * 1024 * 1024),
    SELFHOST_ALLOWED_ORIGIN: "app://obsidian.md",
    SELFHOST_LOG_FORMAT: "pretty",
  },
});

await waitForHealth(child);
console.log("Blackglass Server E2E control plane ready at http://127.0.0.1:3000");
console.log("Blackglass Server E2E data plane ready at ws://127.0.0.1:3003");

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  child.kill("SIGTERM");
  await child.exited;
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
const exitCode = await child.exited;
if (!shuttingDown) process.exit(exitCode);

async function waitForHealth(processHandle: ReturnType<typeof Bun.spawn>): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (processHandle.exitCode !== null) {
      throw new Error(`Rust E2E server exited early with ${processHandle.exitCode}`);
    }
    try {
      if ((await fetch("http://127.0.0.1:3000/ready")).ok) return;
    } catch {}
    await Bun.sleep(50);
  }
  throw new Error("Rust E2E server did not become ready");
}

async function recordArtifact(value: Awaited<ReturnType<typeof inspectServerArtifact>>): Promise<void> {
  const output = resolve(root, "server-artifact.json");
  if (await Bun.file(output).exists()) {
    const existing = JSON.parse(await readFile(output, "utf8")) as typeof value;
    if (existing.sha256 !== value.sha256 || existing.version !== value.version) {
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
