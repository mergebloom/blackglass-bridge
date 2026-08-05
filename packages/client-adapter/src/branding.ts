import { createHash } from "node:crypto";
import plan1127Text from "../../../branding/obsidian-1.12.7.json" with { type: "text" };
import plan1134Text from "../../../branding/obsidian-1.13.4.json" with { type: "text" };
import { AsarArchive, replacePackedAsarEntry } from "../../../tools/asar";

export const BLACKGLASS_CAPTION = "Blackglass" as const;
export const BLACKGLASS_ICON_ENVIRONMENT = "BLACKGLASS_ICON" as const;
export const BRANDING_PLAN_SCHEMA_VERSION = 1;

type BrandingReplacement = "caption" | "application-name-bootstrap" | "dock-icon" | "account-url";
interface BrandingIncision {
  id: string;
  file: "main.js" | "app.js" | "starter.js";
  offset: number;
  length: number;
  sha256: string;
  replacement: BrandingReplacement;
}
export interface BrandingPlan {
  schemaVersion: typeof BRANDING_PLAN_SCHEMA_VERSION;
  id: string;
  rendererVersion: string;
  rendererAsarSha256: string;
  sourceFiles: Record<"main.js" | "app.js" | "starter.js" | "icon.png", string>;
  incisions: BrandingIncision[];
}
export interface BrandingReport {
  planId: string;
  incisionCount: number;
  caption: typeof BLACKGLASS_CAPTION;
  iconEnvironment: typeof BLACKGLASS_ICON_ENVIRONMENT;
  upstreamIconSha256: string;
  blackglassIconSha256: string;
  accountManagementUrl: string;
}

const plans = [
  parsePlan(plan1127Text as unknown as string),
  parsePlan(plan1134Text as unknown as string),
];

export function brandingPlanForSource(rendererVersion: string, rendererAsarSha256: string): BrandingPlan | undefined {
  return plans.find((plan) => plan.rendererVersion === rendererVersion && plan.rendererAsarSha256 === rendererAsarSha256);
}

export function applyReviewedBranding(sourceRenderer: Buffer, adaptedRenderer: Buffer, plan: BrandingPlan, blackglassIcon: Buffer, controlOrigin: string): { buffer: Buffer; report: BrandingReport } {
  if (sha256(sourceRenderer) !== plan.rendererAsarSha256) throw new Error("Branding plan does not match the reviewed renderer");
  const source = AsarArchive.fromBuffer(sourceRenderer);
  const adapted = AsarArchive.fromBuffer(adaptedRenderer);
  for (const [file, digest] of Object.entries(plan.sourceFiles)) {
    if (sha256(source.read(file)) !== digest) throw new Error(`Branding source changed: ${file}`);
  }

  let output = adaptedRenderer;
  for (const file of ["main.js", "app.js", "starter.js"] as const) {
    const before = source.read(file);
    const after = applyIncisions(before, adapted.read(file), plan.incisions.filter((incision) => incision.file === file), controlOrigin);
    output = replacePackedAsarEntry(output, file, after);
  }
  output = replacePackedAsarEntry(output, "icon.png", blackglassIcon);
  const accountManagementUrl = `${controlOrigin}/account`;
  inspectReviewedBranding(output, plan, sha256(blackglassIcon), accountManagementUrl);
  return {
    buffer: output,
    report: {
      planId: plan.id,
      incisionCount: plan.incisions.length,
      caption: BLACKGLASS_CAPTION,
      iconEnvironment: BLACKGLASS_ICON_ENVIRONMENT,
      upstreamIconSha256: plan.sourceFiles["icon.png"],
      blackglassIconSha256: sha256(blackglassIcon),
      accountManagementUrl,
    },
  };
}

function applyIncisions(source: Buffer, adapted: Buffer, incisions: BrandingIncision[], controlOrigin: string): Buffer {
  if (source.length !== adapted.length) throw new Error("Core renderer incisions must preserve offsets before branding");
  const ranges = [...incisions].sort((left, right) => left.offset - right.offset);
  const parts: Buffer[] = [];
  let cursor = 0;
  for (const incision of ranges) {
    if (incision.offset < cursor || incision.length < 1 || incision.offset + incision.length > source.length) {
      throw new Error(`Invalid or overlapping branding incision: ${incision.id}`);
    }
    const original = source.subarray(incision.offset, incision.offset + incision.length);
    if (sha256(original) !== incision.sha256) throw new Error(`Branding incision hash mismatch: ${incision.id}`);
    parts.push(adapted.subarray(cursor, incision.offset), Buffer.from(replacement(original, incision.replacement, controlOrigin), "utf8"));
    cursor = incision.offset + incision.length;
  }
  parts.push(adapted.subarray(cursor));
  return Buffer.concat(parts);
}

