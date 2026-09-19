import { createHash } from "node:crypto";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  inspectPublishRuntime,
  verifyPublishRuntimeManifest,
  type PublishRuntimeManifest,
} from "./publish-runtime";
import { stableJsonFile } from "./stable-json";

export const PUBLISH_RUNTIME_ADAPTATION_SCHEMA_VERSION = 1 as const;

const INCISIONS = [
  {
    id: "public-home",
    expected: "https://publish.obsidian.md",
    replacement: "/",
  },
  {
    id: "powered-by",
    expected: "Powered by Obsidian Publish",
    replacement: "Powered by Blackglass Publish",
  },
  {
    id: "document-title",
    expected: " - Obsidian Publish",
    replacement: " - Blackglass Publish",
  },
] as const;

export interface PublishRuntimeAdaptationReceipt {
  schemaVersion: typeof PUBLISH_RUNTIME_ADAPTATION_SCHEMA_VERSION;
  generatedBy: "tools/adapt-publish-runtime.ts";
  sourceRuntimeSha256: string;
  outputRuntimeSha256: string;
  incisions: Array<{
    id: (typeof INCISIONS)[number]["id"];
    file: "app.js";
    offset: number;
    expectedBytes: number;
    expectedSha256: string;
    replacementBytes: number;
    replacementSha256: string;
  }>;
  outputManifest: PublishRuntimeManifest;
}

export async function adaptPublishRuntime(input: {
  sourceRoot: string;
  outputRoot: string;
  baseline: PublishRuntimeManifest;
}): Promise<PublishRuntimeAdaptationReceipt> {
  const source = await inspectPublishRuntime(input.sourceRoot);
  verifyPublishRuntimeManifest(input.baseline, source);

  const staging = await mkdtemp(join(dirname(input.outputRoot), `.${basename(input.outputRoot)}.staging-`));
  let published = false;
  try {
    for (const asset of source.assets) {
      const destination = join(staging, asset.path);
      await mkdir(dirname(destination), { recursive: true, mode: 0o755 });
      await copyFile(join(input.sourceRoot, asset.path), destination);
    }

    const appPath = join(staging, "app.js");
    let app = await readFile(appPath, "utf8");
    const incisions: PublishRuntimeAdaptationReceipt["incisions"] = [];
    for (const incision of INCISIONS) {
      const offsets = occurrenceOffsets(app, incision.expected);
      if (offsets.length !== 1) {
        throw new Error(
          `Publish runtime incision ${incision.id} expected one anchor; found ${offsets.length}`,
        );
      }
      const offset = offsets[0]!;
      incisions.push({
        id: incision.id,
        file: "app.js",
        offset: Buffer.byteLength(app.slice(0, offset)),
        expectedBytes: Buffer.byteLength(incision.expected),
        expectedSha256: sha256(incision.expected),
        replacementBytes: Buffer.byteLength(incision.replacement),
        replacementSha256: sha256(incision.replacement),
      });
      app = app.slice(0, offset) + incision.replacement + app.slice(offset + incision.expected.length);
    }
    await writeFile(appPath, app, { mode: 0o644 });

    const outputManifest = await inspectPublishRuntime(staging);
    const receipt: PublishRuntimeAdaptationReceipt = {
      schemaVersion: PUBLISH_RUNTIME_ADAPTATION_SCHEMA_VERSION,
      generatedBy: "tools/adapt-publish-runtime.ts",
      sourceRuntimeSha256: source.runtimeSha256,
      outputRuntimeSha256: outputManifest.runtimeSha256,
      incisions,
      outputManifest,
    };
    await writeFile(
      join(staging, "blackglass-publish-runtime.json"),
      stableJsonFile(receipt),
      { mode: 0o644, flag: "wx" },
    );
    await rename(staging, input.outputRoot);
    published = true;
    return receipt;
  } finally {
    if (!published) await rm(staging, { recursive: true, force: true });
  }
}

function occurrenceOffsets(source: string, needle: string): number[] {
  const offsets: number[] = [];
  let offset = 0;
  while ((offset = source.indexOf(needle, offset)) !== -1) {
    offsets.push(offset);
    offset += needle.length;
  }
  return offsets;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
