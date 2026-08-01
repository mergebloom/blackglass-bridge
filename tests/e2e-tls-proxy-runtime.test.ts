import { expect, test } from "bun:test";
import { resolve } from "node:path";

test("the documented TLS proxy launcher executes the bundled proxy with Node.js", () => {
  const result = Bun.spawnSync(
    [process.execPath, resolve(import.meta.dir, "../tools/run-e2e-tls-proxy.ts")],
    { stdout: "pipe", stderr: "pipe" },
  );

  expect(result.exitCode).toBe(2);
  expect(result.stderr.toString()).toContain(
    "Usage: bun run e2e:tls:proxy -- <prepared-E2E-run-directory>",
  );
  expect(result.stderr.toString()).not.toContain("Bun is not defined");
});
