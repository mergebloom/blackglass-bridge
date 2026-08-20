import { createHash } from "node:crypto";
import { expect, test } from "bun:test";
import {
  inspectPatchedLinuxMainProcess,
  patchLinuxMainProcess,
  patchReviewedLinuxRegistration,
} from "../packages/client-adapter/src/linux";
import {
  assertLinuxClientConfig,
  linuxClientConfigSha256,
  type LinuxClientConfig,
} from "../tools/linux-client-config";
import { LINUX_CLIENT_COMPATIBILITY } from "../tools/linux-compatibility";

test("rewrites the exact Linux CLI registration without retaining obsidian", () => {
  const upstream = Buffer.from(
    'let x=P.join(q,"obsidian-cli"),y=P.join(H.homedir(),".local","bin"),z=P.join(y,"obsidian");',
  );
  const incision = {
    offset: 41,
    length: upstream.length,
    sha256: createHash("sha256").update(upstream).digest("hex"),
  };
  const source = Buffer.alloc(incision.offset + incision.length + 1, 0x20);
  upstream.copy(source, incision.offset);
  const patched = patchReviewedLinuxRegistration(source, incision);
  expect(patched.length).toBe(source.length);
  expect(patched.toString()).toContain("process.env.BGCLI");
  expect(patched.toString()).toContain('P.join(y,"blackglass")');
  expect(patched.toString()).not.toContain('P.join(y,"obsidian")');
  expect(() => inspectPatchedLinuxMainProcess(patched, incision)).not.toThrow();
  expect(() => patchReviewedLinuxRegistration(Buffer.from(source).fill(0x78, incision.offset, incision.offset + 1), incision))
    .toThrow("incision changed");
  expect(() => patchLinuxMainProcess(Buffer.alloc(200_000))).toThrow("incision changed");
});

test("binds Linux install configuration to both reviewed architectures", () => {
  for (const architecture of ["amd64", "arm64"] as const) {
    const baseline = LINUX_CLIENT_COMPATIBILITY[architecture];
    const config: LinuxClientConfig = {
      schemaVersion: 1,
      blackglassVersion: "0.5.0",
      bridgeRevision: "a".repeat(40),
      rendererVersion: "1.13.4",
      architecture,
      endpoints: { controlOrigin: "https://sync.example.com", dataHost: "data.example.com" },
      upstream: {
        archiveSha256: baseline.upstreamArchive.sha256,
        runtimeTree: baseline.runtimeTree,
        rendererAsarSha256: baseline.rendererAsarSha256,
        wrapperAsarSha256: baseline.wrapperAsarSha256,
        executableSha256: baseline.executableSha256,
        cliExecutableSha256: baseline.cliExecutableSha256,
      },
      generated: {
        rendererSha256: "1".repeat(64),
        cliExecutableSha256: "2".repeat(64),
        bridgeExecutableSha256: "3".repeat(64),
      },
      paths: {
        runtime: "runtime",
        renderer: "resources/blackglass.asar",
        cliExecutable: "libexec/blackglass-cli",
        cliShim: "libexec/blackglass-cli-shim",
        bridgeExecutable: "libexec/blackglass-bridge",
        icon: "share/blackglass-prism.png",
      },
      launchPolicy: {
        profileDirectory: "Blackglass",
        profileMode: 0o700,
        updateDisabled: true,
        cliEnabled: true,
        exactRuntimeVerifiedAtEveryLaunch: true,
        isolatedCliSocket: ".blackglass-c.sock",
      },
    };
    expect(() => assertLinuxClientConfig(config)).not.toThrow();
    expect(linuxClientConfigSha256(config)).toMatch(/^[a-f0-9]{64}$/);
    expect(() => assertLinuxClientConfig({ ...config, architecture: "x86" })).toThrow();
  }
});
