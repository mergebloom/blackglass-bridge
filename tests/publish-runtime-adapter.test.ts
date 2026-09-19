import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { adaptPublishRuntime } from "../tools/publish-runtime-adapter";
import { inspectPublishRuntime } from "../tools/publish-runtime";

test("adapts a reviewed Publish runtime without retaining upstream branding or origin", async () => {
  const parent = await realpath(await mkdtemp(join(tmpdir(), "blackglass-publish-adapter-")));
  const source = join(parent, "source");
  const output = join(parent, "output");
  try {
    await createFixture(source);
    const baseline = await inspectPublishRuntime(source);
    const receipt = await adaptPublishRuntime({ sourceRoot: source, outputRoot: output, baseline });
    const app = await readFile(join(output, "app.js"), "utf8");
    expect(app).not.toContain("https://publish.obsidian.md");
    expect(app).not.toContain("Powered by Obsidian Publish");
    expect(app).not.toContain(" - Obsidian Publish");
    expect(app).toContain("Powered by Blackglass Publish");
    expect(app).toContain(" - Blackglass Publish");
    expect(receipt.incisions.map((incision) => incision.id)).toEqual([
      "public-home",
      "powered-by",
      "document-title",
    ]);
    expect(receipt.sourceRuntimeSha256).toBe(baseline.runtimeSha256);
    expect(receipt.outputRuntimeSha256).not.toBe(receipt.sourceRuntimeSha256);
    expect(JSON.parse(await readFile(join(output, "blackglass-publish-runtime.json"), "utf8"))).toEqual(receipt);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("refuses an unreviewed or changed Publish runtime", async () => {
  const parent = await realpath(await mkdtemp(join(tmpdir(), "blackglass-publish-adapter-")));
  const source = join(parent, "source");
  try {
    await createFixture(source);
    const baseline = await inspectPublishRuntime(source);
    await writeFile(join(source, "sim.js"), "changed");
    await expect(
      adaptPublishRuntime({ sourceRoot: source, outputRoot: join(parent, "output"), baseline }),
    ).rejects.toThrow("differs from the reviewed source-bound manifest");
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

async function createFixture(root: string): Promise<void> {
  await mkdir(root, { recursive: true });
  await Promise.all([
    writeFile(
      join(root, "app.js"),
      [
        'const a="/access/",c="/cache/",o="/options/";',
        'load("/sim.js");',
        'const home="https://publish.obsidian.md";',
        'const footer="Powered by Obsidian Publish";',
        'const title=" - Obsidian Publish";',
      ].join("\n"),
    ),
    writeFile(join(root, "app.css"), "body{}"),
    writeFile(join(root, "sim.js"), "sim"),
  ]);
}
