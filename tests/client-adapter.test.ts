import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import {
  patchAsar,
  patchRenderer,
} from "../packages/client-adapter/src/patch";
import { AsarArchive } from "../tools/asar";

const controlExpression =
  '"https://"+[String.fromCharCode(97,112,105),"obsidian","md"].join(".")';
const hostnameCondition =
  '!oee.call(h,".obsidian.md")&&"127.0.0.1"!==h';

describe("client adapter", () => {
  test("makes two fixed-length semantic incisions", () => {
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
    expect(source).toContain('h!=="127.0.0.1"');
    expect(source).not.toContain(controlExpression);
    expect(source).not.toContain(hostnameCondition);
  });

  test("rebuilds ASAR integrity metadata and verifies the result", () => {
    const renderer = Buffer.from(
      `var dw=${controlExpression};if(${hostnameCondition})throw Error();`,
    );
    const upstream = makeArchive("app.js", renderer);
    const generated = patchAsar(upstream, {
      controlOrigin: "https://sync-control.example.test",
      dataHost: "sync-data.example.test:443",
    });
    const archive = AsarArchive.fromBuffer(generated.buffer);
    const patchedRenderer = archive.read("app.js");

    expect(patchedRenderer.toString("utf8")).toContain(
      '"https://sync-control.example.test"',
    );
    expect(patchedRenderer.toString("utf8")).toContain(
      'h!=="sync-data.example.test"',
    );
    expect(generated.report.upstreamSha256).not.toBe(
      generated.report.patchedSha256,
    );
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
});

function makeArchive(filename: string, content: Buffer): Buffer {
  const hash = createHash("sha256").update(content).digest("hex");
  const blockSize = 32;
  const blocks: string[] = [];
  for (let offset = 0; offset < content.length; offset += blockSize) {
    blocks.push(
      createHash("sha256")
        .update(content.subarray(offset, offset + blockSize))
        .digest("hex"),
    );
  }
  const header = Buffer.from(
    JSON.stringify({
      files: {
        [filename]: {
          size: content.length,
          offset: "0",
          integrity: {
            algorithm: "SHA256",
            hash,
            blockSize,
            blocks,
          },
        },
      },
    }),
    "utf8",
  );
  const paddedStringLength = align4(header.length);
  const headerPayloadSize = 4 + paddedStringLength;
  const headerPickleSize = 4 + headerPayloadSize;
  const dataOffset = 8 + headerPickleSize;
  const output = Buffer.alloc(dataOffset + content.length);
  output.writeUInt32LE(4, 0);
  output.writeUInt32LE(headerPickleSize, 4);
  output.writeUInt32LE(headerPayloadSize, 8);
  output.writeUInt32LE(header.length, 12);
  header.copy(output, 16);
  content.copy(output, dataOffset);
  return output;
}

function align4(value: number): number {
  return (value + 3) & ~3;
}
