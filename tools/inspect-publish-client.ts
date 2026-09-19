import { readFile, writeFile } from "node:fs/promises";
import { parseStrictFlags } from "./cli-flags";
import { canonicalExistingPath, canonicalOutputPath } from "./path-safety";
import {
  inspectPublishClientAsar,
  type PublishClientContract,
  verifyPublishClientContract,
} from "./publish-client-contract";
import { stableJsonFile } from "./stable-json";

const [asarArgument, ...flagArguments] = Bun.argv.slice(2);
if (!asarArgument) usage();
const flags = parseStrictFlags(flagArguments, {
  valueFlags: ["--baseline", "--output", "--renderer-version"],
});
const rendererVersion = flags.values.get("--renderer-version");
if (!rendererVersion) usage();
const asar = await canonicalExistingPath(asarArgument, "Official renderer ASAR", "file");
const contract = await inspectPublishClientAsar(asar, rendererVersion);
const baselineArgument = flags.values.get("--baseline");
if (baselineArgument) {
  const baseline = await canonicalExistingPath(baselineArgument, "Publish client baseline", "file");
  verifyPublishClientContract(
    JSON.parse(await readFile(baseline, "utf8")) as PublishClientContract,
    contract,
  );
}
const outputArgument = flags.values.get("--output");
if (outputArgument) {
  const output = await canonicalOutputPath(outputArgument, "Publish client contract");
  await writeFile(output, stableJsonFile(contract), { mode: 0o600, flag: "wx" });
} else {
  console.log(JSON.stringify(contract, null, 2));
}

function usage(): never {
  console.error(
    "Usage: bun run tools/inspect-publish-client.ts <official-renderer-asar> " +
      "--renderer-version <exact-version> [--baseline <reviewed-contract>] [--output <new-json>]",
  );
  process.exit(2);
}
