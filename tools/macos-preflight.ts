import { lstat, mkdtemp, rmdir, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  BLACKGLASS_BUNDLE_IDENTIFIER,
  OBSIDIAN_BUNDLE_IDENTIFIER,
  type MacOSLaunchPreflightSnapshot,
} from "./macos-launch-smoke";
import { pathExists } from "./path-safety";

export async function inspectMacOSLaunchPreflight(): Promise<MacOSLaunchPreflightSnapshot> {
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    throw new Error("macOS launch preflight requires Apple Silicon macOS");
  }
  const helperRoot = await mkdtemp("/private/tmp/blackglass-preflight-");
  const helperPath = join(helperRoot, "macos-launch-preflight");
  let snapshot: MacOSLaunchPreflightSnapshot | undefined;
  let primaryError: Error | undefined;
  try {
    const helperRootStat = await lstat(helperRoot);
    if (
      !helperRootStat.isDirectory() ||
      helperRootStat.isSymbolicLink() ||
      (helperRootStat.mode & 0o777) !== 0o700 ||
      helperRootStat.uid !== process.getuid!()
    ) {
      throw new Error("Disposable macOS launch preflight directory is not private");
    }
    const source = resolve(import.meta.dir, "macos-launch-preflight.m");
    const compiled = Bun.spawnSync([
      "/usr/bin/xcrun",
      "clang",
      "-fobjc-arc",
      "-Wall",
      "-Wextra",
      "-Werror",
      "-framework",
      "AppKit",
      "-framework",
      "CoreGraphics",
      "-lproc",
      source,
      "-o",
      helperPath,
    ], { stdout: "pipe", stderr: "pipe" });
    if (compiled.exitCode !== 0) {
      throw new Error(
        `Unable to compile macOS launch preflight helper: ${compiled.stderr.toString("utf8").trim()}`,
      );
    }
    const helperStat = await lstat(helperPath);
    if (!helperStat.isFile() || helperStat.isSymbolicLink()) {
      throw new Error("Compiled macOS launch preflight helper is not a real file");
    }
    const inspected = Bun.spawnSync(
      [helperPath, BLACKGLASS_BUNDLE_IDENTIFIER, OBSIDIAN_BUNDLE_IDENTIFIER],
      { stdout: "pipe", stderr: "pipe" },
    );
    if (inspected.exitCode !== 0) {
      throw new Error(
        `Unable to inspect macOS launch preflight state (exit ${inspected.exitCode}): ` +
          inspected.stderr.toString("utf8").trim(),
      );
    }
    const value = JSON.parse(inspected.stdout.toString("utf8")) as unknown;
    if (!isSnapshot(value)) {
      throw new Error("macOS launch preflight returned malformed JSON");
    }
    snapshot = value;
  } catch (error) {
    primaryError = asError(error);
  }

  const cleanupErrors: Error[] = [];
  try {
    if (await pathExists(helperPath)) await unlink(helperPath);
  } catch (error) {
    cleanupErrors.push(new Error(`Unable to remove launch preflight helper: ${asError(error).message}`));
  }
  try {
    await rmdir(helperRoot);
  } catch (error) {
    cleanupErrors.push(
      new Error(`Unable to remove launch preflight directory: ${asError(error).message}`),
    );
  }
  if (primaryError) {
    if (cleanupErrors.length > 0) {
      throw new AggregateError([primaryError, ...cleanupErrors], "macOS launch preflight failed");
    }
    throw primaryError;
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, "macOS launch preflight cleanup failed");
  }
  if (!snapshot) throw new Error("macOS launch preflight produced no snapshot");
  return snapshot;
}

function isSnapshot(value: unknown): value is MacOSLaunchPreflightSnapshot {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    "screenLocked" in value && typeof value.screenLocked === "boolean" &&
    "applications" in value && Array.isArray(value.applications);
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
