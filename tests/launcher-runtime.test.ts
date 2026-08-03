import { createHash } from "node:crypto";
import { chmod, lstat, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import type { BridgeLaunchConfig } from "../tools/launcher-config";
import { packagedLauncherArguments } from "../tools/launcher-config";
import { runtimeReceiptPathForClientIdentity } from "../tools/e2e-client";
import {
  assertRuntimeProfile,
  assertSafeRuntimeArguments,
  acquireRuntimeLaunchLease,
  clearStaleRendererLeases,
  releaseRuntimeLaunchLease,
  unmanagedOfficialProcesses,
} from "../tools/launcher-runtime";

test("extracts internal launcher bindings and rejects isolation overrides", () => {
  expect(packagedLauncherArguments([
    "--blackglass-profile", "/profiles/a",
    "--blackglass-vault", "/vaults/a",
    "--remote-debugging-port=9321",
  ])).toEqual({
    profilePath: "/profiles/a",
    vaultPath: "/vaults/a",
    runtimeArguments: ["--remote-debugging-port=9321"],
  });
  expect(() => packagedLauncherArguments([
    "--blackglass-profile", "/a",
    "--blackglass-profile", "/b",
  ])).toThrow("duplicate");
  expect(() => assertSafeRuntimeArguments(["--user-data-dir=/tmp/escape"])).toThrow(
    "Unsupported packaged runtime argument",
  );
  expect(() => assertSafeRuntimeArguments([
    "--remote-debugging-port=9321",
    "--remote-debugging-address=127.0.0.1",
    "--host-resolver-rules=MAP sync-control.example.test 127.0.0.1:18443,MAP sync-data.example.test 127.0.0.1:18443",
    `--ignore-certificate-errors-spki-list=${"A".repeat(43)}=`,
  ])).not.toThrow();
  expect(() => assertSafeRuntimeArguments([
    "--host-resolver-rules=MAP sync.example.test 127.0.0.1:18443,MAP sync.example.test 127.0.0.1:18443",
  ])).toThrow("Unsafe packaged host resolver rules");
  expect(() => assertSafeRuntimeArguments([
    "--host-resolver-rules=MAP sync.example.test 127.0.0.1:18443,MAP data.example.test 127.0.0.1:18444",
  ])).toThrow("Unsafe packaged host resolver rules");
});

test("uses distinct immutable receipts for initial and clean-recovery launches", () => {
  expect(runtimeReceiptPathForClientIdentity(
    "/runs/one", "client-b", "/runs/one/client-b-launch.json",
  )).toBe("/runs/one/client-b-runtime.json");
  expect(runtimeReceiptPathForClientIdentity(
    "/runs/one", "client-b", "/runs/one/client-b-recovery-launch.json",
  )).toBe("/runs/one/client-b-recovery-runtime.json");
  expect(() => runtimeReceiptPathForClientIdentity(
    "/runs/one", "client-a", "/runs/one/client-a-recovery-launch.json",
  )).toThrow("Unexpected client-a launch identity filename");
});

test("allows separately supervised Bridge clients but rejects ordinary Obsidian", () => {
  const processes = [
    { pid: 10, ppid: 1, command: "/A/Blackglass Bridge.app/Contents/MacOS/blackglass-bridge" },
    { pid: 11, ppid: 10, command: "/private/A/Obsidian.app/Contents/MacOS/Obsidian" },
    { pid: 12, ppid: 11, command: "/private/A/Obsidian Helper (Renderer)" },
    { pid: 20, ppid: 1, command: "/B/Blackglass Bridge.app/Contents/MacOS/blackglass-bridge" },
    { pid: 21, ppid: 20, command: "/private/B/Obsidian.app/Contents/MacOS/Obsidian" },
  ];
  expect(unmanagedOfficialProcesses(processes)).toEqual([]);
  expect(unmanagedOfficialProcesses([
    ...processes,
    { pid: 30, ppid: 1, command: "/Applications/Obsidian.app/Contents/MacOS/Obsidian" },
  ]).map(({ pid }) => pid)).toEqual([30]);
});

test("refuses active Unix socket leases and ordinary files", async () => {
  const home = await mkdtemp(join(tmpdir(), "blackglass-launcher-leases-"));
  const socket = join(home, ".blackglass-c.sock");
  const server = Bun.listen({
    unix: socket,
    socket: { data() {}, open() {}, close() {}, drain() {}, error() {} },
  });
  try {
    expect((await lstat(socket)).isSocket()).toBe(true);
    await expect(clearStaleRendererLeases(home)).rejects.toThrow("active renderer lease");
    expect((await lstat(socket)).isSocket()).toBe(true);
  } finally {
    server.stop(true);
  }

  const protectedPath = join(home, ".obsidian-cli.sock");
  await writeFile(protectedPath, "not a socket", { mode: 0o600 });
  await expect(clearStaleRendererLeases(home)).rejects.toThrow("Refusing to replace non-socket");
  expect(await readFile(protectedPath, "utf8")).toBe("not a socket");
});

test("serializes launches and recovers a PID-reuse lease", async () => {
  const home = await mkdtemp(join(tmpdir(), "blackglass-launcher-lock-"));
  const other = await mkdtemp(join(tmpdir(), "blackglass-launcher-lock-other-"));
  const first = await acquireRuntimeLaunchLease(home, "/apps/bridge-a", home);
  await expect(acquireRuntimeLaunchLease(home, "/apps/bridge-b", home))
    .rejects.toThrow("Another Blackglass Bridge launcher owns");
  const independent = await acquireRuntimeLaunchLease(other, "/apps/bridge-b", other);
  await releaseRuntimeLaunchLease(independent);
  await releaseRuntimeLaunchLease(first);

  await writeFile(join(home, ".blackglass-launch.lock"), `${JSON.stringify({
    schemaVersion: 2,
    pid: process.pid,
    processStartIdentity: "0".repeat(64),
    acquiredAt: new Date().toISOString(),
    nonce: "stale-process-identity",
    bundlePath: "/apps/old",
    profilePath: home,
  })}\n`, { mode: 0o600 });
  const recovered = await acquireRuntimeLaunchLease(home, "/apps/bridge-c", home);
  await releaseRuntimeLaunchLease(recovered);
});

test("runtime profile fails closed when alias, adapter, or update protection drifts", async () => {
  const profile = await mkdtemp(join(tmpdir(), "blackglass-launcher-profile-"));
  await chmod(profile, 0o700);
  const adapter = Buffer.from("reviewed adapter");
  const adapterName = "obsidian-1.13.5.asar";
  const config = {
    adapterProfileFileName: adapterName,
    adapterSha256: createHash("sha256").update(adapter).digest("hex"),
  } as BridgeLaunchConfig;
  await writeFile(join(profile, adapterName), adapter, { mode: 0o600 });
  await writeFile(join(profile, "obsidian.json"), '{"updateDisabled":true}\n', { mode: 0o600 });
  await assertRuntimeProfile(config, profile);

  await writeFile(join(profile, "obsidian-1.13.6.asar"), adapter, { mode: 0o600 });
  await expect(assertRuntimeProfile(config, profile)).rejects.toThrow("renderer selection changed");
  await Bun.file(join(profile, "obsidian-1.13.6.asar")).delete();

  await writeFile(join(profile, adapterName), "tampered", { mode: 0o600 });
  await expect(assertRuntimeProfile(config, profile)).rejects.toThrow("renderer changed");
  await writeFile(join(profile, adapterName), adapter, { mode: 0o600 });

  await writeFile(join(profile, "obsidian.json"), '{"updateDisabled":false}\n', { mode: 0o600 });
  await expect(assertRuntimeProfile(config, profile)).rejects.toThrow("update protection changed");
});
