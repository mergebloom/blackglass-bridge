import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import baseline1134 from "../compatibility/obsidian-1.13.4.json" with { type: "text" };
import bridgeIconPath from "../assets/blackglass-prism.png" with { type: "file" };
import { patchAsar, canonicalAdapterOptions } from "../packages/client-adapter/src/patch";
import {
  applyReviewedBranding,
  brandingPlanForSource,
} from "../packages/client-adapter/src/branding";
import { patchLinuxRendererAsar } from "../packages/client-adapter/src/linux";
import { patchCliBinary } from "./cli-binary";
import { AsarArchive } from "./asar";
import {
  LINUX_CLIENT_COMPATIBILITY,
  linuxArchitecture,
  type LinuxClientCompatibility,
} from "./linux-compatibility";
import { type LinuxClientConfig, linuxClientConfigSha256 } from "./linux-client-config";
import { canonicalExistingPath, canonicalOutputPath } from "./path-safety";
import {
  discoverUnpackedJavaScriptFiles,
  qualifyRendererRelease,
} from "./release-compatibility";
import { stableJson } from "./stable-json";
import { computeTreeIdentity } from "./tree-identity";

export interface LinuxAdaptOptions {
  archive: string;
  controlOrigin: string;
  dataHost: string;
  output: string;
  blackglassVersion: string;
  bridgeRevision: string;
  bridgeExecutable: string;
}

