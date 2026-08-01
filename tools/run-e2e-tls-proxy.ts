import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const node = Bun.which("node");
if (!node) {
  throw new Error("The E2E TLS proxy requires Node.js on PATH");
}

const temporaryRoot = await mkdtemp(join(tmpdir(), "blackglass-e2e-tls-proxy-"));
let child: ReturnType<typeof Bun.spawn> | undefined;
const signalHandlers = new Map<NodeJS.Signals, () => void>();

try {
  const build = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "e2e-tls-proxy.ts")],
    outdir: temporaryRoot,
    target: "node",
    format: "esm",
    minify: false,
    sourcemap: "none",
    define: {
      "import.meta.dir": JSON.stringify(import.meta.dir),
    },
  });
  if (!build.success || build.outputs.length !== 1) {
    const diagnostics = build.logs.map((entry) => entry.message).join("\n");
    throw new Error(`Unable to build the Node.js E2E TLS proxy: ${diagnostics}`);
  }

  child = Bun.spawn([node, build.outputs[0]!.path, ...Bun.argv.slice(2)], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    const handler = () => {
      if (child?.exitCode === null) child.kill(signal);
    };
    signalHandlers.set(signal, handler);
    process.on(signal, handler);
  }
  process.exitCode = await child.exited;
} finally {
  for (const [signal, handler] of signalHandlers) process.off(signal, handler);
  await rm(temporaryRoot, { recursive: true, force: true });
}
