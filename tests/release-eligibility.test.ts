import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import {
  readCurrentReleaseValidationRecord,
  readCurrentReleaseValidationRecords,
} from "../tools/current-release-record";
import { assertCurrentRecordsHaveExactMatrixRows } from "../tools/verify-release-eligibility";
import type { Matrix } from "../tools/compatibility-matrix";

const repositoryRoot = resolve(import.meta.dir, "..");

describe("current release qualification selection", () => {
  test("normal validation permits no current record while release eligibility does not", async () => {
    const root = await createRoot();
    try {
      expect(await readCurrentReleaseValidationRecord(root, "optional")).toBeNull();
      await expect(
        readCurrentReleaseValidationRecord(root, "required"),
      ).rejects.toThrow("Expected at least one current release qualification record");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("plural selection validates every current renderer record", async () => {
    const root = await createRoot();
    try {
      for (const rendererVersion of ["1.12.7", "1.12.8"]) {
        await writeFile(
          join(
            root,
            "docs/validation",
            `blackglass-0.1.1-obsidian-${rendererVersion}-qualification.json`,
          ),
          "{}\n",
        );
      }
      await expect(
        readCurrentReleaseValidationRecords(root, "required"),
      ).rejects.toThrow("Invalid release validation record");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("normal validation fully parses and validates a present record", async () => {
    const root = await createRoot();
    try {
      await writeFile(
        join(
          root,
          "docs/validation/blackglass-0.1.1-obsidian-1.12.7-qualification.json",
        ),
        "{}\n",
      );
      await expect(
        readCurrentReleaseValidationRecord(root, "optional"),
      ).rejects.toThrow("Invalid release validation record");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("routes tag publishing through the explicit eligibility command", async () => {
    const packageMetadata = JSON.parse(
      await readFile(join(repositoryRoot, "package.json"), "utf8"),
    ) as { scripts: Record<string, string> };
    const workflow = await readFile(
      join(repositoryRoot, ".github/workflows/release.yml"),
      "utf8",
    );
    expect(packageMetadata.scripts["release:verify-eligibility"]).toBe(
      "bun run tools/verify-release-eligibility.ts",
    );
    expect(workflow).toContain(
      'run: bun run release:verify-eligibility -- "$GITHUB_SHA"',
    );
  });

  test("retains historical same-renderer rows while selecting the exact current identity", () => {
    const bytes = Buffer.from("current\n");
    const record = {
      rendererVersion: "1.12.7", blackglassVersion: "0.4.0",
      toolingSource: { gitRevision: "b".repeat(40) },
      source: { officialDmgSha256: "d".repeat(64) },
      artifacts: { server: { version: "0.5.0", sourceRevision: "s".repeat(40) } },
    } as any;
    const current = [{ name: "current.json", path: "/current.json", bytes, record }];
    const exact = {
      rendererVersion: "1.12.7", upstreamArtifact: { kind: "official-dmg", sha256: "d".repeat(64) },
      bridge: { version: "0.4.0", revision: "b".repeat(40) },
      server: { version: "0.5.0", revision: "s".repeat(40) },
      validationReport: {
        path: "docs/validation/current.json",
        sha256: createHash("sha256").update(bytes).digest("hex"),
      },
    } as any;
    const historical = {
      ...exact,
      bridge: { version: "0.3.0", revision: "a".repeat(40) },
      validationReport: { path: "docs/validation/historical.json", sha256: "e".repeat(64) },
    };
    expect(() => assertCurrentRecordsHaveExactMatrixRows(current as any, {
      schemaVersion: 2, requiredScenarios: [], entries: [historical, exact],
    } as Matrix)).not.toThrow();
    expect(() => assertCurrentRecordsHaveExactMatrixRows(current as any, {
      schemaVersion: 2, requiredScenarios: [], entries: [historical],
    } as Matrix)).toThrow("does not exactly bind");
  });
});

async function createRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "blackglass-release-record-"));
  await mkdir(join(root, "docs/validation"), { recursive: true });
  await writeFile(join(root, "package.json"), '{"version":"0.1.1"}\n');
  return root;
}
