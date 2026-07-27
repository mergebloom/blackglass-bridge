import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { AsarArchive } from "../tools/asar.ts";

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

  test("rejects a malformed size pickle", () => {
    const buffer = makeArchive("hello.txt", Buffer.from("hello"));
    buffer.writeUInt32LE(8, 0);

    expect(() => AsarArchive.fromBuffer(buffer)).toThrow(
      "Unsupported ASAR size pickle",
    );
  });
});
