import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, posix, relative, resolve, sep } from "node:path";
import { compareCodeUnitStrings, stableJson } from "./stable-json";

export const PUBLISH_RUNTIME_SCHEMA_VERSION = 1 as const;
export const PUBLISH_RUNTIME_ENTRYPOINTS = ["app.js", "app.css"] as const;
export const PUBLISH_RUNTIME_ROUTE_ANCHORS = [
  "/access/",
  "/cache/",
  "/options/",
] as const;

const DATA_ROUTES = new Set(["/access/", "/cache/", "/options/", "/pw", "/search"]);
const STATIC_ROOTS = ["/lib/", "/public/", "/sim.js", "/worker.js"];

export interface PublishRuntimeAssetIdentity {
  path: string;
  bytes: number;
  sha256: string;
}

export interface PublishRuntimeManifest {
  schemaVersion: typeof PUBLISH_RUNTIME_SCHEMA_VERSION;
  generatedBy: "tools/inspect-publish-runtime.ts";
  assets: PublishRuntimeAssetIdentity[];
  entrypoints: Record<(typeof PUBLISH_RUNTIME_ENTRYPOINTS)[number], string>;
  routeAnchors: Record<(typeof PUBLISH_RUNTIME_ROUTE_ANCHORS)[number], number>;
  dataRoutes: string[];
  externalOrigins: string[];
  runtimeSha256: string;
}

export async function inspectPublishRuntime(
  runtimeRoot: string,
): Promise<PublishRuntimeManifest> {
  const root = await canonicalDirectory(runtimeRoot);
  const appJs = await readRuntimeFile(root, "app.js");
  const appCss = await readRuntimeFile(root, "app.css");
  const appJsText = appJs.bytes.toString("utf8");
  const appCssText = appCss.bytes.toString("utf8");

  const routeAnchors = Object.fromEntries(
    PUBLISH_RUNTIME_ROUTE_ANCHORS.map((anchor) => [anchor, countOccurrences(appJsText, anchor)]),
  ) as PublishRuntimeManifest["routeAnchors"];
  for (const anchor of PUBLISH_RUNTIME_ROUTE_ANCHORS) {
    if (routeAnchors[anchor] !== 1) {
      throw new Error(
        `Publish runtime route anchor ${anchor} must occur exactly once; found ${routeAnchors[anchor]}`,
      );
    }
  }

  const discoveredPaths = new Set<string>(PUBLISH_RUNTIME_ENTRYPOINTS);
  for (const path of discoverJavaScriptPaths(appJsText)) discoveredPaths.add(path);
  for (const path of discoverCssPaths(appCssText)) discoveredPaths.add(path);

  const assets: PublishRuntimeAssetIdentity[] = [];
  for (const path of [...discoveredPaths].sort(compareCodeUnitStrings)) {
    const file = await readRuntimeFile(root, path);
    assets.push({ path, bytes: file.bytes.byteLength, sha256: sha256(file.bytes) });
  }

  const dataRoutes = [...DATA_ROUTES]
    .filter((route) => appJsText.includes(route))
    .sort(compareCodeUnitStrings);
  const externalOrigins = discoverExternalOrigins(`${appJsText}\n${appCssText}`);
  const unsigned = {
    schemaVersion: PUBLISH_RUNTIME_SCHEMA_VERSION,
    generatedBy: "tools/inspect-publish-runtime.ts" as const,
    assets,
    entrypoints: {
      "app.js": sha256(appJs.bytes),
      "app.css": sha256(appCss.bytes),
    },
    routeAnchors,
    dataRoutes,
    externalOrigins,
  };
  return {
    ...unsigned,
    runtimeSha256: sha256(Buffer.from(stableJson(unsigned))),
  };
}

export function verifyPublishRuntimeManifest(
  expected: PublishRuntimeManifest,
  actual: PublishRuntimeManifest,
): void {
  if (stableJson(expected) !== stableJson(actual)) {
    throw new Error("Publish runtime differs from the reviewed source-bound manifest");
  }
}

function discoverJavaScriptPaths(source: string): string[] {
  const paths = new Set<string>();
  for (const match of source.matchAll(/["'](\/(?:lib|public)\/[A-Za-z0-9._/?=&%-]+|\/(?:sim|worker)\.js(?:\?[^"']*)?)["']/gu)) {
    paths.add(normalizeAssetPath(match[1]!));
  }
  return [...paths].sort(compareCodeUnitStrings);
}

function discoverCssPaths(source: string): string[] {
  const paths = new Set<string>();
  for (const match of source.matchAll(/url\(\s*["']?(\/public\/[A-Za-z0-9._/?=&%-]+)["']?\s*\)/gu)) {
    paths.add(normalizeAssetPath(match[1]!));
  }
  return [...paths].sort(compareCodeUnitStrings);
}

function normalizeAssetPath(input: string): string {
  const withoutQuery = input.split(/[?#]/u, 1)[0]!;
  if (!withoutQuery.startsWith("/") || withoutQuery.includes("\\") || withoutQuery.includes("\0")) {
    throw new Error(`Unsafe Publish runtime asset path: ${JSON.stringify(input)}`);
  }
  const normalized = posix.normalize(withoutQuery);
  if (normalized !== withoutQuery || normalized === "/" || normalized.startsWith("/../")) {
    throw new Error(`Non-canonical Publish runtime asset path: ${JSON.stringify(input)}`);
  }
  if (!STATIC_ROOTS.some((root) => normalized === root || normalized.startsWith(root))) {
    throw new Error(`Unexpected Publish runtime asset path: ${JSON.stringify(input)}`);
  }
  return normalized.slice(1);
}

function discoverExternalOrigins(source: string): string[] {
  const origins = new Set<string>();
  for (const match of source.matchAll(/https:\/\/[A-Za-z0-9.-]+(?::\d+)?/gu)) {
    origins.add(new URL(match[0]).origin);
  }
  return [...origins].sort(compareCodeUnitStrings);
}

async function canonicalDirectory(path: string): Promise<string> {
  const absolute = resolve(path);
  const info = await lstat(absolute);
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(absolute) !== absolute) {
    throw new Error("Publish runtime root must be a canonical real directory");
  }
  return absolute;
}

async function readRuntimeFile(
  root: string,
  requestedPath: string,
): Promise<{ bytes: Buffer }> {
  if (isAbsolute(requestedPath)) throw new Error("Publish runtime asset paths must be relative");
  const target = resolve(root, requestedPath);
  const relativePath = relative(root, target);
  if (
    relativePath === "" ||
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    throw new Error(`Publish runtime asset escapes its root: ${requestedPath}`);
  }
  const info = await lstat(target);
  if (!info.isFile() || info.isSymbolicLink() || await realpath(target) !== target) {
    throw new Error(`Publish runtime asset must be a canonical real file: ${requestedPath}`);
  }
  return { bytes: await readFile(target) };
}

function countOccurrences(source: string, value: string): number {
  let count = 0;
  let offset = 0;
  while ((offset = source.indexOf(value, offset)) !== -1) {
    count += 1;
    offset += value.length;
  }
  return count;
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
