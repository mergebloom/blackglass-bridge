import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import {
  inspectPublishRuntime,
  verifyPublishRuntimeManifest,
} from "../tools/publish-runtime";

test("binds every locally loaded Publish runtime asset and protocol anchor", async () => {
  const root = await fixture();
  try {
    const manifest = await inspectPublishRuntime(root);
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.routeAnchors).toEqual({
      "/access/": 1,
      "/cache/": 1,
      "/options/": 1,
    });
    expect(manifest.dataRoutes).toEqual(["/access/", "/cache/", "/options/", "/pw", "/search"]);
    expect(manifest.externalOrigins).toEqual([
      "https://publish.obsidian.md",
      "https://www.youtube-nocookie.com",
    ]);
    expect(manifest.assets.map((asset) => asset.path)).toEqual([
      "app.css",
      "app.js",
      "lib/prism.min.js",
      "public/fonts/test.woff2",
      "sim.js",
      "worker.js",
    ]);
    expect(manifest.entrypoints["app.js"]).toBe(sha256(Buffer.from(appJs())));
    expect(manifest.runtimeSha256).toMatch(/^[a-f0-9]{64}$/u);
    verifyPublishRuntimeManifest(manifest, structuredClone(manifest));
    const changed = structuredClone(manifest);
    changed.assets[0]!.bytes += 1;
    expect(() => verifyPublishRuntimeManifest(manifest, changed)).toThrow(
      "differs from the reviewed source-bound manifest",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fails closed when a referenced runtime asset is absent", async () => {
  const root = await fixture({ omitWorker: true });
  try {
    await expect(inspectPublishRuntime(root)).rejects.toThrow("worker.js");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fails closed when a protocol anchor changes", async () => {
  const root = await fixture({ duplicateAccessAnchor: true });
  try {
    await expect(inspectPublishRuntime(root)).rejects.toThrow(
      "route anchor /access/ must occur exactly once",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function fixture(
  options: { omitWorker?: boolean; duplicateAccessAnchor?: boolean } = {},
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "blackglass-publish-runtime-"));
  await Promise.all([
    mkdir(join(root, "lib"), { recursive: true }),
    mkdir(join(root, "public/fonts"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(
      join(root, "app.js"),
      options.duplicateAccessAnchor ? `${appJs()}\n"/access/";` : appJs(),
    ),
    writeFile(join(root, "app.css"), "@font-face{src:url('/public/fonts/test.woff2')}"),
    writeFile(join(root, "lib/prism.min.js"), "prism"),
    writeFile(join(root, "public/fonts/test.woff2"), "font"),
    writeFile(join(root, "sim.js"), "sim"),
    ...(!options.omitWorker ? [writeFile(join(root, "worker.js"), "worker")] : []),
  ]);
  return realpath(root);
}

function appJs(): string {
  return [
    'const access="/access/",cache="/cache/",options="/options/";',
    'const password="/pw",search="/search";',
    'load("/sim.js");load("/worker.js");load("/lib/prism.min.js?1");',
    'const home="https://publish.obsidian.md";',
    'const embed="https://www.youtube-nocookie.com/embed/";',
  ].join("\n");
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
