import { createServer, type Server, type ServerResponse } from "node:http";
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { chromium } from "#release-playwright-core";
import { parseStrictFlags } from "./cli-flags";
import { canonicalExistingPath, canonicalOutputPath } from "./path-safety";
import { inspectPublishRuntime, verifyPublishRuntimeManifest } from "./publish-runtime";
import type { PublishRuntimeAdaptationReceipt } from "./publish-runtime-adapter";
import { stableJsonFile } from "./stable-json";

const [runtimeArgument, ...flagArguments] = Bun.argv.slice(2);
if (!runtimeArgument) usage();
const flags = parseStrictFlags(flagArguments, {
  valueFlags: ["--chrome", "--origin", "--output"],
});
const outputArgument = flags.values.get("--output");
if (!outputArgument) usage();
const chromeArgument = flags.values.get("--chrome") ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const runtimeRoot = await canonicalExistingPath(runtimeArgument, "Adapted Publish runtime", "directory");
const chrome = await canonicalExistingPath(chromeArgument, "Chrome executable", "file");
const outputRoot = await canonicalOutputPath(outputArgument, "Publish replay evidence");
const configuredOrigin = flags.values.get("--origin");
if (configuredOrigin) assertLoopbackOrigin(configuredOrigin);
const staging = await mkdtemp(join(dirname(outputRoot), `.${basename(outputRoot)}.staging-`));
let published = false;

const receipt = JSON.parse(
  await readFile(join(runtimeRoot, "blackglass-publish-runtime.json"), "utf8"),
) as PublishRuntimeAdaptationReceipt;
const runtimeManifest = await inspectPublishRuntime(runtimeRoot);
verifyPublishRuntimeManifest(receipt.outputManifest, runtimeManifest);
if (receipt.outputRuntimeSha256 !== runtimeManifest.runtimeSha256) {
  throw new Error("Adapted Publish runtime receipt does not bind its current output");
}

const assets = new Map<string, Buffer>();
for (const asset of runtimeManifest.assets) {
  assets.set(`/${asset.path}`, await readFile(join(runtimeRoot, asset.path)));
}
const uid = "00000000000000000000000000000001";
const options = Buffer.from(JSON.stringify({
  indexFile: "Home",
  siteName: "Blackglass Publish",
  defaultTheme: "dark",
  showOutline: true,
  showBacklinks: true,
  showSearch: true,
  showThemeToggle: true,
  showNavigation: true,
  showGraph: true,
}));
const cache = Buffer.from(JSON.stringify({
  "Home.md": {
    links: [],
    headings: [
      { heading: "Blackglass Publish", level: 1, pos: [0, 0, 0, 0, 20, 20] },
    ],
    frontmatter: {},
    frontmatterLinks: [],
  },
}));
const home = Buffer.from(
  "# Blackglass Publish\n\nA self-hosted Publish runtime, rendered entirely from loopback.\n",
);
const requests: Array<{ method: string | undefined; path: string }> = [];
let origin = configuredOrigin ?? "http://127.0.0.1";
let server: Server | undefined;
if (!configuredOrigin) server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", origin);
  requests.push({ method: request.method, path: url.pathname });
  if (url.pathname === "/") {
    send(response, 200, "text/html; charset=utf-8", shell(origin, uid));
    return;
  }
  if (url.pathname === `/options/${uid}`) {
    send(response, 200, "application/json; charset=utf-8", options, true);
    return;
  }
  if (url.pathname === `/cache/${uid}`) {
    send(response, 200, "application/json; charset=utf-8", cache, true);
    return;
  }
  if (url.pathname === `/access/${uid}/Home.md`) {
    send(response, 200, "text/markdown; charset=utf-8", home, true);
    return;
  }
  const asset = assets.get(url.pathname);
  if (asset) {
    send(response, 200, contentType(url.pathname), asset);
    return;
  }
  send(response, 404, "text/plain; charset=utf-8", Buffer.from("not found"));
});

