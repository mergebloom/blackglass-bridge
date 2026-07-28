import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  analyzeRendererRelease,
  discoverRendererRelease,
  discoverUnpackedJavaScriptFiles,
  loadCompatibilityBaseline,
  type CompatibilityAnchor,
  type CompatibilityBaseline,
  type UnpackedJavaScriptFiles,
} from "../tools/release-compatibility";

const anchors: CompatibilityAnchor[] = [
  {
    id: "control-anchor",
    file: "app.js",
    literal: "CONTROL_ANCHOR",
    expectedMatches: 1,
  },
  {
    id: "renderer-script",
    file: "index.html",
    literal: "app.js",
    expectedMatches: 1,
  },
];

describe("release compatibility baseline", () => {
  test("accepts the exact reviewed artifact", () => {
    const source = rendererArchive(
      'CONTROL_ANCHOR;gw("/user/signin");send({op:"ping"});' +
        'send({op:"push",path:a,size:b});' +
        'x.prototype.onMessage=function(e){var t=e.op;if("ready"===t)return}',
    );
    const baseline = baselineFor(source);
    const report = analyzeRendererRelease(source, {
      baseline,
      sha256: "a".repeat(64),
    });

    expect(report.ready).toBe(true);
    expect(report.syncOperations).toEqual({ ping: 1, push: 1 });
    expect(report.syncMessageShapes).toEqual({
      "ping(op)": 1,
      "push(op,path,size)": 1,
    });
    expect(report.syncInboundOperations).toEqual({ "app.js:ready": 1 });
  });

  test("fails closed on new routes, operations, and message shapes", () => {
    const source = rendererArchive(
      'CONTROL_ANCHOR;gw("/user/signin");send({op:"ping"});' +
        'send({op:"push",path:a,size:b});',
    );
    const changed = rendererArchive(
      'CONTROL_ANCHOR;gw("/user/signin");gw("/vault/future");' +
        'send({op:"ping"});send({op:"push",path:a,size:b,pieces:c});' +
        'send({op:"future"});',
    );
    const report = analyzeRendererRelease(changed, {
      baseline: baselineFor(source),
      sha256: "b".repeat(64),
    });

    expect(report.ready).toBe(false);
    expect(failedChecks(report)).toEqual(
      expect.arrayContaining([
        "source-asar-sha256",
        "key-files",
        "control-plane-routes",
        "sync-operations",
        "sync-message-shapes",
      ]),
    );
    expect(report.controlPlaneRoutes).toHaveProperty("/vault/future", 1);
    expect(report.syncOperations).toHaveProperty("future", 1);
  });

  test("fails closed on removed routes and operations", () => {
    const source = rendererArchive(
      'CONTROL_ANCHOR;gw("/user/signin");gw("/vault/list");' +
        'send({op:"ping"});send({op:"size"});',
    );
    const changed = rendererArchive(
      'CONTROL_ANCHOR;gw("/user/signin");send({op:"ping"});',
    );
    const report = analyzeRendererRelease(changed, {
      baseline: baselineFor(source),
      sha256: "c".repeat(64),
    });

    expect(report.ready).toBe(false);
    expect(failedChecks(report)).toEqual(
      expect.arrayContaining(["control-plane-routes", "sync-operations"]),
    );
  });

  test("records literal operation properties separately from message shapes", () => {
    const source = rendererArchive(
      'CONTROL_ANCHOR;gw("/user/signin");send({path:a,op:"push"});',
    );
    const discovered = discoverRendererRelease(source, anchors);
    expect(discovered.syncOperations).toEqual({ push: 1 });
    expect(discovered.syncMessageShapes).toEqual({});
  });

  test("covers protocol signals and identity changes in secondary JavaScript", () => {
    const source = rendererArchive(
      'CONTROL_ANCHOR;gw("/user/signin");send({op:"ping"});',
      {
        "secondary.mjs":
          'send({op:"future",path:a});x.prototype.onMessage=function(e){var n=e.op;if(n==="ack")return}',
        "worker.cjs": 'gw("/vault/from-worker");send({op:"worker",path:a});',
      },
    );
    const changed = rendererArchive(
      'CONTROL_ANCHOR;gw("/user/signin");send({op:"ping"});',
      {
        "secondary.mjs": 'send({op:"future",path:a,hash:b});',
        "worker.cjs": 'gw("/vault/from-worker");send({op:"worker",path:a});',
      },
    );
    const discovery = discoverRendererRelease(source, anchors);
    expect(discovery.syncOperationLocations["secondary.mjs:future"]).toBe(1);
    expect(discovery.syncInboundOperations["secondary.mjs:ack"]).toBe(1);
    expect(discovery.controlPlaneRoutes["/vault/from-worker"]).toBe(1);
    expect(discovery.syncOperationLocations["worker.cjs:worker"]).toBe(1);
    expect(failedChecks(analyzeRendererRelease(changed, {
      baseline: baselineFor(source),
      sha256: "e".repeat(64),
    }))).toEqual(expect.arrayContaining([
      "source-asar-sha256",
      "javascript-files",
      "sync-message-shapes",
      "sync-message-shape-locations",
      "sync-inbound-operations",
    ]));
  });

  test("fails closed on unpacked JavaScript additions, removals, and changes", async () => {
    const resources = await mkdtemp(join(tmpdir(), "blackglass-unpacked-js-"));
    try {
      const nativeRoot = join(resources, "app.asar.unpacked/node_modules/native");
      await mkdir(nativeRoot, { recursive: true });
      const shim = join(nativeRoot, "index.js");
      await writeFile(shim, "module.exports = require('./binding.node');\n");
      const source = rendererArchive(
        'CONTROL_ANCHOR;gw("/user/signin");send({op:"ping"});',
      );
      const reviewed = await discoverUnpackedJavaScriptFiles(resources);
      const baseline = baselineFor(source, reviewed);
      expect(analyzeRendererRelease(source, { baseline, sha256: "f".repeat(64) }, reviewed).ready)
        .toBe(true);

      await writeFile(shim, "module.exports = require('./changed.node');\n");
      expect(failedChecks(analyzeRendererRelease(source, {
        baseline,
        sha256: "f".repeat(64),
      }, await discoverUnpackedJavaScriptFiles(resources)))).toContain(
        "unpacked-javascript-files",
      );

      await writeFile(shim, "module.exports = require('./binding.node');\n");
      await writeFile(join(nativeRoot, "extra.mjs"), "export default true;\n");
      expect(failedChecks(analyzeRendererRelease(source, {
        baseline,
        sha256: "f".repeat(64),
      }, await discoverUnpackedJavaScriptFiles(resources)))).toContain(
        "unpacked-javascript-files",
      );

      await rm(join(nativeRoot, "extra.mjs"));
      await rm(shim);
      expect(failedChecks(analyzeRendererRelease(source, {
        baseline,
        sha256: "f".repeat(64),
      }, await discoverUnpackedJavaScriptFiles(resources)))).toContain(
        "unpacked-javascript-files",
      );
    } finally {
      await rm(resources, { recursive: true, force: true });
    }
  });

  test("requires every unpacked JavaScript path to be explicitly reviewed", async () => {
    const directory = await mkdtemp(join(tmpdir(), "blackglass-unpacked-review-"));
    try {
      const baseline = baselineFor(
        rendererArchive('CONTROL_ANCHOR;gw("/user/signin");send({op:"ping"});'),
        {
          "app.asar.unpacked/node_modules/native/index.js": {
            bytes: 1,
            sha256: "a".repeat(64),
          },
        },
      );
      baseline.unpackedJavaScriptReview.reviewedPaths = [];
      const path = join(directory, "compatibility.json");
      await writeFile(path, `${JSON.stringify(baseline)}\n`);

      await expect(loadCompatibilityBaseline(path)).rejects.toThrow(
        "must explicitly mark every unpacked JavaScript file reviewed",
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

function failedChecks(
  report: ReturnType<typeof analyzeRendererRelease>,
): string[] {
  return report.checks.filter((item) => !item.ready).map((item) => item.id);
}

function baselineFor(
  source: Buffer,
  unpackedJavaScriptFiles: UnpackedJavaScriptFiles = {},
): CompatibilityBaseline {
  const discovered = discoverRendererRelease(
    source,
    anchors,
    unpackedJavaScriptFiles,
  );
  return {
    schemaVersion: 3,
    id: "synthetic-release",
    rendererVersion: discovered.rendererVersion,
    officialDmgSha256: "c".repeat(64),
    sourceAppTree: {
      formatVersion: 1,
      sha256: "b".repeat(64),
      entries: 1,
      files: 1,
      directories: 0,
      symlinks: 0,
      fileBytes: 1,
    },
    sourceAsarSha256: discovered.sourceAsarSha256,
    sourceWrapperAsarSha256: "d".repeat(64),
    keyFiles: discovered.keyFiles,
    javaScriptFiles: discovered.javaScriptFiles,
    unpackedJavaScriptFiles: discovered.unpackedJavaScriptFiles,
    unpackedJavaScriptReview: {
      status: "reviewed",
      reviewedPaths: Object.keys(discovered.unpackedJavaScriptFiles),
    },
    anchors,
    controlPlaneRoutes: discovered.controlPlaneRoutes,
    syncOperations: discovered.syncOperations,
    syncOperationLocations: discovered.syncOperationLocations,
    syncMessageShapes: discovered.syncMessageShapes,
    syncMessageShapeLocations: discovered.syncMessageShapeLocations,
    syncInboundOperations: discovered.syncInboundOperations,
  };
}

function rendererArchive(
  appJs: string,
  additionalFiles: Record<string, string> = {},
): Buffer {
  return makeArchive({
    "app.js": Buffer.from(appJs),
    "main.js": Buffer.from("desktop main"),
    "index.html": Buffer.from('<script src="app.js"></script>'),
    "package.json": Buffer.from(JSON.stringify({ version: "1.12.7" })),
    ...Object.fromEntries(
      Object.entries(additionalFiles).map(([path, value]) => [path, Buffer.from(value)]),
    ),
  });
}

function makeArchive(files: Record<string, Buffer>): Buffer {
  let offset = 0;
  const nodes: Record<string, unknown> = {};
  const payloads: Buffer[] = [];
  for (const [name, contents] of Object.entries(files)) {
    nodes[name] = {
      size: contents.length,
      offset: String(offset),
      integrity: {
        algorithm: "SHA256",
        hash: createHash("sha256").update(contents).digest("hex"),
      },
    };
    payloads.push(contents);
    offset += contents.length;
  }
  const json = Buffer.from(JSON.stringify({ files: nodes }), "utf8");
  const paddedStringLength = (json.length + 3) & ~3;
  const headerPayloadSize = 4 + paddedStringLength;
  const headerPickleSize = 4 + headerPayloadSize;
  const header = Buffer.alloc(8 + headerPickleSize);
  header.writeUInt32LE(4, 0);
  header.writeUInt32LE(headerPickleSize, 4);
  header.writeUInt32LE(headerPayloadSize, 8);
  header.writeUInt32LE(json.length, 12);
  json.copy(header, 16);
  return Buffer.concat([header, ...payloads]);
}