export async function adaptLinuxClient(options: LinuxAdaptOptions): Promise<void> {
  if (process.platform !== "linux") throw new Error("Linux client adaptation must run on Linux");
  const architecture = linuxArchitecture();
  const compatibility = LINUX_CLIENT_COMPATIBILITY[architecture];
  const endpoints = canonicalAdapterOptions({
    controlOrigin: options.controlOrigin,
    dataHost: options.dataHost,
  });
  const archive = await canonicalExistingPath(options.archive, "Official Obsidian Linux archive", "file");
  const bridgeExecutable = await canonicalExistingPath(options.bridgeExecutable, "Standalone Blackglass Bridge", "file");
  const output = await canonicalOutputPath(options.output, "Blackglass Linux install image");
  const archiveSha256 = await sha256File(archive);
  if (archiveSha256 !== compatibility.upstreamArchive.sha256) {
    throw new Error(
      `Official archive is not the reviewed ${architecture} Obsidian ${compatibility.rendererVersion} artifact`,
    );
  }
  const temporary = await mkdtemp(join(tmpdir(), "blackglass-linux-adapt-"));
  const staging = join(dirname(output), `.${basename(output)}.next-${process.pid}`);
  let published = false;
  try {
    const extraction = join(temporary, "source");
    await mkdir(extraction, { mode: 0o700 });
    extractReviewedArchive(archive, extraction, compatibility);
    const sourceRuntime = await canonicalExistingPath(
      join(extraction, compatibility.upstreamArchive.rootDirectory),
      "Extracted official Linux runtime",
      "directory",
    );
    await verifySourceRuntime(sourceRuntime, compatibility);
    const resources = join(sourceRuntime, "resources");
    const rendererPath = join(resources, "obsidian.asar");
    const upstreamRenderer = await readFile(rendererPath);
    const baselinePath = join(temporary, "compatibility.json");
    await writeFile(baselinePath, baseline1134 as unknown as string, { flag: "wx", mode: 0o600 });
    const unpacked = await discoverUnpackedJavaScriptFiles(resources);
    const qualification = await qualifyRendererRelease(upstreamRenderer, baselinePath, unpacked);
    const rendererMetadata = JSON.parse(
      AsarArchive.fromBuffer(upstreamRenderer).read("package.json").toString("utf8"),
    ) as { version?: unknown };
    if (rendererMetadata.version !== compatibility.rendererVersion) {
      throw new Error("Official Linux renderer version changed");
    }
    const brandingPlan = brandingPlanForSource(compatibility.rendererVersion, sha256(upstreamRenderer));
    if (!brandingPlan) throw new Error("Official Linux renderer has no reviewed branding plan");
    const corePatched = patchAsar(
      upstreamRenderer,
      endpoints,
      qualification.loadedBaseline.baseline.patchIncisions,
    );
    const linuxPatched = patchLinuxRendererAsar(corePatched.buffer);
    const icon = await readFile(bridgeIconPath);
    const branded = applyReviewedBranding(
      upstreamRenderer,
      linuxPatched.buffer,
      brandingPlan,
      icon,
      endpoints.controlOrigin,
    );
    const generatedArchive = AsarArchive.fromBuffer(branded.buffer);
    const adapterReport = {
      ...corePatched.report,
      patchedSha256: sha256(branded.buffer),
      rendererAfterSha256: sha256(generatedArchive.read("app.js")),
      starterAfterSha256: sha256(generatedArchive.read("starter.js")),
      mainAfterSha256: sha256(generatedArchive.read("main.js")),
      branding: branded.report,
    };
    const upstreamCli = await readFile(join(sourceRuntime, "obsidian-cli"));
    const patchedCli = patchCliBinary(upstreamCli);

    await mkdir(staging, { mode: 0o700 });
    await Promise.all([
      mkdir(join(staging, "libexec"), { mode: 0o700 }),
      mkdir(join(staging, "resources"), { mode: 0o700 }),
      mkdir(join(staging, "share"), { mode: 0o700 }),
    ]);
    await cp(sourceRuntime, join(staging, "runtime"), {
      recursive: true,
      force: false,
      errorOnExist: true,
      preserveTimestamps: true,
    });
    await copyFile(bridgeExecutable, join(staging, "libexec/blackglass-bridge"));
    await writeFile(join(staging, "libexec/blackglass-cli"), patchedCli.buffer, { flag: "wx", mode: 0o755 });
    await writeFile(join(staging, "resources/blackglass.asar"), branded.buffer, { flag: "wx", mode: 0o600 });
    await writeFile(join(staging, "share/blackglass-prism.png"), icon, { flag: "wx", mode: 0o644 });
    await Promise.all([
      chmod(join(staging, "libexec/blackglass-bridge"), 0o755),
      chmod(join(staging, "libexec/blackglass-cli"), 0o755),
    ]);
    const bundleId = `v${options.blackglassVersion}-obsidian-${compatibility.rendererVersion}-linux-${architecture}-${archiveSha256.slice(0, 12)}`;
    await writeFile(
      join(staging, "libexec/blackglass-cli-shim"),
      cliShim(),
      { flag: "wx", mode: 0o755 },
    );
    await writeFile(join(staging, "install.sh"), installer(bundleId), { flag: "wx", mode: 0o755 });
    const config: LinuxClientConfig = {
      schemaVersion: 1,
      blackglassVersion: options.blackglassVersion,
      bridgeRevision: options.bridgeRevision,
      rendererVersion: compatibility.rendererVersion,
      architecture,
      endpoints,
      upstream: {
        archiveSha256,
        runtimeTree: compatibility.runtimeTree,
        rendererAsarSha256: compatibility.rendererAsarSha256,
        wrapperAsarSha256: compatibility.wrapperAsarSha256,
        executableSha256: compatibility.executableSha256,
        cliExecutableSha256: compatibility.cliExecutableSha256,
      },
      generated: {
        rendererSha256: sha256(branded.buffer),
        cliExecutableSha256: patchedCli.report.patchedSha256,
        bridgeExecutableSha256: await sha256File(join(staging, "libexec/blackglass-bridge")),
      },
      paths: {
        runtime: "runtime",
        renderer: "resources/blackglass.asar",
        cliExecutable: "libexec/blackglass-cli",
        cliShim: "libexec/blackglass-cli-shim",
        bridgeExecutable: "libexec/blackglass-bridge",
        icon: "share/blackglass-prism.png",
      },
      launchPolicy: {
        profileDirectory: "Blackglass",
        profileMode: 0o700,
        updateDisabled: true,
        cliEnabled: true,
        exactRuntimeVerifiedAtEveryLaunch: true,
        isolatedCliSocket: ".blackglass-c.sock",
      },
    };
    await writeFile(
      join(staging, "blackglass-client.json"),
      `${JSON.stringify(config, null, 2)}\n`,
      { flag: "wx", mode: 0o600 },
    );
    const receipt = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      publicReleaseEligible: false,
      userSuppliedOfficialRuntimeIncluded: true,
      redistributionAllowedByBlackglass: false,
      bundleId,
      configSha256: linuxClientConfigSha256(config),
      compatibility: {
        rendererVersion: compatibility.rendererVersion,
        architecture,
        upstreamArchiveSha256: archiveSha256,
      },
      patches: {
        renderer: adapterReport,
        linux: linuxPatched.report,
        cli: patchedCli.report,
      },
    };
    await writeFile(
      join(staging, "blackglass-install-receipt.json"),
      `${JSON.stringify(receipt, null, 2)}\n`,
      { flag: "wx", mode: 0o600 },
    );
    await rename(staging, output);
    published = true;
    console.log(JSON.stringify({
      passed: true,
      output,
      installCommand: `${output}/install.sh`,
      bundleId,
      architecture,
      rendererVersion: compatibility.rendererVersion,
      configSha256: linuxClientConfigSha256(config),
    }, null, 2));
  } finally {
    await rm(temporary, { recursive: true, force: true });
    if (!published) await rm(staging, { recursive: true, force: true });
  }
}

