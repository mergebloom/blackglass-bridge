import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { patchAsar } from "../packages/client-adapter/src/patch";
import { brandingPlanForSource } from "../packages/client-adapter/src/branding";
import { AsarArchive } from "./asar";
import bridgeRendererIconPath from "../assets/blackglass-prism.png" with { type: "file" };
import { parseStrictFlags } from "./cli-flags";
import {
  assertNonOverlappingPaths,
  canonicalExistingPath,
  canonicalOutputPath,
} from "./path-safety";
import {
  discoverUnpackedJavaScriptFiles,
  qualifyRendererRelease,
} from "./release-compatibility";

const [inputPath, outputPath, ...flags] = Bun.argv.slice(2);
if (!inputPath || !outputPath) {
  usage();
}

const parsedFlags = parseStrictFlags(flags, {
  valueFlags: ["--control-origin", "--data-host", "--baseline", "--resources"],
});
const controlOrigin = parsedFlags.values.get("--control-origin");
const dataHost = parsedFlags.values.get("--data-host");
const baselineArgument = parsedFlags.values.get("--baseline");
const resourcesArgument = parsedFlags.values.get("--resources");
if (!controlOrigin || !dataHost) {
  usage();
}
const input = await canonicalExistingPath(inputPath, "Upstream renderer ASAR", "file");
const output = await canonicalOutputPath(outputPath, "Patched renderer ASAR");
const baselinePath = baselineArgument
  ? await canonicalExistingPath(baselineArgument, "Compatibility baseline", "file")
  : undefined;
assertNonOverlappingPaths([
  { label: "Upstream renderer ASAR", path: input },
  { label: "Patched renderer ASAR", path: output },
  ...(baselinePath
    ? [{ label: "Compatibility baseline", path: baselinePath }]
    : []),
]);

const upstream = Buffer.from(await Bun.file(input).arrayBuffer());
const rendererMetadata = JSON.parse(AsarArchive.fromBuffer(upstream).read("package.json").toString("utf8")) as { version?: unknown };
const brandingPlan = typeof rendererMetadata.version === "string"
  ? brandingPlanForSource(rendererMetadata.version, createHash("sha256").update(upstream).digest("hex"))
  : undefined;
const resourcesPath = resourcesArgument
  ? await canonicalExistingPath(resourcesArgument, "Application Resources", "directory")
  : dirname(input);
const unpackedJavaScriptFiles = await discoverUnpackedJavaScriptFiles(resourcesPath);
const qualification = await qualifyRendererRelease(
  upstream,
  baselinePath,
  unpackedJavaScriptFiles,
);
const generated = patchAsar(
  upstream,
  { controlOrigin, dataHost },
  qualification.loadedBaseline.baseline.patchIncisions,
  brandingPlan,
  brandingPlan ? await readFile(bridgeRendererIconPath) : undefined,
);
await writeFile(output, generated.buffer, { flag: "wx", mode: 0o600 });
console.log(
  JSON.stringify(
    {
      schemaVersion: 1,
      compatibilityBaseline: qualification.report.baseline,
      renderer: generated.report,
    },
    null,
    2,
  ),
);

function usage(): never {
  console.error(
    "Usage: bun run tools/patch-client.ts <input.asar> <output.asar> " +
      "--control-origin <origin> --data-host <host[:port]> " +
      "[--resources <official-app/Contents/Resources>] " +
      "[--baseline <reviewed-baseline.json>]",
  );
  process.exit(2);
}
