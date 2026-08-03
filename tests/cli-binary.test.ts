import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BLACKGLASS_CLI_IDENTIFIER,
  inspectPatchedCliBinary,
  patchCliBinary,
  writeSignedPatchedCliBinary,
} from "../tools/cli-binary";

test("patches both universal CLI socket literals without changing size", () => {
  const upstream = Buffer.from(
    `x86:.obsidian-cli.sock\0arm:.obsidian-cli.sock\0`,
  );
  const generated = patchCliBinary(upstream);
  expect(generated.buffer.length).toBe(upstream.length);
  expect(generated.buffer.toString("utf8")).toBe(
    `x86:.blackglass-c.sock\0arm:.blackglass-c.sock\0`,
  );
  expect(generated.report).toMatchObject({
    patchFormatVersion: 2,
    incisionCount: 2,
    socketName: ".blackglass-c.sock",
  });
  expect(inspectPatchedCliBinary(generated.buffer)).toMatchObject({
    socketName: ".blackglass-c.sock",
    socketOccurrences: 2,
  });
});

test("fails closed on missing, extra, or previously patched socket literals", () => {
  expect(() => patchCliBinary(Buffer.from("none"))).toThrow("found 0");
  expect(() =>
    patchCliBinary(Buffer.from(".obsidian-cli.sock.obsidian-cli.sock.obsidian-cli.sock")),
  ).toThrow("found 3");
  expect(() =>
    patchCliBinary(Buffer.from(".blackglass-c.sock.blackglass-c.sock")),
  ).toThrow("already contains");
});

test("ad-hoc signs the locally adapted CLI with an independent identifier", async () => {
  if (process.platform !== "darwin") return;
  const root = await mkdtemp(join(tmpdir(), "blackglass-cli-sign-test-"));
  try {
    const source = join(root, "fixture.c");
    const executable = join(root, "fixture");
    await writeFile(
      source,
      '__attribute__((used)) static const char socket1[]=".obsidian-cli.sock";\n' +
        '__attribute__((used)) static const char socket2[]=".obsidian-cli.sock";\n' +
        "int main(void){return socket1[0]==socket2[0]?0:1;}\n",
    );
    const compiled = Bun.spawnSync([
      "/usr/bin/xcrun", "clang", "-arch", "arm64", "-Wl,-no_adhoc_codesign",
      source, "-o", executable,
    ], { stdout: "pipe", stderr: "pipe" });
    expect(compiled.exitCode, compiled.stderr.toString("utf8")).toBe(0);
    const upstream = await readFile(executable);
    const first = join(root, "first");
    const second = join(root, "second");
    const a = await writeSignedPatchedCliBinary(upstream, first);
    const b = await writeSignedPatchedCliBinary(upstream, second);
    expect(a).toEqual(b);
    expect(a.patchedSha256).not.toBe(a.executableSha256);
    const details = Bun.spawnSync([
      "/usr/bin/codesign", "--display", "--verbose=2", first,
    ]).stderr.toString("utf8");
    expect(details).toContain(`Identifier=${BLACKGLASS_CLI_IDENTIFIER}`);
  } finally {
    await rm(root, { recursive: true, force: false });
  }
});