let browser;
try {
  if (server) {
    await new Promise<void>((resolve, reject) => {
      server!.once("error", reject);
      server!.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Publish replay has no loopback address");
    origin = `http://127.0.0.1:${address.port}`;
  } else {
    const response = await fetch(new URL("/.well-known/blackglass-publish-runtime.json", origin));
    if (!response.ok) throw new Error(`Publish replay identity returned HTTP ${response.status}`);
    const identity = await response.json() as {
      runtimeSha256?: string;
      sourceRuntimeSha256?: string;
      verified?: boolean;
    };
    if (
      identity.runtimeSha256 !== receipt.outputRuntimeSha256 ||
      identity.sourceRuntimeSha256 !== receipt.sourceRuntimeSha256 ||
      identity.verified !== true
    ) {
      throw new Error("Publish replay server identity does not match the source-bound runtime");
    }
  }

  browser = await chromium.launch({ executablePath: chrome, headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const failedRequests: Array<{ url: string; error: string | undefined }> = [];
  const blockedExternal: string[] = [];
  if (!server) {
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (url.hostname === "127.0.0.1") {
        requests.push({ method: request.method(), path: url.pathname });
      }
    });
  }
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => pageErrors.push(String(error)));
  page.on("requestfailed", (request) => {
    failedRequests.push({ url: request.url(), error: request.failure()?.errorText });
  });
  await page.route("**/*", async (route) => {
    const target = new URL(route.request().url());
    if (target.hostname !== "127.0.0.1") {
      blockedExternal.push(route.request().url());
      await route.abort("blockedbyclient");
      return;
    }
    await route.continue();
  });
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".publish-renderer", { timeout: 15_000 });
  await page.waitForSelector(".markdown-rendered", { timeout: 15_000 });
  const state = await page.evaluate(() => ({
    title: document.title,
    bodyClass: document.body.className,
    heading: document.querySelector("h1")?.textContent ?? null,
    siteName: document.querySelector(".site-body-left-column-site-name")?.textContent ?? null,
    footer: document.querySelector(".site-footer")?.textContent?.trim() ?? null,
    publishRenderer: Boolean(document.querySelector(".publish-renderer")),
    markdownRendered: Boolean(document.querySelector(".markdown-rendered")),
    graph: Boolean(document.querySelector(".graph-view-container")),
    search: Boolean(document.querySelector("input")),
    themeToggle: Boolean(document.querySelector(".site-body-left-column-site-theme-toggle")),
  }));
  if (
    !state.publishRenderer || !state.markdownRendered ||
    state.heading !== "Home" || state.siteName !== "Blackglass Publish" ||
    !state.title.endsWith(" - Blackglass Publish") ||
    !state.footer?.includes("Blackglass") || state.footer.includes("Obsidian") ||
    !state.graph || !state.search || !state.themeToggle
  ) {
    throw new Error(`Adapted Publish runtime rendered unexpected state: ${JSON.stringify(state)}`);
  }
  if (consoleErrors.length || pageErrors.length || failedRequests.length || blockedExternal.length) {
    throw new Error(
      `Adapted Publish runtime emitted browser failures: ${JSON.stringify({ consoleErrors, pageErrors, failedRequests, blockedExternal })}`,
    );
  }
  await page.screenshot({ path: join(staging, "publish-runtime.png"), fullPage: true });
  const report = {
    schemaVersion: 1,
    generatedBy: "tools/verify-publish-runtime-replay.ts",
    sourceRuntimeSha256: receipt.sourceRuntimeSha256,
    outputRuntimeSha256: receipt.outputRuntimeSha256,
    browser: { executable: basename(chrome) },
    network: { loopbackOnly: true, requests, blockedExternal },
    state,
    passed: true,
  };
  await writeFile(join(staging, "publish-runtime.json"), stableJsonFile(report), {
    mode: 0o600,
    flag: "wx",
  });
  await browser.close();
  browser = undefined;
  if (server) {
    await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
  }
  await rename(staging, outputRoot);
  published = true;
  console.log(JSON.stringify(report, null, 2));
} finally {
  if (browser) await browser.close();
  if (server?.listening) await new Promise<void>((resolve) => server!.close(() => resolve()));
  if (!published) await rm(staging, { recursive: true, force: true });
}

function shell(siteOrigin: string, siteUid: string): string {
  const host = siteOrigin.replace(/^https?:\/\//u, "");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><base href="${siteOrigin}"><script defer src="/app.js"></script><link rel="stylesheet" href="/app.css"><title>Blackglass Publish</title><script>window.siteInfo={uid:${JSON.stringify(siteUid)},host:${JSON.stringify(host)},status:"active",slug:"spike",redirect:0,customurl:null};window.preloadOptions=fetch("/options/${siteUid}",{credentials:"include"});window.preloadCache=fetch("/cache/${siteUid}",{credentials:"include"});window.preloadPage=fetch("/access/${siteUid}/Home.md",{credentials:"include"});</script></head><body class="theme-dark"><div class="preload">Loading…</div></body></html>`;
}

function send(
  response: ServerResponse,
  status: number,
  type: string,
  body: Buffer | string,
  active = false,
): void {
  response.writeHead(status, {
    "Content-Type": type,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...(active ? { "Access-Control-Allow-Origin": "*", "obs-status": "active" } : {}),
  });
  response.end(body);
}

function contentType(path: string): string {
  switch (extname(path)) {
    case ".css": return "text/css; charset=utf-8";
    case ".js": return "text/javascript; charset=utf-8";
    case ".mjs": return "text/javascript; charset=utf-8";
    case ".svg": return "image/svg+xml";
    case ".png": return "image/png";
    case ".woff2": return "font/woff2";
    default: return "application/octet-stream";
  }
}

function usage(): never {
  console.error(
    "Usage: bun run tools/verify-publish-runtime-replay.ts <adapted-runtime-directory> " +
      "--output <new-evidence-directory> [--chrome <chrome-executable>] " +
      "[--origin <loopback-rust-replay-origin>]",
  );
  process.exit(2);
}

function assertLoopbackOrigin(value: string): void {
  const origin = new URL(value);
  if (
    origin.protocol !== "http:" || origin.hostname !== "127.0.0.1" ||
    origin.username || origin.password || origin.pathname !== "/" ||
    origin.search || origin.hash || origin.origin !== value.replace(/\/$/u, "")
  ) {
    throw new Error("Publish replay origin must be an exact HTTP 127.0.0.1 origin");
  }
}
