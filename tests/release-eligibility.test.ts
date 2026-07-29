import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readCurrentReleaseValidationRecord } from "../tools/current-release-record";

const repositoryRoot = resolve(import.meta.dir, "..");

describe("current release qualification selection", () => {
  test("normal validation permits no current record while release eligibility does not", async () => {
    const root = await createRoot();
    try {
      expect(await readCurrentReleaseValidationRecord(root, "optional")).toBeNull();
      await expect(
        readCurrentReleaseValidationRecord(root, "required"),
      ).rejects.toThrow("Expected exactly one current release qualification record");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("both modes reject multiple current records", async () => {
    const root = await createRoot();
    try {
      for (const rendererVersion of ["1.12.7", "1.12.8"]) {
        await writeFile(
          join(
            root,
            "docs/validation",
            `blackglass-bridge-0.1.1-obsidian-${rendererVersion}-qualification.json`,
          ),
          "{}\n",
        );
      }
      await expect(
        readCurrentReleaseValidationRecord(root, "optional"),
      ).rejects.toThrow("Expected at most one current release qualification record");
      await expect(
        readCurrentReleaseValidationRecord(root, "required"),
      ).rejects.toThrow("Expected exactly one current release qualification record");
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
          "docs/validation/blackglass-bridge-0.1.1-obsidian-1.12.7-qualification.json",
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
});

async function createRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "blackglass-release-record-"));
  await mkdir(join(root, "docs/validation"), { recursive: true });
  await writeFile(join(root, "package.json"), '{"version":"0.1.1"}\n');
  return root;
}
