import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { AsarArchive } from "./asar";
import { compareCodeUnitStrings, stableJson } from "./stable-json";

export interface PublishClientAnchor {
  id: string;
  offset: number;
  length: number;
  sha256: string;
}

export interface PublishClientContract {
  schemaVersion: 1;
  generatedBy: "tools/inspect-publish-client.ts";
  rendererVersion: string;
  sourceAsarSha256: string;
  appJsSha256: string;
  routes: Record<string, number>;
  anchors: PublishClientAnchor[];
  requestContract: {
    control: Record<string, string[]>;
    siteControl: Record<string, string[]>;
    siteData: Record<string, string[]>;
    uploadHeaders: string[];
    uploadBody: "application/octet-stream";
    uploadClientLimitBytes: number;
    downloadResponse: "application/octet-stream";
  };
  responseContract: Record<string, string[]>;
  transport: {
    control: "POST JSON";
    siteControl: "POST JSON";
    siteData: "POST JSON or binary upload";
    loopbackScheme: "http";
    remoteScheme: "https";
  };
}

const ROUTES = [
  "/publish/create",
  "/publish/delete",
  "/publish/list",
  "/publish/share/accept",
  "/publish/share/invite",
  "/publish/share/list",
  "/publish/share/remove",
  "/api/site",
  "/api/slug",
  "/api/slugs",
  "/api/customurl",
  "/api/list",
  "/api/options",
  "/api/password",
  "/api/remove",
  "/api/upload",
  "/api/download",
] as const;

const ANCHORS: Array<{ id: string; pattern: RegExp; expected?: number }> = [
  { id: "publish-create-request", pattern: /return [$\w]+\("\/publish\/create",\{token:[$\w]+\}\)/u },
  { id: "publish-delete-request", pattern: /return [$\w]+\("\/publish\/delete",\{token:[$\w]+,site_uid:[$\w]+\}\)/u },
  { id: "publish-invite-request", pattern: /return [$\w]+\("\/publish\/share\/invite",\{token:[$\w]+,site_uid:[$\w]+,email:[$\w]+\}\)/u },
  { id: "publish-remove-share-request", pattern: /return [$\w]+\("\/publish\/share\/remove",\{token:[$\w]+,site_uid:[$\w]+,share_uid:[$\w]+\}\)/u },
  { id: "publish-accept-share-request", pattern: /[$\w]+\("\/publish\/share\/accept",\{token:[$\w]+,code:[$\w]+\}\)/u },
  { id: "publish-list-request", pattern: /[$\w]+\("\/publish\/list",\{token:[$\w]+\}\)/u },
  { id: "publish-list-shares-request", pattern: /[$\w]+\("\/publish\/share\/list",\{token:[$\w]+,site_uid:[$\w]+\}\)/u },
  { id: "site-availability-request", pattern: /[$\w]+\("\/api\/site",\{token:[$\w]+,slug:[$\w]+\}\)/u },
  { id: "site-slug-update-request", pattern: /[$\w]+\("\/api\/slug",\{token:[$\w]+,id:[$\w]+,host:[$\w]+,slug:[$\w]+\}\)/u },
  { id: "site-slug-list-request", pattern: /[$\w]+\("\/api\/slugs",\{token:[$\w]+,ids:[$\w]+\}\)/u },
  { id: "site-custom-url-request", pattern: /[$\w]+\("\/api\/customurl",\{token:[$\w]+,id:[$\w]+,host:[$\w]+,url:[$\w]+,redirect:[$\w]+\}\)/u },
  { id: "site-file-list-request", pattern: /[$\w]+\([$\w]+,"\/api\/list",\{token:[$\w]+,id:[$\w]+,version:2\}\)/u },
  { id: "site-options-request", pattern: /[$\w]+\([$\w]+,"\/api\/options",\{token:[$\w]+,id:[$\w]+,options:[$\w]+\}\)/u },
  { id: "site-password-list-request", pattern: /[$\w]+\([$\w]+,"\/api\/password",\{token:[$\w]+,id:[$\w]+\}\)/u },
  { id: "site-password-add-request", pattern: /[$\w]+\([$\w]+,"\/api\/password",\{token:[$\w]+,id:[$\w]+,name:[$\w]+,pw:[$\w]+\}\)/u },
  { id: "site-password-delete-request", pattern: /[$\w]+\([$\w]+,"\/api\/password",\{token:[$\w]+,id:[$\w]+,del:[$\w]+\}\)/u },
  { id: "site-file-remove-request", pattern: /[$\w]+\([$\w]+,"\/api\/remove",\{token:[$\w]+,id:[$\w]+,path:[$\w]+\}\)/u },
  { id: "site-upload-wire-contract", pattern: /headers:\{"obs-token":[$\w]+,"obs-id":[$\w]+,"obs-path":encodeURIComponent\([$\w]+\),"obs-hash":[$\w]+,"Content-Type":"application\/octet-stream"\},body:[$\w]+/u },
  { id: "site-download-request", pattern: /body:JSON\.stringify\(\{token:[$\w]+,id:[$\w]+,path:[$\w]+\}\),headers:\{"Content-Type":"application\/json"\}/u },
  { id: "site-upload-client-limit", pattern: /\.stat\.size>52428800/u },
  { id: "site-host-scheme-selection", pattern: /\.startsWith\("127\.0\.0\.1"\)\|\|[$\w]+\.startsWith\("localhost"\)\?"http:\/\/"\+[$\w]+:"https:\/\/"\+[$\w]+/u, expected: 2 },
];

