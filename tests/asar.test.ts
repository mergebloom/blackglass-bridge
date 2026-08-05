import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { AsarArchive, replacePackedAsarEntry } from "../tools/asar.ts";

function align4(value: number): number {
  return (value + 3) & ~3;
}

function makeArchive(
  filename: string,
  content: Buffer,
  declaredHash?: string,
): Buffer {
  const hash =
    declaredHash ?? createHash("sha256").update(content).digest("hex");
  const header = JSON.stringify({
    files: {
      [filename]: {
        size: content.length,
        offset: "0",
        integrity: {
          algorithm: "SHA256",
          hash,
        },
      },
    },
  });
  const headerBytes = Buffer.from(header, "utf8");
  const stringSize = headerBytes.length;
  const payloadSize = align4(4 + stringSize);
  const headerPickleSize = 4 + payloadSize;
  const dataOffset = 8 + headerPickleSize;
  const output = Buffer.alloc(dataOffset + content.length);

  output.writeUInt32LE(4, 0);
  output.writeUInt32LE(headerPickleSize, 4);
  output.writeUInt32LE(payloadSize, 8);
  output.writeUInt32LE(stringSize, 12);
  headerBytes.copy(output, 16);
  content.copy(output, dataOffset);
  return output;
}

function makeMultiArchive(files: Record<string, Buffer>): Buffer {
  let offset = 0;
  const nodes: Record<string, unknown> = {};
  for (const [name, content] of Object.entries(files)) {
    nodes[name] = { size: content.length, offset: String(offset), integrity: { algorithm: "SHA256", hash: createHash("sha256").update(content).digest("hex") } };
    offset += content.length;
  }
  const headerBytes = Buffer.from(JSON.stringify({ files: nodes }), "utf8");
  const payloadSize = align4(4 + headerBytes.length);
  const headerPickleSize = 4 + payloadSize;
  const output = Buffer.alloc(8 + headerPickleSize + offset);
  output.writeUInt32LE(4, 0);
  output.writeUInt32LE(headerPickleSize, 4);
  output.writeUInt32LE(payloadSize, 8);
  output.writeUInt32LE(headerBytes.length, 12);
  headerBytes.copy(output, 16);
  let dataOffset = 8 + headerPickleSize;
  for (const content of Object.values(files)) { content.copy(output, dataOffset); dataOffset += content.length; }
  return output;
}

describe("AsarArchive", () => {
  test("lists and reads a verified entry", () => {
    const archive = AsarArchive.fromBuffer(
      makeArchive("hello.txt", Buffer.from("hello")),
    );

    expect(archive.entries().map((entry) => entry.path)).toEqual(["hello.txt"]);
    expect(archive.read("hello.txt").toString("utf8")).toBe("hello");
  });

  test("rejects an integrity mismatch", () => {
    const archive = AsarArchive.fromBuffer(
      makeArchive("hello.txt", Buffer.from("hello"), "00".repeat(32)),
    );

    expect(() => archive.read("hello.txt")).toThrow("integrity mismatch");
  });

  test("replaces a packed entry and rebuilds its integrity metadata", () => {
    const upstream = makeArchive("hello.txt", Buffer.from("hello"));
    const replacement = Buffer.from("world");
    const output = replacePackedAsarEntry(upstream, "hello.txt", replacement);

    expect(AsarArchive.fromBuffer(output).read("hello.txt")).toEqual(replacement);
  });

  test("rebuilds following offsets when a packed entry changes size", () => {
    const upstream = makeMultiArchive({ "first.js": Buffer.from("one"), "second.js": Buffer.from("two") });
    const output = replacePackedAsarEntry(upstream, "first.js", Buffer.from("one-expanded"));
    const archive = AsarArchive.fromBuffer(output);
    expect(archive.read("first.js").toString()).toBe("one-expanded");
    expect(archive.read("second.js").toString()).toBe("two");
  });

  test("rejects a malformed size pickle", () => {
    const buffer = makeArchive("hello.txt", Buffer.from("hello"));
    buffer.writeUInt32LE(8, 0);

    expect(() => AsarArchive.fromBuffer(buffer)).toThrow(
      "Unsupported ASAR size pickle",
    );
  });
});
