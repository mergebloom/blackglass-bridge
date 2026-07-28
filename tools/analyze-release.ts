import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { parseStrictFlags } from "./cli-flags";
import { canonicalExistingPath } from "./path-safety";
import {
  analyzeRendererRelease,
  discoverUnpackedJavaScriptFiles,
  loadBaselineForRenderer,
} from "./release-compatibility";

const [asarPath, ...flags] = Bun.argv.slice(2);
if (!asarPath) usage();

const parsedFlags = parseStrictFlags(flags, {
  valueFlags: ["--baseline", "--resources"],
});
const baselineArgument = parsedFlags.values.get("--baseline");
const resourcesArgument = parsedFlags.values.get("--resources");
const rendererPath = await canonicalExistingPath(asarPath, "Renderer ASAR", "file");
const baselinePath = baselineArgument
  ? await canonicalExistingPath(baselineArgument, "Compatibility baseline", "file")
  : undefined;
const rendererAsar = await readFile(rendererPath);
const resourcesPath = resourcesArgument
  ? await canonicalExistingPath(resourcesArgument, "Application Resources", "directory")
  : dirname(rendererPath);
const unpackedJavaScriptFiles = await discoverUnpackedJavaScriptFiles(
  resourcesPath,
);
const loaded = await loadBaselineForRenderer(rendererAsar, baselinePath);
const report = analyzeRendererRelease(rendererAsar, loaded, unpackedJavaScriptFiles);
console.log(JSON.stringify(report, null, 2));
if (!report.ready) process.exitCode = 1;

function usage(): never {
  console.error(
    "Usage: bun run tools/analyze-release.ts <path-to-obsidian.asar> " +
      "[--resources <official-app/Contents/Resources>] " +
      "[--baseline <reviewed-baseline.json>]",
  );
  process.exit(2);
}