async function verifySourceRuntime(root: string, compatibility: LinuxClientCompatibility): Promise<void> {
  const tree = await computeTreeIdentity(root);
  if (stableJson(tree) !== stableJson(compatibility.runtimeTree)) {
    throw new Error("Official Linux runtime tree does not match its reviewed baseline");
  }
  for (const [path, expected, label] of [
    ["resources/obsidian.asar", compatibility.rendererAsarSha256, "renderer"],
    ["resources/app.asar", compatibility.wrapperAsarSha256, "wrapper"],
    ["obsidian", compatibility.executableSha256, "executable"],
    ["obsidian-cli", compatibility.cliExecutableSha256, "CLI executable"],
  ] as const) {
    if (await sha256File(join(root, path)) !== expected) {
      throw new Error(`Official Linux ${label} does not match its reviewed identity`);
    }
  }
}

function extractReviewedArchive(
  archive: string,
  destination: string,
  compatibility: LinuxClientCompatibility,
): void {
  const tar = Bun.which("tar");
  if (!tar) throw new Error("Linux adaptation requires tar");
  const listing = runText([tar, "-tzf", archive]).split("\n").filter(Boolean);
  if (listing.length < 1 || listing.length > 2_000) throw new Error("Official Linux archive has an unsafe entry count");
  const root = compatibility.upstreamArchive.rootDirectory;
  for (const entry of listing) {
    if (entry.startsWith("/") || entry.includes("\0") || entry.split("/").includes("..") ||
        (entry !== root && entry !== `${root}/` && !entry.startsWith(`${root}/`))) {
      throw new Error(`Official Linux archive contains an unsafe path: ${entry}`);
    }
  }
  run([tar, "-xzf", archive, "-C", destination, "--no-same-owner"]);
}

function cliShim(): string {
  return `#!/bin/sh
set -eu
data_home=\${XDG_DATA_HOME:-"$HOME/.local/share"}
root=$(readlink -f "$data_home/blackglass/current")
test -d "$root" || { echo "Blackglass is not installed" >&2; exit 1; }
bridge="$root/libexec/blackglass-bridge"
if [ "\${1-}" = "--launch" ]; then
  shift
  exec "$bridge" __linux-launch "$root" "$@"
fi
exec "$bridge" __linux-cli "$root" "$@"
`;
}

function installer(bundleId: string): string {
  return `#!/bin/sh
set -eu
self=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
data_home=\${XDG_DATA_HOME:-"$HOME/.local/share"}
bin_home=\${XDG_BIN_HOME:-"$HOME/.local/bin"}
base="$data_home/blackglass"
target="$base/clients/${bundleId}"
staging="$target.next-$$"
mkdir -p "$base/clients" "$bin_home" "$data_home/applications" "$data_home/icons/hicolor/512x512/apps"
if [ -e "$base/current" ] && [ ! -L "$base/current" ]; then
  echo "Refusing non-symlink Blackglass current pointer: $base/current" >&2
  exit 1
fi
if [ ! -d "$target" ]; then
  test ! -e "$staging"
  mkdir "$staging"
  cp -R "$self/." "$staging/"
  mv "$staging" "$target"
fi
cmp -s "$self/blackglass-client.json" "$target/blackglass-client.json" || {
  echo "Existing Blackglass installation differs from this image" >&2
  exit 1
}
ln -sfn "$target" "$base/current"
ln -sfn "$target/libexec/blackglass-cli-shim" "$bin_home/blackglass"
cp "$target/share/blackglass-prism.png" "$data_home/icons/hicolor/512x512/apps/blackglass.png"
cat > "$data_home/applications/blackglass.desktop" <<EOF
[Desktop Entry]
Name=Blackglass
Comment=Private, self-hosted knowledge base
Exec=$bin_home/blackglass --launch %U
Terminal=false
Type=Application
Icon=blackglass
StartupWMClass=Blackglass
MimeType=x-scheme-handler/obsidian;
Categories=Office;
EOF
chmod 0755 "$target/libexec/blackglass-bridge" "$target/libexec/blackglass-cli" "$target/libexec/blackglass-cli-shim"
printf 'Installed Blackglass. Run: %s\n' "$bin_home/blackglass --launch"
`;
}

function run(arguments_: string[]): void {
  const result = Bun.spawnSync(arguments_, { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString("utf8").trim());
}
function runText(arguments_: string[]): string {
  const result = Bun.spawnSync(arguments_, { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString("utf8").trim());
  return result.stdout.toString("utf8").trim();
}
async function sha256File(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}
function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
