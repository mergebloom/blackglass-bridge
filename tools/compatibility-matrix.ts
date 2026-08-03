import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { E2E_SCENARIO_IDS, parseE2EScenarioId, scenarioValidationFileName } from "./e2e-scenario";
import { isSupportedSemver, isSupportedStableSemver } from "./semver";
import { validateMatrixScenarioReport } from "./compatibility-matrix-entry";
import { assertReleaseValidationRecord, type ReleaseValidationRecord } from "./release-validation";

if (import.meta.main) {
  const [mode = "--check", ...extra] = Bun.argv.slice(2);
  if ((mode !== "--check" && mode !== "--write") || extra.length !== 0) {
    throw new Error("Usage: bun run tools/compatibility-matrix.ts [--check|--write]");
  }
  const matrix = await verifyCompatibilityMatrix(resolve(import.meta.dir, ".."), mode);
  console.log(`compatibility matrix verified: ${matrix.entries.length} exact supported combination(s)`);
}

export interface Matrix {
  schemaVersion: 2;
  requiredScenarios: string[];
  entries: Array<{
    rendererVersion: string;
    upstreamArtifact: { kind: "official-dmg"; sha256: string };
    bridge: { version: string; revision: string };
    server: { version: string; revision: string };
    platform: { operatingSystem: "macOS"; architecture: "arm64" };
    scenarios: Array<{ id: string; result: "passed"; report: { path: string; sha256: string } }>;
    qualificationResult: "supported";
    validationReport: { path: string; sha256: string };
    qualifiedAt: string;
    knownLimitations: string[];
  }>;
}

export async function verifyCompatibilityMatrix(
  rootArgument: string,
  mode: "--check" | "--write" = "--check",
): Promise<Matrix> {
  const root = resolve(rootArgument);
  const sourcePath = resolve(root, "compatibility/matrix.json");
  const documentPath = resolve(root, "compatibility/MATRIX.md");
  const matrix = JSON.parse(await readFile(sourcePath, "utf8")) as Matrix;
  assertMatrix(matrix);
  await validateMatrixFiles(root, matrix);
  const document = render(matrix);
  if (mode === "--write") {
    await writeFile(documentPath, document, { mode: 0o644 });
  } else if (await readFile(documentPath, "utf8") !== document) {
    throw new Error("Human compatibility matrix drifted from compatibility/matrix.json");
  }
  return matrix;
}

function assertMatrix(value: Matrix): void {
  if (value.schemaVersion !== 2 || !Array.isArray(value.requiredScenarios) || !Array.isArray(value.entries)) {
    throw new Error("Compatibility matrix is malformed");
  }
  if (JSON.stringify(value.requiredScenarios) !== JSON.stringify(E2E_SCENARIO_IDS)) {
    throw new Error("Compatibility matrix required scenarios drifted from the conformance suite");
  }
  const keys = new Set<string>();
  for (const entry of value.entries) {
    if (
      !isSupportedStableSemver(entry.rendererVersion) ||
      entry.upstreamArtifact?.kind !== "official-dmg" || !sha(entry.upstreamArtifact.sha256) ||
      !isSupportedSemver(entry.bridge?.version) || !revision(entry.bridge?.revision) ||
      !isSupportedSemver(entry.server?.version) || !revision(entry.server?.revision) ||
      entry.platform?.operatingSystem !== "macOS" || entry.platform.architecture !== "arm64" ||
      entry.qualificationResult !== "supported" || !Array.isArray(entry.scenarios) ||
      entry.scenarios.length !== value.requiredScenarios.length ||
      !entry.validationReport?.path.startsWith("docs/validation/") ||
      !sha(entry.validationReport.sha256) || !Number.isFinite(Date.parse(entry.qualifiedAt)) ||
      !Array.isArray(entry.knownLimitations)
    ) throw new Error("Compatibility matrix entry is malformed");
    const scenarioIds = entry.scenarios.map((scenario) => {
      parseE2EScenarioId(scenario.id);
      if (scenario.result !== "passed" ||
        !scenario.report?.path.startsWith("docs/validation/") ||
        !sha(scenario.report.sha256)) {
        throw new Error("Compatibility matrix contains an unpassed scenario");
      }
      return scenario.id;
    });
    if (JSON.stringify(scenarioIds) !== JSON.stringify(value.requiredScenarios)) {
      throw new Error("Supported compatibility row does not contain the complete required suite");
    }
    const key = `${entry.rendererVersion}\0${entry.bridge.revision}\0${entry.server.revision}`;
    if (keys.has(key)) throw new Error("Compatibility matrix contains a duplicate combination");
    keys.add(key);
  }
}

