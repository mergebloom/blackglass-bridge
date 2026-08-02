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
import type { MacOSCodeInventory } from "../tools/macos-code-inventory";
import { stableJson } from "../tools/stable-json";

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
  test("rejects noncanonical renderer semantic versions", () => {
    for (const version of [
      "01.12.7",
      "1.02.7",
      "1.12.07",
      "1.12.7-alpha",
      "1.12.7+build",
    ]) {
      const source = rendererArchive("CONTROL_ANCHOR", {
        "package.json": JSON.stringify({ version }),
      });
      expect(() => discoverRendererRelease(source, anchors), version).toThrow(
        "Renderer package has no semantic version",
      );
    }
  });

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

  test("rejects computed routes through the reviewed request helper", () => {
    const source = rendererArchive(
      'CONTROL_ANCHOR;var path="/user/signin";gw(path);send({op:"ping"});',
    );
    expect(() => discoverRendererRelease(source, anchors)).toThrow(
      "Control-plane request helpers require literal routes",
    );
  });

  test("inventories generic host-plus-path POST helpers without treating them as control routes", () => {
    const source = rendererArchive(
      'CONTROL_ANCHOR;var F=fetch,base="https://api.example";' +
        'function control(path,body){return F(base+path,{method:"POST",body})}' +
        'function generic(host,path,body){return F(host+path,{method:"POST",body})}' +
        'control("/user/signin",{});generic(makeHost(x),dynamicPath,{});' +
        'send({op:"ping"});',
    );
    const discovered = discoverRendererRelease(source, anchors);
    expect(discovered.controlPlaneRoutes).toEqual({ "/user/signin": 1 });
    expect(discovered.controlPlaneRequestHelpers).toMatchObject({
      "app.js:control->F(base+path)": 1,
      "app.js:generic->F(host+path)": 1,
    });
  });

  test("keeps same-named request helpers in separate lexical scopes", () => {
    const source = rendererArchive(
      'CONTROL_ANCHOR;var F=fetch,base="https://api.example";' +
        'function one(){function post(path){return F(base+path,{method:"POST"})}' +
        'post("/user/signin")}' +
        'function two(){function post(value){return value}post(dynamic)}' +
        'one();two();send({op:"ping"});',
    );
    const discovered = discoverRendererRelease(source, anchors);

    expect(discovered.controlPlaneRoutes).toEqual({ "/user/signin": 1 });
    expect(discovered.controlPlaneRequestHelpers).toMatchObject({
      "app.js:post->F(base+path)": 1,
    });
  });

  test("tracks request-helper aliases, transports, and network constructors", () => {
    const source = rendererArchive(
      'CONTROL_ANCHOR;var mw=window.fetch,WS=window.WebSocket,U=window.URL;' +
        'function gw(path,body){return mw(base+path,{method:"POST",body:body})}' +
        'var request=gw;request("/user/signin",{});' +
        'var url=new U(host),socket=new WS(url);send({op:"ping"});',
    );
    const discovered = discoverRendererRelease(source, anchors);
    expect(discovered.controlPlaneRoutes).toEqual({ "/user/signin": 1 });
    expect(discovered.controlPlaneRouteLocations).toEqual({
      "app.js:request:/user/signin": 1,
    });
    expect(discovered.controlPlaneRequestHelpers).toEqual({
      "app.js:gw->mw(base+path)": 1,
      "app.js:request=alias(gw)": 1,
    });
    expect(discovered.networkConstructors).toMatchObject({
      "app.js:binding:U=window.URL": 1,
      "app.js:binding:WS=window.WebSocket": 1,
      "app.js:binding:mw=window.fetch": 1,
      "app.js:call:mw[window.fetch]": 1,
      "app.js:new:U[window.URL]": 1,
      "app.js:new:WS[window.WebSocket]": 1,
      "app.js:read:window.URL": 1,
      "app.js:read:window.WebSocket": 1,
      "app.js:read:window.fetch": 1,
    });

    const changed = rendererArchive(
      'CONTROL_ANCHOR;var mw=window.fetch,WS=window.WebSocket,U=window.URL;' +
        'function gw(path,body){return mw(base+path,{method:"POST",body:body})}' +
        'var request=gw;request("/user/signin",{});' +
        'var url=new U(host),socket=new WS(url),socket2=new WS(url);send({op:"ping"});',
    );
    expect(failedChecks(analyzeRendererRelease(changed, {
      baseline: baselineFor(source),
      sha256: "d".repeat(64),
    }))).toContain("network-constructors");
  });

  test("tracks browser constructors and Electron net sinks through proven aliases", () => {
    const source = rendererArchive(
      "CONTROL_ANCHOR;" +
        "const X0=window.XMLHttpRequest,X1=X0;" +
        "const ES=globalThis.EventSource,R=self['Request'];" +
        "new X1();new ES('/events');new R('/request');" +
        "const electron=require('electron'),net=electron.net;" +
        "const electronFetch=net.fetch,electronRequest=electron['net']['request'];" +
        "electronFetch('/fetch');electronRequest({url:'/request'});" +
        "electron.net.fetch('/direct');send({op:'ping'});",
    );
    const discovered = discoverRendererRelease(source, anchors);

    expect(discovered.networkConstructors).toMatchObject({
      "app.js:binding:ES=window.EventSource": 1,
      "app.js:binding:R=window.Request": 1,
      "app.js:binding:X0=window.XMLHttpRequest": 1,
      "app.js:binding:X1=window.XMLHttpRequest": 1,
      "app.js:binding:electronFetch=electron.net.fetch": 1,
      "app.js:binding:electronRequest=electron.net.request": 1,
      "app.js:call:electron.net.fetch[electron.net.fetch]": 1,
      "app.js:call:electronFetch[electron.net.fetch]": 1,
      "app.js:call:electronRequest[electron.net.request]": 1,
      "app.js:new:ES[window.EventSource]": 1,
      "app.js:new:R[window.Request]": 1,
      "app.js:new:X1[window.XMLHttpRequest]": 1,
      "app.js:read:electron.net.fetch[electron.net.fetch]": 1,
      "app.js:read:electron['net']['request'][electron.net.request]:computed": 1,
      "app.js:read:window.EventSource": 1,
      "app.js:read:window.Request:computed": 1,
      "app.js:read:window.XMLHttpRequest": 1,
    });
  });

  test("tracks destructured, computed, and imported Electron net aliases", () => {
    const source = rendererArchive(
      "CONTROL_ANCHOR;" +
        "const {net:n}=window.require('electron');" +
        "const {fetch:f,request:r}=n;f('/fetch');r({url:'/request'});" +
        "send({op:'ping'});",
      {
        "transport.mjs":
          "import * as electron from 'electron';" +
          "const n=electron['net'];n['fetch']('/fetch');electron.net.request({url:'/request'});",
      },
    );
    const discovered = discoverRendererRelease(source, anchors);

    expect(discovered.networkConstructors).toMatchObject({
      "app.js:binding:f=electron.net.fetch": 1,
      "app.js:binding:r=electron.net.request": 1,
      "app.js:call:f[electron.net.fetch]": 1,
      "app.js:call:r[electron.net.request]": 1,
      "transport.mjs:call:electron.net.request[electron.net.request]": 1,
      "transport.mjs:call:n['fetch'][electron.net.fetch]": 1,
      "transport.mjs:read:electron.net.request[electron.net.request]": 1,
      "transport.mjs:read:n['fetch'][electron.net.fetch]:computed": 1,
    });
  });

  test("discovers literal routes behind Electron POST helpers", () => {
    const source = rendererArchive(
      "CONTROL_ANCHOR;send({op:'ping'});",
      {
        "transport.js":
          "const electron=require('electron');" +
          "function fetchPost(path,body){" +
          "return electron.net.fetch(base+path,{method:'POST',body})}" +
          "function requestPost(path,body){" +
          "return electron.net.request({url:base+path,method:'POST',body})}" +
          "fetchPost('/user/signin',{});requestPost('/vault/list',{});",
      },
    );
    const discovered = discoverRendererRelease(source, anchors);

    expect(discovered.controlPlaneRoutes).toEqual({
      "/user/signin": 1,
      "/vault/list": 1,
    });
    expect(discovered.controlPlaneRequestHelpers).toEqual({
      "transport.js:fetchPost->electron.net.fetch(base+path)": 1,
      "transport.js:requestPost->electron.net.request(base+path)": 1,
    });
  });

  test("fails closed on added, removed, and retargeted network sinks", () => {
    const sourceText =
      "CONTROL_ANCHOR;const electron=require('electron'),send=electron.net.fetch;" +
      "const X=XMLHttpRequest;new X();send('/request');sendMessage({op:'ping'});";
    const source = rendererArchive(sourceText);
    const baseline = baselineFor(source);
    const changes = [
      sourceText.replace("new X();", "new X();new EventSource('/events');"),
      sourceText.replace("const X=XMLHttpRequest;new X();", ""),
      sourceText.replace("send=electron.net.fetch", "send=electron.net.request"),
      sourceText.replace("const X=XMLHttpRequest", "const Renamed=XMLHttpRequest")
        .replace("new X()", "new Renamed()"),
    ];

    for (const [index, changed] of changes.entries()) {
      const report = analyzeRendererRelease(rendererArchive(changed), {
        baseline,
        sha256: String(index).repeat(64),
      });
      expect(failedChecks(report), `mutation ${index}`).toContain("network-constructors");
    }
  });

  test("does not attribute shadowed, generic, or reassigned values to network globals", () => {
    const source = rendererArchive(
      "CONTROL_ANCHOR;" +
        "function Request(){};new Request();" +
        "function shadow(XMLHttpRequest,electron,window){" +
        "new XMLHttpRequest();electron.net.fetch('/shadow');new window.EventSource('/shadow')}" +
        "const fake={net:{fetch(){},request(){}}};" +
        "fake.net.fetch('/fake');fake.net.request({url:'/fake'});" +
        "let electron=require('electron');electron=fake;electron.net.fetch('/reassigned');" +
        "const stable=require('electron');let send=stable.net.fetch;send=()=>{};send('/local');" +
        "sendMessage({op:'ping'});",
    );
    const discovered = discoverRendererRelease(source, anchors);

    expect(discovered.networkConstructors).toEqual({
      "app.js:binding:send=electron.net.fetch": 1,
      "app.js:read:stable.net.fetch[electron.net.fetch]": 1,
    });
  });

  test("tracks real calls across linear alias reassignment epochs", () => {
    const source = rendererArchive(
      "CONTROL_ANCHOR;const fake={},local=()=>{};" +
        "let electron=require('electron');electron.net.fetch('/direct-before');" +
        "electron=fake;electron.net.fetch('/direct-after');" +
        "const stable=require('electron');let transport=stable.net.fetch;" +
        "transport('/fetch-before');transport=local;transport('/local-after');" +
        "transport=stable.net.request;transport({url:'/request-after'});" +
        "sendMessage({op:'ping'});",
    );
    const discovered = discoverRendererRelease(source, anchors);

    expect(discovered.networkConstructors).toEqual({
      "app.js:binding:transport=electron.net.fetch": 1,
      "app.js:binding:transport=electron.net.request": 1,
      "app.js:call:electron.net.fetch[electron.net.fetch]": 1,
      "app.js:call:transport[electron.net.fetch]": 1,
      "app.js:call:transport[electron.net.request]": 1,
      "app.js:read:electron.net.fetch[electron.net.fetch]": 1,
      "app.js:read:stable.net.fetch[electron.net.fetch]": 1,
      "app.js:read:stable.net.request[electron.net.request]": 1,
    });
  });

  test("retains every possible transport across ambiguous control flow", () => {
    const source = rendererArchive(
      "CONTROL_ANCHOR;const electron=require('electron');" +
        "let transport=electron.net.fetch;" +
        "if(flag){transport=electron.net.request}" +
        "transport('/ambiguous',{method:'POST'});sendMessage({op:'ping'});",
    );
    const discovered = discoverRendererRelease(source, anchors);

    expect(discovered.networkConstructors).toMatchObject({
      "app.js:call:transport[electron.net.fetch]": 1,
      "app.js:call:transport[electron.net.request]": 1,
    });
  });

  test("binds semantic anchors in secondary packed renderers", () => {
    const source = rendererArchive(
      'CONTROL_ANCHOR;gw("/user/signin");send({op:"ping"});',
      { "starter.js": "STARTER_CONTROL_ANCHOR" },
    );
    const discovered = discoverRendererRelease(source, [
      ...anchors,
      {
        id: "starter-control",
        file: "starter.js",
        literal: "STARTER_CONTROL_ANCHOR",
        expectedMatches: 1,
      },
    ]);
    expect(discovered.anchorMatches["starter-control"]).toBe(1);
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
        "worker.cjs":
          'var wf=window.fetch;function gw(p){return wf(base+p,{method:"POST"})};' +
          'gw("/vault/from-worker");send({op:"worker",path:a});',
      },
    );
    const changed = rendererArchive(
      'CONTROL_ANCHOR;gw("/user/signin");send({op:"ping"});',
      {
        "secondary.mjs": 'send({op:"future",path:a,hash:b});',
        "worker.cjs":
          'var wf=window.fetch;function gw(p){return wf(base+p,{method:"POST"})};' +
          'gw("/vault/from-worker");send({op:"worker",path:a});',
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

  test("rejects empty semantic inventories in a reviewed baseline", async () => {
    const directory = await mkdtemp(join(tmpdir(), "blackglass-empty-inventory-"));
    try {
      const source = rendererArchive(
        "CONTROL_ANCHOR;" +
          "var mw=window.fetch,WS=window.WebSocket;" +
          "function gw(path){return mw(base+path,{method:'POST'})}" +
          "gw('/user/signin');new WS(url);send({op:'ping'});" +
          "x.prototype.onMessage=function(e){var t=e.op;if('ready'===t)return}",
      );
      const baseline = baselineFor(source);
      const fields = [
        "controlPlaneRoutes",
        "controlPlaneRouteLocations",
        "controlPlaneRequestHelpers",
        "networkConstructors",
        "syncOperations",
        "syncOperationLocations",
        "syncMessageShapes",
        "syncMessageShapeLocations",
        "syncInboundOperations",
      ] as const;
      const path = join(directory, "compatibility.json");

      for (const field of fields) {
        const changed = structuredClone(baseline);
        changed[field] = {};
        await writeFile(path, `${JSON.stringify(changed)}\n`);
        await expect(loadCompatibilityBaseline(path), field).rejects.toThrow(
          `Compatibility baseline ${field} is invalid`,
        );
      }
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
    schemaVersion: 5,
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
    sourceMacOSCodeInventory: syntheticMacOSCodeInventory(),
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
    controlPlaneRouteLocations: discovered.controlPlaneRouteLocations,
    controlPlaneRequestHelpers: discovered.controlPlaneRequestHelpers,
    networkConstructors: discovered.networkConstructors,
    syncOperations: discovered.syncOperations,
    syncOperationLocations: discovered.syncOperationLocations,
    syncMessageShapes: discovered.syncMessageShapes,
    syncMessageShapeLocations: discovered.syncMessageShapeLocations,
    syncInboundOperations: discovered.syncInboundOperations,
  };
}

function syntheticMacOSCodeInventory(): MacOSCodeInventory {
  const entries = [{ path: ".", kind: "bundle", architectures: [] }] as const;
  return {
    formatVersion: 1,
    sha256: createHash("sha256").update(stableJson(entries)).digest("hex"),
    entries: entries.map((entry) => ({ ...entry, architectures: [...entry.architectures] })),
  };
}

function rendererArchive(
  appJs: string,
  additionalFiles: Record<string, string> = {},
): Buffer {
  return makeArchive({
    "app.js": Buffer.from(appJs),
    "main.js": Buffer.from("// desktop main"),
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