function replacement(original: Buffer, kind: BrandingReplacement, controlOrigin: string): string {
  if (kind === "caption") return BLACKGLASS_CAPTION;
  if (kind === "account-url") return `${controlOrigin}/account`;
  const source = original.toString("utf8");
  const alias = /^([A-Za-z_$][\w$]*)\.app\./u.exec(source)?.[1];
  if (!alias) throw new Error(`Branding ${kind} incision has an unknown shape`);
  if (kind === "application-name-bootstrap" && source === `${alias}.app.setAboutPanelOptions`) {
    return `${alias}.app.setName(${JSON.stringify(BLACKGLASS_CAPTION)}),${source}`;
  }
  if (kind === "dock-icon" && new RegExp(`^${alias}\\.app\\.dock\\.setIcon\\([A-Za-z_$][\\w$]*\\)$`, "u").test(source)) {
    return `${alias}.app.dock.setIcon(${alias}.nativeImage.createFromPath(process.env.${BLACKGLASS_ICON_ENVIRONMENT}))`;
  }
  throw new Error(`Branding ${kind} incision has an unknown shape`);
}

function inspectReviewedBranding(output: Buffer, plan: BrandingPlan, iconSha256: string, accountManagementUrl: string): void {
  const archive = AsarArchive.fromBuffer(output);
  if (sha256(archive.read("icon.png")) !== iconSha256) throw new Error("Blackglass renderer icon was not installed");
  const main = archive.read("main.js").toString("utf8");
  const app = archive.read("app.js").toString("utf8");
  const starter = archive.read("starter.js").toString("utf8");
  for (const [file, source] of [["main.js", main], ["app.js", app], ["starter.js", starter]] as const) {
    try { new Function(source); }
    catch (error) { throw new Error(`Branded ${file} is not valid JavaScript: ${String(error)}`); }
  }
  if (!main.includes(`.app.setName(${JSON.stringify(BLACKGLASS_CAPTION)})`) ||
      !main.includes(`process.env.${BLACKGLASS_ICON_ENVIRONMENT}`) ||
      count(main, BLACKGLASS_CAPTION) < 8 || count(app, BLACKGLASS_CAPTION) < 3 ||
      !app.includes(`window.open(${JSON.stringify(accountManagementUrl)})`) ||
      count(starter, BLACKGLASS_CAPTION) < 1 || plan.incisions.length !== 14) {
    throw new Error("Generated renderer does not satisfy the reviewed branding contract");
  }
}

function parsePlan(text: string): BrandingPlan {
  const value = JSON.parse(text) as BrandingPlan;
  if (value.schemaVersion !== BRANDING_PLAN_SCHEMA_VERSION || !/^blackglass-branding-\d+\.\d+\.\d+$/u.test(value.id) ||
      !/^\d+\.\d+\.\d+$/u.test(value.rendererVersion) || !isSha256(value.rendererAsarSha256) ||
      value.incisions.length !== 14 || Object.values(value.sourceFiles).some((digest) => !isSha256(digest))) {
    throw new Error("Invalid Blackglass branding plan");
  }
  const ids = new Set<string>();
  for (const incision of value.incisions) {
    if (!incision.id || ids.has(incision.id) || !["main.js", "app.js", "starter.js"].includes(incision.file) ||
        !Number.isSafeInteger(incision.offset) || incision.offset < 0 || !Number.isSafeInteger(incision.length) ||
        incision.length < 1 || !isSha256(incision.sha256) ||
        !["caption", "application-name-bootstrap", "dock-icon", "account-url"].includes(incision.replacement)) {
      throw new Error("Invalid Blackglass branding incision");
    }
    ids.add(incision.id);
  }
  return value;
}

function count(value: string, needle: string): number { return value.split(needle).length - 1; }
function isSha256(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value); }
function sha256(value: Uint8Array): string { return createHash("sha256").update(value).digest("hex"); }
