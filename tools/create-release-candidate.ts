import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseStrictFlags } from "./cli-flags";
import { canonicalOutputPath, assertPathWithin, canonicalExistingPath } from "./path-safety";
import {
  inspectReleaseCandidateInputs,
  releaseCandidateSha256,
  type ReleaseCandidate,
} from "./release-candidate";

const [outputArgument, ...flags] = Bun.argv.slice(2);
const parsed = parseStrictFlags(flags, {
  valueFlags: ["--server-repo", "--control-origin", "--data-host"],
});
const serverArgument = parsed.values.get("--server-repo");
const controlOrigin = parsed.values.get("--control-origin");
const dataHost = parsed.values.get("--data-host");
if (!outputArgument || !serverArgument || !controlOrigin || !dataHost) usage();

const clientRoot = resolve(import.meta.dir, "..");
const candidatesRoot = resolve(clientRoot, ".data/release-candidates");
await mkdir(candidatesRoot, { recursive: true, mode: 0o700 });
const output = await canonicalOutputPath(outputArgument, "release candidate output");
assertPathWithin(output, candidatesRoot, "release candidate output");
const serverRoot = await canonicalExistingPath(serverArgument, "server repository", "directory");
const inspected = await inspectReleaseCandidateInputs({
  clientRoot,
  serverRoot,
  endpoints: { controlOrigin, dataHost },
});
const candidate: ReleaseCandidate = {
  ...inspected,
  createdAt: new Date().toISOString(),
};
await writeFile(output, `${JSON.stringify(candidate, null, 2)}\n`, {
  flag: "wx",
  mode: 0o600,
});
console.log(JSON.stringify({ output, sha256: releaseCandidateSha256(candidate), candidate }, null, 2));

function usage(): never {
  console.error(
    "Usage: bun run tools/create-release-candidate.ts <.data/release-candidates/name.json> " +
      "--server-repo <blackglass-server> --control-origin <https-origin> --data-host <host[:port]>",
  );
  process.exit(2);
}
