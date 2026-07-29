import { createHash } from "node:crypto";
import { inflateSync } from "node:zlib";
import { describe, expect, test } from "bun:test";
import {
  OBSIDIAN_SYNC_PIECE_BYTES,
  RECOVERY_CORPUS_ID,
  RECOVERY_CORPUS_MANIFEST_SHA256,
  RECOVERY_CORPUS_SCHEMA_VERSION,
  RECOVERY_MULTIPART_IMAGE_HEIGHT,
  RECOVERY_MULTIPART_IMAGE_PATH,
  RECOVERY_MULTIPART_IMAGE_WIDTH,
  assertCanonicalRecoveryCorpusIdentity,
  assertCanonicalRecoveryCorpusManifest,
  canonicalRecoveryCorpusFiles,
  canonicalRecoveryCorpusIdentity,
  compareCodePointStrings,
  type RecoveryCorpusFileEntry,
} from "../tools/recovery-corpus";

describe("canonical mixed-file recovery corpus", () => {
  test("has a versioned, reviewed identity and exact type summary", () => {
    const identity = canonicalRecoveryCorpusIdentity();
    expect(identity).toEqual({
      schemaVersion: RECOVERY_CORPUS_SCHEMA_VERSION,
      id: RECOVERY_CORPUS_ID,
      files: 14,
      bytes: 2_169_728,
      manifestSha256:
        "b9e9a7e59c99d6bd165cc989619c64e03cee336c866b4733183da2ad3f96afcf",
      types: {
        ".canvas": 1,
        ".csv": 1,
        ".js": 1,
        ".json": 1,
        ".md": 6,
        ".pdf": 1,
        ".png": 2,
        ".svg": 1,
      },
      multipart: {
        path: RECOVERY_MULTIPART_IMAGE_PATH,
        bytes: 2_163_625,
        sha256: "a5ceeffa7a9395783ee7e5b04f5155b5fcce2c4d90707b70a479b7ff51a2da84",
        pieceBytes: OBSIDIAN_SYNC_PIECE_BYTES,
        minimumPieces: 2,
      },
    });
    expect(identity.manifestSha256).toBe(RECOVERY_CORPUS_MANIFEST_SHA256);
    expect(() => assertCanonicalRecoveryCorpusIdentity(identity)).not.toThrow();
    const png = canonicalRecoveryCorpusFiles().get("Assets/recovery-chart.png")!;
    expect(png.subarray(0, 8)).toEqual(
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    );
    expect(png.readUInt32BE(16)).toBe(160);
    expect(png.readUInt32BE(20)).toBe(80);
    png[0] = 0;
    expect(canonicalRecoveryCorpusFiles().get("Assets/recovery-chart.png")![0]).toBe(137);
  });

  test("forces the actual client multipart path with a deterministic valid PNG", () => {
    const first = canonicalRecoveryCorpusFiles().get(RECOVERY_MULTIPART_IMAGE_PATH)!;
    const second = canonicalRecoveryCorpusFiles().get(RECOVERY_MULTIPART_IMAGE_PATH)!;
    const identity = canonicalRecoveryCorpusIdentity();
    expect(first).toEqual(second);
    expect(first.byteLength).toBeGreaterThan(OBSIDIAN_SYNC_PIECE_BYTES);
    expect(Math.ceil(first.byteLength / OBSIDIAN_SYNC_PIECE_BYTES)).toBe(2);
    expect(sha256(first)).toBe(
      "a5ceeffa7a9395783ee7e5b04f5155b5fcce2c4d90707b70a479b7ff51a2da84",
    );
    expect(identity.multipart).toEqual({
      path: RECOVERY_MULTIPART_IMAGE_PATH,
      bytes: first.byteLength,
      sha256: sha256(first),
      pieceBytes: OBSIDIAN_SYNC_PIECE_BYTES,
      minimumPieces: 2,
    });
    expect(first.subarray(0, 8)).toEqual(
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    );
    expect(first.subarray(12, 16).toString("ascii")).toBe("IHDR");
    expect(first.readUInt32BE(16)).toBe(RECOVERY_MULTIPART_IMAGE_WIDTH);
    expect(first.readUInt32BE(20)).toBe(RECOVERY_MULTIPART_IMAGE_HEIGHT);
    expect(first.subarray(-12).toString("hex")).toBe(
      "0000000049454e44ae426082",
    );

    const idatLength = first.readUInt32BE(33);
    expect(first.subarray(37, 41).toString("ascii")).toBe("IDAT");
    const scanlines = inflateSync(first.subarray(41, 41 + idatLength));
    expect(scanlines.byteLength).toBe(
      (RECOVERY_MULTIPART_IMAGE_WIDTH * 3 + 1) * RECOVERY_MULTIPART_IMAGE_HEIGHT,
    );
    for (
      let offset = 0;
      offset < scanlines.byteLength;
      offset += RECOVERY_MULTIPART_IMAGE_WIDTH * 3 + 1
    ) {
      expect(scanlines[offset]).toBe(0);
    }
  });

  test("uses locale-independent code-point ordering for evidence identities", () => {
    const paths = ["Data/inventory.csv", "Data/Inventory.md"];
    expect(paths.sort(compareCodePointStrings)).toEqual([
      "Data/Inventory.md",
      "Data/inventory.csv",
    ]);
    expect(compareCodePointStrings("I", "i")).toBeLessThan(0);
  });

  test("requires every canonical path, size, and digest while allowing proof notes", () => {
    const manifest = corpusManifest();
    const proof = Buffer.from("# Sync proof\n");
    manifest.push({
      path: "E2E Sync Proof.md",
      size: proof.byteLength,
      sha256: sha256(proof),
    });
    expect(() => assertCanonicalRecoveryCorpusManifest(manifest)).not.toThrow();

    const mutations: Array<(value: RecoveryCorpusFileEntry[]) => void> = [
      (value) =>
        value.splice(
          value.findIndex((entry) => entry.path === RECOVERY_MULTIPART_IMAGE_PATH),
          1,
        ),
      (value) => {
        value.find((entry) => entry.path.endsWith(".svg"))!.size += 1;
      },
      (value) => {
        value.find((entry) => entry.path.endsWith(".pdf"))!.sha256 = "0".repeat(64);
      },
      (value) => {
        value.find((entry) => entry.path === "Home.md")!.path = "Home.txt";
      },
      (value) => value.push({ ...value[0]! }),
    ];
    for (const mutate of mutations) {
      const candidate = structuredClone(manifest);
      mutate(candidate);
      expect(() => assertCanonicalRecoveryCorpusManifest(candidate)).toThrow();
    }
  });

  test("rejects mutated corpus digests and type summaries", () => {
    for (const mutate of [
      (value: any) => (value.manifestSha256 = "0".repeat(64)),
      (value: any) => (value.types[".png"] = 0),
      (value: any) => (value.multipart.minimumPieces = 1),
      (value: any) => (value.files = 13),
      (value: any) => (value.schemaVersion = 1),
    ]) {
      const candidate = canonicalRecoveryCorpusIdentity() as any;
      mutate(candidate);
      expect(() => assertCanonicalRecoveryCorpusIdentity(candidate)).toThrow();
    }
  });
});

function corpusManifest(): RecoveryCorpusFileEntry[] {
  return [...canonicalRecoveryCorpusFiles().entries()]
    .map(([path, bytes]) => ({
      path,
      size: bytes.byteLength,
      sha256: sha256(bytes),
    }))
    .sort((left, right) => compareCodePointStrings(left.path, right.path));
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
