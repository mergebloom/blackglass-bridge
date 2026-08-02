import { lstat, readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  assertReleaseValidationRecord,
  releaseValidationRecordFileName,
  type ReleaseValidationRecord,
} from "./release-validation";
import { isSupportedSemver } from "./semver";
import { compareCodeUnitStrings } from "./stable-json";
import { loadCompatibilityBaseline } from "./release-compatibility";
import { macOSCodeInventoriesEqual } from "./macos-code-inventory";

export type CurrentReleaseRecordRequirement = "optional" | "required";

export interface CurrentReleaseValidationRecord {
  name: string;
  path: string;
  bytes: Buffer;
  record: ReleaseValidationRecord;
}

export async function readCurrentReleaseValidationRecord(
  rootArgument: string,
  requirement: CurrentReleaseRecordRequirement = "optional",
): Promise<CurrentReleaseValidationRecord | null> {
  const root = resolve(rootArgument);
  const packagePath = resolve(root, "package.json");
  const packageFile = await lstat(packagePath);
  if (packageFile.isSymbolicLink() || !packageFile.isFile()) {
    throw new Error("package.json must be a real file");
  }
  const packageMetadata = parseJson(await readFile(packagePath), "package.json");
  const version = packageVersion(packageMetadata);

  const validationDirectory = resolve(root, "docs/validation");
  const validationDirectoryFile = await lstat(validationDirectory);
  if (
    validationDirectoryFile.isSymbolicLink() ||
    !validationDirectoryFile.isDirectory()
  ) {
    throw new Error("docs/validation must be a real directory");
  }

  const prefix = `blackglass-${version}-obsidian-`;
  const suffix = "-qualification.json";
  const names = (await readdir(validationDirectory))
    .filter((name) => name.startsWith(prefix) && name.endsWith(suffix))
    .sort(compareCodeUnitStrings);
  const expectedCount = requirement === "required" ? "exactly one" : "at most one";
  if (names.length > 1 || (requirement === "required" && names.length !== 1)) {
    throw new Error(
      `Expected ${expectedCount} current release qualification record for ${version}`,
    );
  }
  const name = names[0];
  if (!name) return null;

  const path = join(validationDirectory, name);
  const file = await lstat(path);
  if (file.isSymbolicLink() || !file.isFile()) {
    throw new Error("Current release qualification record must be a real file");
  }
  const bytes = await readFile(path);
  if (bytes.at(-1) !== 10) {
    throw new Error("Current release qualification record must end with a newline");
  }
  const value = parseJson(bytes, `Current release qualification record ${name}`);
  assertReleaseValidationRecord(value);
  if (value.blackglassVersion !== version) {
    throw new Error("Current release qualification record has the wrong Blackglass version");
  }
  const expectedName = releaseValidationRecordFileName(
    value.blackglassVersion,
    value.rendererVersion,
  );
  if (name !== expectedName) {
    throw new Error(`Current release qualification record must be named ${expectedName}`);
  }
  const loadedBaseline = await loadCompatibilityBaseline(
    resolve(root, `compatibility/obsidian-${value.rendererVersion}.json`),
  );
  if (
    value.compatibilityBaseline.id !== loadedBaseline.baseline.id ||
    value.compatibilityBaseline.schemaVersion !== loadedBaseline.baseline.schemaVersion ||
    value.compatibilityBaseline.sha256 !== loadedBaseline.sha256 ||
    value.source.officialDmgSha256 !== loadedBaseline.baseline.officialDmgSha256 ||
    JSON.stringify(value.source.appTree) !==
      JSON.stringify(loadedBaseline.baseline.sourceAppTree) ||
    value.source.rendererAsarSha256 !== loadedBaseline.baseline.sourceAsarSha256 ||
    value.source.wrapperAsarSha256 !==
      loadedBaseline.baseline.sourceWrapperAsarSha256 ||
    !macOSCodeInventoriesEqual(
      value.source.macOSCodeInventory,
      loadedBaseline.baseline.sourceMacOSCodeInventory,
    )
  ) {
    throw new Error(
      "Current release qualification record does not bind the reviewed compatibility baseline",
    );
  }
  return { name, path, bytes, record: value };
}

function packageVersion(value: unknown): string {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !("version" in value) ||
    !isSupportedSemver(value.version)
  ) {
    throw new Error("package.json has an invalid version");
  }
  return value.version;
}

function parseJson(bytes: Uint8Array, label: string): unknown {
  try {
    return JSON.parse(Buffer.from(bytes).toString("utf8")) as unknown;
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
}