function render(matrix: Matrix): string {
  const preamble = "# Compatibility matrix\n\n" +
    "This file is generated from `compatibility/matrix.json`. Run\n" +
    "`bun run compatibility:check` to detect drift.\n\n";
  if (matrix.entries.length === 0) {
    return preamble +
      "No renderer/Bridge/Server combination currently has all four source-bound\n" +
      "release, tenancy, custom-E2EE, and managed-encryption reports in this source\n" +
      "revision. Existing historical scenario evidence remains preserved, but is not\n" +
      "promoted into a complete support claim.\n";
  }
  const lines = [
    "| Renderer | Upstream DMG SHA-256 | Bridge | Server | Platform | Result | Qualified | Report | Limitations |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const entry of matrix.entries) {
    lines.push(`| ${entry.rendererVersion} | \`${entry.upstreamArtifact.sha256}\` | ` +
      `${entry.bridge.version} \`${entry.bridge.revision}\` | ${entry.server.version} ` +
      `\`${entry.server.revision}\` | macOS arm64 | supported (${entry.scenarios.length}/${matrix.requiredScenarios.length}) | ` +
      `${entry.qualifiedAt.slice(0, 10)} | [validation report](../${entry.validationReport.path}) | ` +
      `${entry.knownLimitations.join("; ") || "None recorded"} |`);
  }
  return `${preamble}${lines.join("\n")}\n`;
}

async function validateMatrixFiles(root: string, matrix: Matrix): Promise<void> {
  for (const entry of matrix.entries) {
    const report = await readFile(resolve(root, entry.validationReport.path));
    if (createHash("sha256").update(report).digest("hex") !== entry.validationReport.sha256) {
      throw new Error("Compatibility matrix validation report identity changed");
    }
    const record = JSON.parse(report.toString("utf8")) as ReleaseValidationRecord;
    assertReleaseValidationRecord(record);
    if (
      record.rendererVersion !== entry.rendererVersion ||
      record.blackglassVersion !== entry.bridge.version ||
      record.toolingSource.gitRevision !== entry.bridge.revision ||
      record.artifacts.server.version !== entry.server.version ||
      record.artifacts.server.sourceRevision !== entry.server.revision
    ) {
      throw new Error("Compatibility matrix validation report does not bind its row");
    }
    const scenarioRunHashes = new Set<string>();
    for (const scenario of entry.scenarios) {
      const expectedName = scenarioValidationFileName(
        scenario.id,
        entry.rendererVersion,
        entry.bridge.version,
        entry.bridge.revision,
        entry.server.revision,
      );
      if (basename(scenario.report.path) !== expectedName) {
        throw new Error(`Compatibility matrix scenario report must be named ${expectedName}`);
      }
      const scenarioBytes = await readFile(resolve(root, scenario.report.path));
      if (createHash("sha256").update(scenarioBytes).digest("hex") !== scenario.report.sha256) {
        throw new Error("Compatibility matrix scenario report identity changed");
      }
      const validated = validateMatrixScenarioReport(
        JSON.parse(scenarioBytes.toString("utf8")) as unknown,
        scenario.id,
        record,
      );
      scenarioRunHashes.add(validated.runManifestSha256);
    }
    if (scenarioRunHashes.size !== matrix.requiredScenarios.length) {
      throw new Error("Compatibility matrix scenarios do not use distinct immutable runs");
    }
    const baseline = JSON.parse(await readFile(
      resolve(root, `compatibility/obsidian-${entry.rendererVersion}.json`),
      "utf8",
    )) as { officialDmgSha256?: unknown };
    if (baseline.officialDmgSha256 !== entry.upstreamArtifact.sha256) {
      throw new Error("Compatibility matrix upstream artifact differs from the reviewed baseline");
    }
  }
}

function sha(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}
function revision(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{40}$/u.test(value);
}
