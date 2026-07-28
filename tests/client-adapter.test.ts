import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import {
  inspectPatchedMainProcess,
  patchAsar,
  patchMainProcess,
  patchRenderer,
  patchStarterRenderer,
} from "../packages/client-adapter/src/patch";
import { AsarArchive } from "../tools/asar";

const controlExpression =
  '"https://"+[String.fromCharCode(97,112,105),"obsidian","md"].join(".")';
const hostnameCondition =
  '!oee.call(h,".obsidian.md")&&"127.0.0.1"!==h';
const cliRuntimeRoot =
  "!U&&process.env.XDG_RUNTIME_DIR||ce.homedir()";
const cliRegistration =
  'let g=D.join(u,"obsidian-cli");if(h.existsSync(g)){let w="/usr/local/bin/obsidian";';

describe("client adapter", () => {
  test("makes two fixed-length semantic incisions in the main renderer", () => {
    const upstream = Buffer.from(
      `var dw=${controlExpression};if(${hostnameCondition})throw Error();`,
    );
    const patched = patchRenderer(upstream, {
      controlOrigin: "http://127.0.0.1:3000",
      dataHost: "127.0.0.1:3003",
    });
    const source = patched.toString("utf8");

    expect(patched.length).toBe(upstream.length);
    expect(source).toContain('"http://127.0.0.1:3000"');
    expect(source).toContain('u.host!=="127.0.0.1:3003"');
    expect(source).not.toContain(controlExpression);
    expect(source).not.toContain(hostnameCondition);
  });

  test("patches the independent no-vault starter control origin", () => {
    const upstream = Buffer.from(
      `var sa=${controlExpression};function da(a,e){return window.fetch(sa+a,e)}`,
    );
    const patched = patchStarterRenderer(upstream, {
      controlOrigin: "https://sync-control.example.test",
      dataHost: "sync-data.example.test:8443",
    });
    expect(patched.length).toBe(upstream.length);
    expect(patched.toString("utf8")).toContain('var sa="https://sync-control.example.test"');
    expect(patched.toString("utf8")).not.toContain(controlExpression);
  });

  test("uses BLACKGLASS_HOME for the dedicated fixed-length CLI socket", () => {
    const upstream = Buffer.from(upstreamMain());
    const patched = patchMainProcess(upstream);
    const source = patched.toString("utf8");
    expect(patched.length).toBe(upstream.length);
    expect(source).toContain('D.join(process.env.BLACKGLASS_HOME||ce.homedir()    ,".blackglass-b.sock")');
    expect(source).toContain("process.env.BLACKGLASS_HOME||ce.homedir()");
    expect(source).toContain('let w="/usr/local/bin/blackglass";');
    expect(source).not.toContain("process.env.XDG_RUNTIME_DIR");
    expect(source).not.toContain("/usr/local/bin/obsidian");
    expect(() =>
      patchMainProcess(Buffer.from(
        `const root=${cliRuntimeRoot};const socket="missing";${cliRegistration}}`,
      )),
    ).toThrow("CLI socket name must match exactly once");
    expect(() =>
      patchMainProcess(Buffer.from(
        `const root=${cliRuntimeRoot};const socket=".obsidian-cli.sock"+".obsidian-cli.sock";${cliRegistration}}`,
      )),
    ).toThrow("CLI socket name must match exactly once");
  });

  test("fails closed when the CLI runtime-root incision is missing or ambiguous", () => {
    expect(() =>
      patchMainProcess(Buffer.from(
        `const root=ce.homedir();const socket=".obsidian-cli.sock";${cliRegistration}}`,
      )),
    ).toThrow("CLI runtime home must match exactly once");
    expect(() =>
      patchMainProcess(Buffer.from(
        `const first=${cliRuntimeRoot},second=${cliRuntimeRoot};const socket=".obsidian-cli.sock";${cliRegistration}}`,
      )),
    ).toThrow("CLI runtime home must match exactly once");
  });

  test("main-process inspection rejects a broken socket construction", () => {
    const patched = patchMainProcess(Buffer.from(upstreamMain())).toString("utf8");
    expect(() => inspectPatchedMainProcess(Buffer.from(patched))).not.toThrow();
    const disconnected = patched.replace(
      "D.join(process.env.BLACKGLASS_HOME",
      "D.noop(process.env.BLACKGLASS_HOME",
    );
    expect(disconnected).toHaveLength(patched.length);
    expect(() => inspectPatchedMainProcess(Buffer.from(disconnected))).toThrow(
      "socket construction",
    );
  });

  test("rebuilds ASAR integrity metadata and verifies the result", () => {
    const renderer = Buffer.from(
      `var dw=${controlExpression};if(${hostnameCondition})throw Error();`,
    );
    const starter = Buffer.from(`var sa=${controlExpression};`);
    const main = Buffer.from(upstreamMain());
    const upstream = makeArchive({
      "app.js": renderer,
      "starter.js": starter,
      "main.js": main,
    });
    const generated = patchAsar(upstream, {
      controlOrigin: "https://sync-control.example.test",
      dataHost: "sync-data.example.test:8443",
    });
    const archive = AsarArchive.fromBuffer(generated.buffer);
    const patchedRenderer = archive.read("app.js");
    const patchedStarter = archive.read("starter.js");
    const patchedMain = archive.read("main.js");

    expect(patchedRenderer.toString("utf8")).toContain(
      '"https://sync-control.example.test"',
    );
    expect(patchedRenderer.toString("utf8")).toContain(
      'u.host!=="sync-data.example.test:8443"',
    );
    expect(patchedStarter.toString("utf8")).toContain(
      'var sa="https://sync-control.example.test"',
    );
    expect(patchedMain.toString("utf8")).toContain(".blackglass-b.sock");
    expect(patchedMain.toString("utf8")).toContain(
      "process.env.BLACKGLASS_HOME||ce.homedir()",
    );
    expect(patchedMain.toString("utf8")).toContain("/usr/local/bin/blackglass");
    expect(generated.report.upstreamSha256).not.toBe(
      generated.report.patchedSha256,
    );
    expect(generated.report).toMatchObject({
      patchFormatVersion: 6,
      incisionCount: 6,
      controlOrigin: "https://sync-control.example.test",
      dataHost: "sync-data.example.test:8443",
      cliSocketName: ".blackglass-b.sock",
      cliCommandName: "blackglass",
      cliCommandPath: "/usr/local/bin/blackglass",
      runtimeHomeEnvironment: "BLACKGLASS_HOME",
    });
  });

  test("binds the renderer to the configured data port", () => {
    const upstream = Buffer.from(
      `var dw=${controlExpression};if(${hostnameCondition})throw Error();`,
    );
    const first = patchRenderer(upstream, {
      controlOrigin: "https://sync-control.example.test",
      dataHost: "sync.example.test:8443",
    });
    const second = patchRenderer(upstream, {
      controlOrigin: "https://sync-control.example.test",
      dataHost: "sync.example.test:9443",
    });

    expect(first).not.toEqual(second);
    expect(first.toString("utf8")).toContain('u.host!=="sync.example.test:8443"');
    expect(second.toString("utf8")).toContain('u.host!=="sync.example.test:9443"');
  });

  test("matches the server's canonical data-host boundary", () => {
    const upstream = Buffer.from(
      `var dw=${controlExpression};if(${hostnameCondition})throw Error();`,
    );
    for (const dataHost of [
      "sync-data.example.test",
      "sync-data.example.test:8443",
      "127.0.0.1:3003",
      "localhost:3003",
      "192.0.2.10:8443",
      "[2001:db8::1]:8443",
      "xn--bcher-kva.example",
    ]) {
      expect(() =>
        patchRenderer(upstream, {
          controlOrigin: "https://sync-control.example.test",
          dataHost,
        }),
      ).not.toThrow();
    }
    for (const dataHost of [
      "localhost",
      "127.0.0.1",
      "localhost.evil.example:8080",
      "127.0.0.1.evil.example:8080",
      "127.0.0.2:3003",
      "0.0.0.0:3003",
      "224.0.0.1:3003",
      "255.255.255.255:3003",
      "[::1]:3003",
      "[::]:3003",
      "[ff02::1]:3003",
      "invalid_label.example",
      "-invalid.example",
      "invalid-.example",
      "invalid..example",
      "sync-data.example.test:0",
    ]) {
      expect(() =>
        patchRenderer(upstream, {
          controlOrigin: "https://sync-control.example.test",
          dataHost,
        }),
      ).toThrow();
    }
  });

  test("rejects unusable control-origin network addresses", () => {
    const upstream = Buffer.from(
      `var dw=${controlExpression};if(${hostnameCondition})throw Error();`,
    );
    for (const controlOrigin of [
      "https://0.0.0.0",
      "https://224.0.0.1",
      "https://255.255.255.255",
      "https://[::]",
      "https://[ff02::1]",
      "https://invalid_label.example",
      "https://-invalid.example",
      "https://invalid-.example",
      "https://invalid..example",
      "https://sync-control.example.test:0",
    ]) {
      expect(() =>
        patchRenderer(upstream, {
          controlOrigin,
          dataHost: "sync-data.example.test",
        }),
      ).toThrow();
    }
  });

  test("rejects non-canonical endpoint spellings", () => {
    const upstream = Buffer.from(
      `var dw=${controlExpression};if(${hostnameCondition})throw Error();`,
    );
    for (const options of [
      {
        controlOrigin: "https://SYNC-control.example.test",
        dataHost: "sync-data.example.test",
      },
      {
        controlOrigin: "https://sync-control.example.test/",
        dataHost: "sync-data.example.test",
      },
      {
        controlOrigin: "https://sync-control.example.test",
        dataHost: "SYNC-data.example.test",
      },
      {
        controlOrigin: "https://sync-control.example.test",
        dataHost: "sync-data.example.test:443",
      },
    ]) {
      expect(() => patchRenderer(upstream, options)).toThrow("not canonical");
    }
  });

  test("fails closed if a semantic anchor is ambiguous", () => {
    const renderer = Buffer.from(
      `${controlExpression}${controlExpression}${hostnameCondition}`,
    );
    expect(() =>
      patchRenderer(renderer, {
        controlOrigin: "http://127.0.0.1:3000",
        dataHost: "127.0.0.1:3003",
      }),
    ).toThrow("must match exactly once");
  });

  test("fails closed if the starter origin anchor is missing or ambiguous", () => {
    for (const starter of [
      Buffer.from("no control origin"),
      Buffer.from(`${controlExpression}${controlExpression}`),
    ]) {
      expect(() =>
        patchStarterRenderer(starter, {
          controlOrigin: "http://127.0.0.1:3000",
          dataHost: "127.0.0.1:3003",
        }),
      ).toThrow("must match exactly once");
    }
  });
});

