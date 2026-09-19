import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseStrictFlags } from "./cli-flags";
import { canonicalExistingPath, canonicalOutputPath } from "./path-safety";
import {
  inspectPublishRuntime,
  verifyPublishRuntimeManifest,
  type PublishRuntimeManifest,
} from "./publish-runtime";
import { stableJsonFile } from "./stable-json";

const [runtimeArgument, ...flagArguments] = Bun.argv.slice(2);
if (!runtimeArgument) usage();
const flags = parseStrictFlags(flagArguments, {
  valueFlags: ["--baseline", "--output"],
});
const runtime = await canonicalExistingPath(runtimeArgument, "Publish runtime", "directory");
const manifest = await inspectPublishRuntime(runtime);
const baselineArgument = flags.values.get("--baseline");
if (baselineArgument) {
  const baselinePath = await canonicalExistingPath(baselineArgument, "Publish runtime baseline", "file");
  const baseline = JSON.parse(await Bun.file(baselinePath).text()) as PublishRuntimeManifest;
  verifyPublishRuntimeManifest(baseline, manifest);
}
const outputArgument = flags.values.get("--output");
if (outputArgument) {
  const output = await canonicalOutputPath(resolve(outputArgument), "Publish runtime manifest");
  await writeFile(output, stableJsonFile(manifest), { mode: 0o600, flag: "wx" });
} else {
  console.log(JSON.stringify(manifest, null, 2));
}

function usage(): never {
  console.error(
    "Usage: bun run tools/inspect-publish-runtime.ts <runtime-directory> " +
      "[--baseline <reviewed-manifest.json>] [--output <new-manifest.json>]",
  );
  process.exit(2);
}
