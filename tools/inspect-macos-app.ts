import { rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { inspectMacOSArtifact } from "./macos-artifact";

const [appArgument, outputArgument] = Bun.argv.slice(2);
if (!appArgument || !outputArgument) {
  console.error("Usage: bun run tools/inspect-macos-app.ts <Blackglass.app> <output.json>");
  process.exit(2);
}

const artifact = await inspectMacOSArtifact(appArgument);
const output = resolve(outputArgument);
if (await Bun.file(output).exists()) throw new Error(`Output already exists: ${output}`);
const temporary = `${output}.next`;
await writeFile(temporary, `${JSON.stringify(artifact, null, 2)}\n`, {
  flag: "wx",
  mode: 0o600,
});
await rename(temporary, output);
console.log(JSON.stringify(artifact, null, 2));
