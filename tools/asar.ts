import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

export interface AsarIntegrity {
  algorithm: string;
  hash: string;
  blockSize?: number;
  blocks?: string[];
}

export interface AsarNode {
  files?: Record<string, AsarNode>;
  size?: number;
  offset?: string;
  unpacked?: boolean;
  executable?: boolean;
  link?: string;
  integrity?: AsarIntegrity;
}

export interface AsarHeader {
  files: Record<string, AsarNode>;
}

export interface AsarEntry {
  path: string;
  node: AsarNode;
}

export class AsarArchive {
  readonly buffer: Buffer;
  readonly header: AsarHeader;
  readonly dataOffset: number;
  readonly headerStringSize: number;

  private constructor(
    buffer: Buffer,
    header: AsarHeader,
    dataOffset: number,
    headerStringSize: number,
  ) {
    this.buffer = buffer;
    this.header = header;
    this.dataOffset = dataOffset;
    this.headerStringSize = headerStringSize;
  }

  static async open(path: string): Promise<AsarArchive> {
    return AsarArchive.fromBuffer(await readFile(path));
  }

  static fromBuffer(buffer: Buffer): AsarArchive {
    if (buffer.length < 16) {
      throw new Error("ASAR is too small to contain a header");
    }

    const sizePicklePayload = buffer.readUInt32LE(0);
    if (sizePicklePayload !== 4) {
      throw new Error(`Unsupported ASAR size pickle: ${sizePicklePayload}`);
    }

    const headerPickleSize = buffer.readUInt32LE(4);
    const headerPayloadSize = buffer.readUInt32LE(8);
    const headerStringSize = buffer.readUInt32LE(12);
    const dataOffset = 8 + headerPickleSize;

    if (headerPayloadSize + 4 !== headerPickleSize) {
      throw new Error("ASAR header pickle lengths are inconsistent");
    }
    if (headerStringSize > headerPayloadSize - 4) {
      throw new Error("ASAR header string exceeds its pickle payload");
    }
    if (dataOffset > buffer.length) {
      throw new Error("ASAR data offset is outside the archive");
    }

    const headerText = buffer
      .subarray(16, 16 + headerStringSize)
      .toString("utf8")
      .replace(/\0+$/u, "");

    let parsed: unknown;
    try {
      parsed = JSON.parse(headerText);
    } catch (error) {
      throw new Error(`Invalid ASAR JSON header: ${String(error)}`);
    }

    if (!isAsarHeader(parsed)) {
      throw new Error("ASAR header does not contain a files object");
    }

    return new AsarArchive(buffer, parsed, dataOffset, headerStringSize);
  }

  entries(): AsarEntry[] {
    const output: AsarEntry[] = [];
    walkNodes(this.header.files, "", output);
    return output;
  }

  get(path: string): AsarNode | undefined {
    const parts = normalizePath(path).split("/").filter(Boolean);
    let files = this.header.files;
    let current: AsarNode | undefined;

    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index];
      if (part === undefined) {
        return undefined;
      }
      current = files[part];
      if (!current) {
        return undefined;
      }
      if (index < parts.length - 1) {
        if (!current.files) {
          return undefined;
        }
        files = current.files;
      }
    }

    return current;
  }

  read(path: string, verify = true): Buffer {
    const node = this.get(path);
    if (!node) {
      throw new Error(`ASAR entry not found: ${path}`);
    }
    if (node.files) {
      throw new Error(`ASAR entry is a directory: ${path}`);
    }
    if (node.unpacked) {
      throw new Error(`ASAR entry is stored outside the archive: ${path}`);
    }
    if (node.link) {
      return this.read(node.link, verify);
    }
    if (node.size === undefined || node.offset === undefined) {
      throw new Error(`ASAR entry lacks size or offset: ${path}`);
    }

    const relativeOffset = Number(node.offset);
    if (!Number.isSafeInteger(relativeOffset) || relativeOffset < 0) {
      throw new Error(`ASAR entry has an invalid offset: ${path}`);
    }

    const start = this.dataOffset + relativeOffset;
    const end = start + node.size;
    if (end > this.buffer.length) {
      throw new Error(`ASAR entry extends beyond the archive: ${path}`);
    }

    const content = this.buffer.subarray(start, end);
    if (verify && node.integrity) {
      verifyIntegrity(path, content, node.integrity);
    }
    return content;
  }

  contentRange(path: string): { start: number; end: number } {
    const node = this.get(path);
    if (!node || node.files || node.unpacked || node.link) {
      throw new Error(`ASAR entry is not directly addressable: ${path}`);
    }
    if (node.size === undefined || node.offset === undefined) {
      throw new Error(`ASAR entry lacks size or offset: ${path}`);
    }
    const relativeOffset = Number(node.offset);
    if (!Number.isSafeInteger(relativeOffset) || relativeOffset < 0) {
      throw new Error(`ASAR entry has an invalid offset: ${path}`);
    }
    return {
      start: this.dataOffset + relativeOffset,
      end: this.dataOffset + relativeOffset + node.size,
    };
  }
}

function isAsarHeader(value: unknown): value is AsarHeader {
  if (!value || typeof value !== "object") {
    return false;
  }
  return "files" in value && typeof value.files === "object" && value.files !== null;
}

function normalizePath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\/+/u, "");
}

function walkNodes(
  files: Record<string, AsarNode>,
  parent: string,
  output: AsarEntry[],
): void {
  for (const [name, node] of Object.entries(files)) {
    const path = parent ? `${parent}/${name}` : name;
    output.push({ path, node });
    if (node.files) {
      walkNodes(node.files, path, output);
    }
  }
}

function verifyIntegrity(
  path: string,
  content: Buffer,
  integrity: AsarIntegrity,
): void {
  const algorithm = integrity.algorithm.toLowerCase().replace("-", "");
  const actual = createHash(algorithm).update(content).digest("hex");
  if (actual !== integrity.hash.toLowerCase()) {
    throw new Error(
      `ASAR integrity mismatch for ${path}: expected ${integrity.hash}, got ${actual}`,
    );
  }
}
