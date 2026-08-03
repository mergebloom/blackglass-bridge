import { createHash } from "node:crypto";
import { expect, test } from "bun:test";
import {
  inspectPatchedMainProcess,
  patchAsar,
  patchMainProcess,
  patchRenderer,
  patchStarterRenderer,
} from "../packages/client-adapter/src/patch";
import type { RendererIncision } from "../packages/client-adapter/src/incision";

const endpoints = {
  controlOrigin: "https://sync-control.example.test",
  dataHost: "sync-data.example.test",
};

test("applies only reviewed hash-and-offset renderer incisions", () => {
  const source = Buffer.from(`prefix-${"c".repeat(64)}-middle-${"d".repeat(64)}-suffix`);
  const controlOffset = source.indexOf(Buffer.from("c".repeat(64)));
  const dataOffset = source.indexOf(Buffer.from("d".repeat(64)));
  const incisions = [
    reviewed("control", "app.js", source, controlOffset, 64, "control-origin"),
    reviewed("data", "app.js", source, dataOffset, 64, "data-host-guard"),
  ];
  const patched = patchRenderer(source, endpoints, incisions);
  expect(patched.length).toBe(source.length);
  expect(patched.toString()).toContain('"https://sync-control.example.test"');
  expect(patched.toString()).toContain('u.host!=="sync-data.example.test"');
  expect(source.toString()).not.toBe(patched.toString());
});

test("patches the starter with its independently reviewed range", () => {
  const source = Buffer.from(`before-${"s".repeat(64)}-after`);
  const offset = source.indexOf(Buffer.from("s".repeat(64)));
  const patched = patchStarterRenderer(source, endpoints, [
    reviewed("starter-control", "starter.js", source, offset, 64, "control-origin"),
  ]);
  expect(patched.toString()).toContain('"https://sync-control.example.test"');
  expect(patched.length).toBe(source.length);
});

test("derives minified CLI bindings locally without storing an upstream excerpt", () => {
  const runtime = "qz.homedir()".padEnd(48, " ");
  const socket = ".obsidian-cli.sock";
  const registration =
    'let aa=pp.join(rr,"obsidian-cli");if(ff.existsSync(aa)){let cc="/usr/local/bin/obsidian";';
  const source = Buffer.from(`function synthetic(){${runtime};"${socket}";${registration}}}`);
  const incisions = [
    rangeFor("runtime", "main.js", source, runtime, "cli-runtime-home"),
    rangeFor("socket", "main.js", source, socket, "cli-socket"),
    rangeFor("registration", "main.js", source, registration, "cli-registration"),
  ];
  const patched = patchMainProcess(source, incisions);
  expect(patched.length).toBe(source.length);
  expect(inspectPatchedMainProcess(patched)).toMatchObject({
    cliSocketName: ".blackglass-c.sock",
    runtimeHomeEnvironment: "BLACKGLASS_HOME",
    cliCommandName: "blackglass",
  });
});

test("builds and reopens an exact ASAR from reviewed incisions", () => {
  const app = Buffer.from(`a${"x".repeat(64)}b${"y".repeat(64)}c`);
  const starter = Buffer.from(`d${"z".repeat(64)}e`);
  const runtime = "hm.homedir()".padEnd(48, " ");
  const socket = ".obsidian-cli.sock";
  const registration =
    'let a=p.join(r,"obsidian-cli");if(f.existsSync(a)){let c="/usr/local/bin/obsidian";';
  const main = Buffer.from(`function main(){${runtime};"${socket}";${registration}}}`);
  const archive = makeArchive({
    "app.js": app,
    "starter.js": starter,
    "main.js": main,
    "index.html": Buffer.from("<script></script>"),
    "package.json": Buffer.from('{"version":"1.2.3"}'),
  });
  const incisions: RendererIncision[] = [
    rangeFor("control", "app.js", app, "x".repeat(64), "control-origin"),
    rangeFor("data", "app.js", app, "y".repeat(64), "data-host-guard"),
    rangeFor("starter", "starter.js", starter, "z".repeat(64), "control-origin"),
    rangeFor("runtime", "main.js", main, runtime, "cli-runtime-home"),
    rangeFor("socket", "main.js", main, socket, "cli-socket"),
    rangeFor("registration", "main.js", main, registration, "cli-registration"),
  ];
  const generated = patchAsar(archive, endpoints, incisions);
  expect(generated.buffer.length).toBe(archive.length);
  expect(generated.report).toMatchObject({
    patchFormatVersion: 9,
    cliExecutableEnvironment: "BGCLI",
    incisionCount: 6,
    controlOrigin: endpoints.controlOrigin,
    dataHost: endpoints.dataHost,
  });
  expect(generated.report.upstreamSha256).not.toBe(generated.report.patchedSha256);
});

