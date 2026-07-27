import { createHash } from "node:crypto";
import { AsarArchive } from "./asar.ts";

interface AnchorResult {
  description: string;
  matches: number;
  expected: number;
  ready: boolean;
}

function countLiteral(haystack: string, needle: string): number {
  if (!needle) {
    return 0;
  }
  let count = 0;
  let cursor = 0;
  while ((cursor = haystack.indexOf(needle, cursor)) !== -1) {
    count += 1;
    cursor += needle.length;
  }
  return count;
}

function collectMatches(input: string, pattern: RegExp): string[] {
  return [...input.matchAll(pattern)]
    .map((match) => match[1])
    .filter((value): value is string => value !== undefined);
}

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

function anchor(
  description: string,
  input: string,
  literal: string,
  expected = 1,
): AnchorResult {
  const matches = countLiteral(input, literal);
  return {
    description,
    matches,
    expected,
    ready: matches === expected,
  };
}

const asarPath = Bun.argv[2];
if (!asarPath) {
  console.error("Usage: bun run tools/analyze-release.ts <path-to-obsidian.asar>");
  process.exit(2);
}

const archive = await AsarArchive.open(asarPath);
const appJsBuffer = archive.read("app.js");
const mainJsBuffer = archive.read("main.js");
const indexHtmlBuffer = archive.read("index.html");
const packageJsonBuffer = archive.read("package.json");

const appJs = appJsBuffer.toString("utf8");
const mainJs = mainJsBuffer.toString("utf8");
const packageJson = JSON.parse(packageJsonBuffer.toString("utf8")) as {
  version?: string;
};

const routes = uniqueSorted(
  collectMatches(appJs, /gw\("(\/[A-Za-z0-9_./-]+)/gu),
);
const syncOperations = uniqueSorted(
  collectMatches(
    appJs,
    /op:"(init|ping|push|pull|history|restore|deleted|purge|size|usernames)"/gu,
  ),
);

const anchors = [
  anchor(
    "control-plane origin constructor",
    appJs,
    'String.fromCharCode(97,112,105),"obsidian","md"',
  ),
  anchor(
    "Sync WebSocket hostname authorization",
    appJs,
    '!oee.call(h,".obsidian.md")&&"127.0.0.1"!==h',
  ),
  anchor(
    "loopback control-plane development endpoint",
    appJs,
    "http://127.0.0.1:3000",
  ),
  anchor(
    "loopback Sync data-plane development endpoint",
    appJs,
    "127.0.0.1:3003",
  ),
  anchor("renderer script reference", indexHtmlBuffer.toString("utf8"), "app.js"),
  anchor("desktop is-dev IPC handler", mainJs, 'ipcMain.on("is-dev"'),
];

const files = archive
  .entries()
  .filter((entry) => !entry.node.files)
  .map((entry) => ({
    path: entry.path,
    size: entry.node.size ?? null,
    unpacked: entry.node.unpacked ?? false,
    integrity: entry.node.integrity?.hash ?? null,
  }));

const report = {
  formatVersion: 1,
  artifact: {
    path: asarPath,
    sha256: createHash("sha256").update(archive.buffer).digest("hex"),
    size: archive.buffer.length,
    dataOffset: archive.dataOffset,
  },
  packageVersion: packageJson.version ?? null,
  keyFiles: {
    "app.js": appJsBuffer.length,
    "main.js": mainJsBuffer.length,
    "index.html": indexHtmlBuffer.length,
    "package.json": packageJsonBuffer.length,
  },
  clientPatchReadiness: {
    ready: anchors.every((item) => item.ready),
    anchors,
  },
  controlPlaneRoutes: routes,
  syncOperations,
  fileCount: files.length,
  files,
};

console.log(JSON.stringify(report, null, 2));
if (!report.clientPatchReadiness.ready) {
  process.exitCode = 1;
}
