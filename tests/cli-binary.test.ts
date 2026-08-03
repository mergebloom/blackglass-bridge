import { expect, test } from "bun:test";
import {
  inspectPatchedCliBinary,
  patchCliBinary,
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
