import { readFile } from "node:fs/promises";
import { parseStrictFlags } from "./cli-flags";
import { canonicalExistingPath, canonicalOutputPath } from "./path-safety";
import { adaptPublishRuntime } from "./publish-runtime-adapter";
import type { PublishRuntimeManifest } from "./publish-runtime";

const [sourceArgument, ...flagArguments] = Bun.argv.slice(2);
if (!sourceArgument) usage();
const flags = parseStrictFlags(flagArguments, {
  valueFlags: ["--baseline", "--output"],
});
const baselineArgument = flags.values.get("--baseline");
const outputArgument = flags.values.get("--output");
if (!baselineArgument || !outputArgument) usage();

const sourceRoot = await canonicalExistingPath(sourceArgument, "Publish runtime", "directory");
const baselinePath = await canonicalExistingPath(baselineArgument, "Publish runtime baseline", "file");
const outputRoot = await canonicalOutputPath(outputArgument, "Adapted Publish runtime");
const baseline = JSON.parse(await readFile(baselinePath, "utf8")) as PublishRuntimeManifest;
const receipt = await adaptPublishRuntime({ sourceRoot, outputRoot, baseline });
console.log(JSON.stringify(receipt, null, 2));

function usage(): never {
  console.error(
    "Usage: bun run tools/adapt-publish-runtime.ts <runtime-directory> " +
      "--baseline <reviewed-manifest.json> --output <new-directory>",
  );
  process.exit(2);
}
