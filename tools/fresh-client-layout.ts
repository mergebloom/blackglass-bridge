import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export async function stageFreshClientLayout(input: {
  stagingRoot: string;
  finalVaultPath: string;
  adapterFileName: string;
  adapter: Uint8Array;
  timestamp: number;
}): Promise<void> {
  await mkdir(join(input.stagingRoot, "user-data"), { recursive: true, mode: 0o700 });
  await mkdir(join(input.stagingRoot, "vault"), { recursive: true, mode: 0o700 });
  await writeFile(join(input.stagingRoot, "user-data", input.adapterFileName), input.adapter, {
    flag: "wx",
    mode: 0o600,
  });
  const vaultKey = createHash("sha256")
    .update(input.finalVaultPath)
    .digest("hex")
    .slice(0, 16);
  await writeFile(join(input.stagingRoot, "user-data", `${vaultKey}.json`), "{}", {
    flag: "wx",
    mode: 0o600,
  });
  await writeFile(
    join(input.stagingRoot, "user-data", "obsidian.json"),
    `${JSON.stringify({
      updateDisabled: true,
      vaults: {
        [vaultKey]: { path: input.finalVaultPath, ts: input.timestamp, open: true },
      },
    }, null, 2)}\n`,
    { flag: "wx", mode: 0o600 },
  );
}