function upstreamMain(): string {
  return `module.exports=function(){const socket=D.join(${cliRuntimeRoot},".obsidian-cli.sock");${cliRegistration}}}`;
}

function makeArchive(files: Record<string, Buffer>): Buffer {
  let offset = 0;
  const nodes: Record<string, unknown> = {};
  const payloads: Buffer[] = [];
  for (const [filename, content] of Object.entries(files)) {
    const hash = createHash("sha256").update(content).digest("hex");
    const blockSize = 32;
    const blocks: string[] = [];
    for (let blockOffset = 0; blockOffset < content.length; blockOffset += blockSize) {
      blocks.push(
        createHash("sha256")
          .update(content.subarray(blockOffset, blockOffset + blockSize))
          .digest("hex"),
      );
    }
    nodes[filename] = {
      size: content.length,
      offset: String(offset),
      integrity: { algorithm: "SHA256", hash, blockSize, blocks },
    };
    payloads.push(content);
    offset += content.length;
  }
  const header = Buffer.from(
    JSON.stringify({ files: nodes }),
    "utf8",
  );
  const paddedStringLength = align4(header.length);
  const headerPayloadSize = 4 + paddedStringLength;
  const headerPickleSize = 4 + headerPayloadSize;
  const dataOffset = 8 + headerPickleSize;
  const output = Buffer.alloc(dataOffset + payloads.reduce((sum, item) => sum + item.length, 0));
  output.writeUInt32LE(4, 0);
  output.writeUInt32LE(headerPickleSize, 4);
  output.writeUInt32LE(headerPayloadSize, 8);
  output.writeUInt32LE(header.length, 12);
  header.copy(output, 16);
  let payloadOffset = dataOffset;
  for (const payload of payloads) {
    payload.copy(output, payloadOffset);
    payloadOffset += payload.length;
  }
  return output;
}

function align4(value: number): number {
  return (value + 3) & ~3;
}
