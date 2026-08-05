import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test } from "bun:test";
import {
  BLACKGLASS_CAPTION,
  BLACKGLASS_ICON_ENVIRONMENT,
  brandingPlanForSource,
} from "../packages/client-adapter/src/branding";

const known = [
  ["1.12.7", "2b2483b2e1246772e0d25367ec055cbc5047ea2f0091b667c35656678f86d712"],
  ["1.13.4", "51218495ad940a8515b202d380bde638be6570a198e121f7ca6d484a8a158917"],
] as const;

test("selects branding only for an exact reviewed renderer", () => {
  for (const [version, sha256] of known) {
    const plan = brandingPlanForSource(version, sha256);
    expect(plan?.id).toBe(`blackglass-branding-${version}`);
    const expectedCount = version === "1.13.4" ? 18 : 16;
    expect(plan?.incisions).toHaveLength(expectedCount);
    expect(new Set(plan?.incisions.map((incision) => incision.id)).size).toBe(expectedCount);
    expect(plan?.incisions.some((incision) => incision.id === "account-manage-url" && incision.replacement === "account-url")).toBe(true);
    expect(plan?.incisions.some((incision) => incision.id === "onboarding-logo" && incision.replacement === "onboarding-logo")).toBe(true);
    expect(plan?.incisions.some((incision) => incision.id === "onboarding-wordmark" && incision.replacement === "onboarding-wordmark")).toBe(true);
  }
  expect(brandingPlanForSource("1.13.4", "0".repeat(64))).toBeUndefined();
  expect(brandingPlanForSource("1.13.5", known[1][1])).toBeUndefined();
});

test("public plans contain only hashes, offsets, and replacement kinds", async () => {
  for (const [version] of known) {
    const value = JSON.parse(await readFile(resolve(import.meta.dir, `../branding/obsidian-${version}.json`), "utf8")) as Record<string, unknown>;
    expect(JSON.stringify(value)).not.toContain('"literal"');
    expect(JSON.stringify(value)).not.toContain('"source"');
    expect(Object.keys(value).sort()).toEqual(["id", "incisions", "rendererAsarSha256", "rendererVersion", "schemaVersion", "sourceFiles"].sort());
  }
});

test("the launcher supplies the reviewed child-runtime icon environment", async () => {
  const source = await readFile(resolve(import.meta.dir, "../tools/launcher-runtime.ts"), "utf8");
  expect(source).toContain(`[BLACKGLASS_ICON_ENVIRONMENT]: blackglassIcon`);
  expect(BLACKGLASS_CAPTION).toBe("Blackglass");
  expect(BLACKGLASS_ICON_ENVIRONMENT).toBe("BLACKGLASS_ICON");
});