export async function inspectPublishClientAsar(
  asarPath: string,
  rendererVersion: string,
): Promise<PublishClientContract> {
  const asarBytes = await readFile(asarPath);
  const archive = AsarArchive.fromBuffer(asarBytes);
  return inspectPublishClientSource(
    archive.read("app.js").toString("utf8"),
    rendererVersion,
    sha256(asarBytes),
  );
}

export function inspectPublishClientSource(
  source: string,
  rendererVersion: string,
  sourceAsarSha256: string,
): PublishClientContract {
  requireSha256(sourceAsarSha256);
  if (!/^\d+\.\d+\.\d+$/u.test(rendererVersion)) {
    throw new Error("Publish renderer version must be an exact semantic version");
  }
  const routes = Object.fromEntries(
    ROUTES.map((route) => [route, countOccurrences(source, `"${route}"`)]),
  );
  for (const route of ROUTES) {
    const expected = route === "/api/password" ? 3 : 1;
    if (routes[route] !== expected) {
      throw new Error(`Publish client route ${route} must occur ${expected} time(s); found ${routes[route]}`);
    }
  }
  const anchors = ANCHORS.flatMap(({ id, pattern, expected }) =>
    matchAnchors(source, id, pattern, expected ?? 1)
  )
    .sort((left, right) => compareCodeUnitStrings(left.id, right.id));
  return {
    schemaVersion: 1,
    generatedBy: "tools/inspect-publish-client.ts",
    rendererVersion,
    sourceAsarSha256,
    appJsSha256: sha256(Buffer.from(source)),
    routes,
    anchors,
    requestContract: {
      control: {
        "/publish/create": ["token"],
        "/publish/delete": ["token", "site_uid"],
        "/publish/list": ["token"],
        "/publish/share/accept": ["token", "code"],
        "/publish/share/invite": ["token", "site_uid", "email"],
        "/publish/share/list": ["token", "site_uid"],
        "/publish/share/remove": ["token", "site_uid", "share_uid"],
      },
      siteControl: {
        "/api/customurl": ["token", "id", "host", "url", "redirect"],
        "/api/site": ["token", "slug"],
        "/api/slug": ["token", "id", "host", "slug"],
        "/api/slugs": ["token", "ids"],
      },
      siteData: {
        "/api/download": ["token", "id", "path"],
        "/api/list": ["token", "id", "version"],
        "/api/options": ["token", "id", "options"],
        "/api/password": ["token", "id", "name?", "pw?", "del?"],
        "/api/remove": ["token", "id", "path"],
        "/api/upload": [],
      },
      uploadHeaders: ["obs-token", "obs-id", "obs-path", "obs-hash", "Content-Type"],
      uploadBody: "application/octet-stream",
      uploadClientLimitBytes: 52_428_800,
      downloadResponse: "application/octet-stream",
    },
    responseContract: {
      "/publish/create": ["id", "host"],
      "/publish/list": ["sites", "shared", "limit"],
      "/publish/share/list": ["shares"],
      "/api/list": ["path-indexed file metadata"],
      "/api/options": ["Publish site options"],
      "/api/password": ["password entries"],
      "/api/slugs": ["site-id to slug mapping"],
    },
    transport: {
      control: "POST JSON",
      siteControl: "POST JSON",
      siteData: "POST JSON or binary upload",
      loopbackScheme: "http",
      remoteScheme: "https",
    },
  };
}

export function verifyPublishClientContract(
  expected: PublishClientContract,
  actual: PublishClientContract,
): void {
  if (stableJson(expected) !== stableJson(actual)) {
    throw new Error("Publish client differs from the reviewed source-bound protocol contract");
  }
}

function matchAnchors(
  source: string,
  id: string,
  pattern: RegExp,
  expected: number,
): PublishClientAnchor[] {
  const matches = [...source.matchAll(new RegExp(pattern.source, `${pattern.flags}g`))];
  if (matches.length !== expected) {
    throw new Error(`Publish client semantic anchor ${id} must match ${expected} time(s); found ${matches.length}`);
  }
  return matches.map((match, index) => {
    if (match.index === undefined || match[0] === undefined) {
      throw new Error(`Publish client semantic anchor ${id} has no source location`);
    }
    return {
      id: expected === 1 ? id : `${id}-${index + 1}`,
      offset: match.index,
      length: match[0].length,
      sha256: sha256(Buffer.from(match[0])),
    };
  });
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

function requireSha256(value: string): void {
  if (!/^[a-f0-9]{64}$/u.test(value)) throw new Error("Source ASAR SHA-256 is invalid");
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