test("fails closed on changed, out-of-range, overlapping, or empty incision plans", () => {
  const source = Buffer.from("x".repeat(128));
  const valid = reviewed("one", "app.js", source, 2, 64, "control-origin");
  expect(() => patchRenderer(source, endpoints, [{ ...valid, sha256: "0".repeat(64) }]))
    .toThrow("hash mismatch");
  expect(() => patchRenderer(source, endpoints, [{ ...valid, offset: 99 }]))
    .toThrow("Invalid");
  expect(() => patchRenderer(source, endpoints, [valid, { ...valid, id: "two", offset: 3 }]))
    .toThrow("overlapping");
  expect(() => patchRenderer(source, endpoints, [])).toThrow("empty");
});

test("binds the generated data-host expression to its port", () => {
  const source = Buffer.from("x".repeat(80));
  const incision = reviewed("data", "app.js", source, 0, 80, "data-host-guard");
  const first = patchRenderer(source, { ...endpoints, dataHost: "sync.example.test:8443" }, [incision]);
  const second = patchRenderer(source, { ...endpoints, dataHost: "sync.example.test:9443" }, [incision]);
  expect(first).not.toEqual(second);
});

test("enforces canonical HTTPS control and renderer-compatible data endpoints", () => {
  const source = Buffer.from("x".repeat(96));
  const incision = reviewed("control", "app.js", source, 0, 96, "control-origin");
  for (const controlOrigin of [
    "https://sync.example.test",
    "http://127.0.0.1:3000",
    "http://localhost:3000",
  ]) {
    expect(() => patchRenderer(source, { controlOrigin, dataHost: "sync-data.example.test" }, [incision]))
      .not.toThrow();
  }
  for (const controlOrigin of [
    "http://sync.example.test",
    "https://user:secret@sync.example.test",
    "https://sync.example.test/path",
    "https://sync.example.test/",
    "https://SYNC.example.test",
    "https://0.0.0.0",
    "https://224.0.0.1",
    "https://invalid_label.example",
  ]) {
    expect(() => patchRenderer(source, { controlOrigin, dataHost: "sync-data.example.test" }, [incision]))
      .toThrow();
  }
});

test("rejects unusable or non-canonical data hosts", () => {
  const source = Buffer.from("x".repeat(96));
  const incision = reviewed("data", "app.js", source, 0, 96, "data-host-guard");
  for (const dataHost of [
    "sync-data.example.test",
    "sync-data.example.test:8443",
    "127.0.0.1:3003",
    "localhost:3003",
    "192.0.2.10:8443",
    "[2001:db8::1]:8443",
  ]) {
    expect(() => patchRenderer(source, { ...endpoints, dataHost }, [incision])).not.toThrow();
  }
  for (const dataHost of [
    "localhost",
    "127.0.0.1",
    "localhost.evil.example:8080",
    "127.0.0.2:3003",
    "0.0.0.0:3003",
    "[::1]:3003",
    "invalid_label.example",
    "sync-data.example.test:0",
    "SYNC-data.example.test",
    "sync-data.example.test:443",
  ]) {
    expect(() => patchRenderer(source, { ...endpoints, dataHost }, [incision])).toThrow();
  }
});

function rangeFor(
  id: string,
  file: string,
  source: Buffer,
  value: string,
  replacement: RendererIncision["replacement"],
): RendererIncision {
  const needle = Buffer.from(value);
  const offset = source.indexOf(needle);
  if (offset < 0 || source.indexOf(needle, offset + needle.length) >= 0) {
    throw new Error(`Synthetic range ${id} is absent or ambiguous`);
  }
  return reviewed(id, file, source, offset, needle.length, replacement);
}

function reviewed(
  id: string,
  file: string,
  source: Buffer,
  offset: number,
  length: number,
  replacement: RendererIncision["replacement"],
): RendererIncision {
  return {
    id,
    file,
    offset,
    length,
    sha256: createHash("sha256").update(source.subarray(offset, offset + length)).digest("hex"),
    replacement,
  };
}

function makeArchive(files: Record<string, Buffer>): Buffer {
  let offset = 0;
  const nodes: Record<string, unknown> = {};
  const payloads: Buffer[] = [];
  for (const [filename, content] of Object.entries(files)) {
    const hash = createHash("sha256").update(content).digest("hex");
    nodes[filename] = {
      size: content.length,
      offset: String(offset),
      integrity: { algorithm: "SHA256", hash, blockSize: 4_194_304, blocks: [hash] },
    };
    payloads.push(content);
    offset += content.length;
  }
  const header = Buffer.from(JSON.stringify({ files: nodes }));
  const padded = (header.length + 3) & ~3;
  const output = Buffer.alloc(16 + padded + offset);
  output.writeUInt32LE(4, 0);
  output.writeUInt32LE(8 + padded, 4);
  output.writeUInt32LE(4 + padded, 8);
  output.writeUInt32LE(header.length, 12);
  header.copy(output, 16);
  let cursor = 16 + padded;
  for (const payload of payloads) {
    payload.copy(output, cursor);
    cursor += payload.length;
  }
  return output;
}
