import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import {
  RECOVERY_CORPUS_ID,
  RECOVERY_CORPUS_MANIFEST_SHA256,
  RECOVERY_CORPUS_SCHEMA_VERSION,
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
      files: 13,
      bytes: 5_899,
      manifestSha256:
        "6c761cf6226399283726fc29036e2ec35b961c106a18c3fbd8fd36da70e81d68",
      types: {
        ".canvas": 1,
        ".csv": 1,
        ".js": 1,
        ".json": 1,
        ".md": 6,
        ".pdf": 1,
        ".png": 1,
        ".svg": 1,
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
      (value) => value.splice(value.findIndex((entry) => entry.path.endsWith(".png")), 1),
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
      (value: any) => (value.files = 12),
      (value: any) => (value.schemaVersion = 2),
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
