import { createHash, randomBytes } from "node:crypto";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { AsarArchive } from "./asar";
import { inspectMacOSArtifact } from "./macos-artifact";

const [rootArgument, asarArgument, ...flags] = Bun.argv.slice(2);
const appArgument = readFlag(flags, "--app");
if (!rootArgument || !asarArgument || !appArgument) {
  console.error(
    "Usage: bun run tools/prepare-e2e.ts <run-directory> <patched.asar> " +
      "--app <Blackglass Bridge.app>",
  );
  process.exit(2);
}

const root = resolve(rootArgument);
const asar = resolve(asarArgument);
const projectDataRoot = resolve(import.meta.dir, "../.data/e2e");
if (!root.startsWith(`${projectDataRoot}/`)) {
  throw new Error(`E2E directory must be inside ${projectDataRoot}`);
}
const archive = await AsarArchive.open(asar);
const packageMetadata = JSON.parse(archive.read("package.json").toString("utf8")) as {
  version?: string;
};
if (!packageMetadata.version || !/^\d+\.\d+\.\d+$/.test(packageMetadata.version)) {
  throw new Error("Compatibility ASAR has no semantic renderer version");
}
archive.read("app.js");
const adapterBytes = Buffer.from(await Bun.file(asar).arrayBuffer());
const clientArtifact = await inspectMacOSArtifact(appArgument);
if (clientArtifact.version !== packageMetadata.version) {
  throw new Error(
    `App/renderer version mismatch: ${clientArtifact.version} != ${packageMetadata.version}`,
  );
}
if (
  clientArtifact.embeddedAsarSha256 !==
  createHash("sha256").update(adapterBytes).digest("hex")
) {
  throw new Error("Packaged app does not embed the prepared compatibility ASAR");
}
const adapterFileName = `obsidian-${packageMetadata.version}.asar`;
const runManifest = {
  schemaVersion: 1,
  createdAt: new Date().toISOString(),
  rendererVersion: packageMetadata.version,
  adapterFileName,
  compatibilityAsarSha256: createHash("sha256").update(adapterBytes).digest("hex"),
};
await mkdir(projectDataRoot, { recursive: true });
await mkdir(root, { recursive: false });
await writeFile(
  resolve(root, "run-manifest.json"),
  `${JSON.stringify(runManifest, null, 2)}\n`,
  { flag: "wx", mode: 0o600 },
);
await writeFile(
  resolve(root, "client-artifact.json"),
  `${JSON.stringify(clientArtifact, null, 2)}\n`,
  { flag: "wx", mode: 0o600 },
);

const clients = ["client-a", "client-b"] as const;
for (const client of clients) {
  const userData = resolve(root, client, "user-data");
  const vault = resolve(root, client, "vault");
  await mkdir(userData, { recursive: true });
  await mkdir(vault, { recursive: true });
  await copyFile(asar, resolve(userData, adapterFileName));
  const vaultId = randomBytes(8).toString("hex");
  await writeFile(resolve(userData, `${vaultId}.json`), "{}", {
    flag: "wx",
    mode: 0o600,
  });
  await writeFile(
    resolve(userData, "obsidian.json"),
    JSON.stringify({
      updateDisabled: true,
      vaults: {
        [vaultId]: {
          path: vault,
          ts: Date.now(),
          open: true,
        },
      },
    }),
    { flag: "wx", mode: 0o600 },
  );
}

const environment = {
  email: "e2e@example.test",
  password: `pw-${randomBytes(18).toString("base64url")}`,
  token: randomBytes(32).toString("base64url"),
  e2ePassword: `vault-${randomBytes(18).toString("base64url")}`,
};
await writeFile(
  resolve(root, "credentials.json"),
  JSON.stringify(environment, null, 2),
  { flag: "wx", mode: 0o600 },
);

function readFlag(arguments_: string[], name: string): string | undefined {
  const index = arguments_.indexOf(name);
  return index === -1 ? undefined : arguments_[index + 1];
}

console.log(
  JSON.stringify(
    {
      root,
      runManifest,
      database: resolve(root, "server.sqlite"),
      credentials: resolve(root, "credentials.json"),
      clientA: {
        userData: resolve(root, "client-a/user-data"),
        vault: resolve(root, "client-a/vault"),
      },
      clientB: {
        userData: resolve(root, "client-b/user-data"),
        vault: resolve(root, "client-b/vault"),
      },
    },
    null,
    2,
  ),
);
