import { lstat, writeFile } from "node:fs/promises";
import { patchAsar } from "../packages/client-adapter/src/patch";

const [inputPath, outputPath, ...flags] = Bun.argv.slice(2);
if (!inputPath || !outputPath) {
  usage();
}

const controlOrigin = readFlag(flags, "--control-origin");
const dataHost = readFlag(flags, "--data-host");
if (!controlOrigin || !dataHost) {
  usage();
}

try {
  await lstat(outputPath);
  throw new Error(`Output already exists: ${outputPath}`);
} catch (error) {
  if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") {
    throw error;
  }
}

const upstream = Buffer.from(await Bun.file(inputPath).arrayBuffer());
const generated = patchAsar(upstream, { controlOrigin, dataHost });
await writeFile(outputPath, generated.buffer, { flag: "wx", mode: 0o600 });
console.log(JSON.stringify(generated.report, null, 2));

function readFlag(arguments_: string[], name: string): string | undefined {
  const index = arguments_.indexOf(name);
  return index === -1 ? undefined : arguments_[index + 1];
}

function usage(): never {
  console.error(
    "Usage: bun run tools/patch-client.ts <input.asar> <output.asar> " +
      "--control-origin <origin> --data-host <host[:port]>",
  );
  process.exit(2);
}
