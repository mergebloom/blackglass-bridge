#!/usr/bin/env bash
set -euo pipefail

if [[ $# -gt 2 ]]; then
  echo "usage: $0 [full-source-revision] [output-directory]" >&2
  exit 2
fi

root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
revision=${1:-$(git -C "$root" rev-parse HEAD)}
output=${2:-"$root/dist/release"}
[[ "$revision" =~ ^[a-f0-9]{40}$ ]] || {
  echo "source revision must be a full lowercase Git commit" >&2
  exit 1
}

metadata=$(cd -- "$root" && bun run tools/release-build-metadata.ts "$revision")
version=$(bun -e 'const v=JSON.parse(await Bun.stdin.text()); process.stdout.write(v.version)' <<<"$metadata")
tooling_source=$(bun -e 'const v=JSON.parse(await Bun.stdin.text()); process.stdout.write(JSON.stringify(v.toolingSource))' <<<"$metadata")
version_define=$(printf '%s' "$version" | bun -e 'process.stdout.write(JSON.stringify(await Bun.stdin.text()))')
revision_define=$(printf '%s' "$revision" | bun -e 'process.stdout.write(JSON.stringify(await Bun.stdin.text()))')
tooling_define=$(printf '%s' "$tooling_source" | bun -e 'process.stdout.write(JSON.stringify(await Bun.stdin.text()))')

mkdir -p "$output"
output=$(cd -- "$output" && pwd -P)
base="blackglass-bridge-v${version}-macos-arm64"
binary="$output/$base"
archive="$output/$base.zip"
manifest="$output/$base.json"
existing=0
for path in "$binary" "$binary.sha256" "$archive" "$archive.sha256" "$manifest"; do
  [[ ! -e "$path" && ! -L "$path" ]] || existing=$((existing + 1))
done
if [[ $existing -gt 0 ]]; then
  if [[ $existing -ne 5 ]]; then
    echo "refusing partial standalone release output in $output" >&2
    exit 1
  fi
  cd -- "$root"
  bun run tools/verify-standalone-bridge.ts "$output" "$revision"
  exit 0
fi

build_root="/private/tmp/blackglass-bridge-standalone-${revision}"
build_lock="${build_root}.lock"
if ! mkdir "$build_lock"; then
  echo "standalone build path is already locked: $build_lock" >&2
  exit 1
fi
staging=
cleanup() {
  rm -rf -- "$build_root"
  rmdir -- "$build_lock" 2>/dev/null || true
  if [[ -n "$staging" ]]; then rm -rf -- "$staging"; fi
}
trap cleanup EXIT HUP INT TERM
rm -rf -- "$build_root"
mkdir -p "$build_root"
git -C "$root" archive --format=tar "$revision" | tar -xf - -C "$build_root"
[[ -d "$root/node_modules" && ! -L "$root/node_modules" ]] || {
  echo "verified development dependencies are required to build the standalone Bridge" >&2
  exit 1
}
(cd -- "$root" && bun run tools/verify-release-dependencies.ts >/dev/null)
cp -R -- "$root/node_modules" "$build_root/node_modules"
(cd -- "$build_root" && bun run tools/verify-release-dependencies.ts >/dev/null)

cd -- "$build_root"
bun build --compile --target=bun-darwin-arm64 tools/bridge-cli.ts \
  --outfile "$binary" \
  --define "__BLACKGLASS_BRIDGE_VERSION__=$version_define" \
  --define "__BLACKGLASS_BRIDGE_REVISION__=$revision_define" \
  --define "__BLACKGLASS_TOOLING_SOURCE_JSON__=$tooling_define"
chmod 0755 "$binary"

binary_sha=$(shasum -a 256 "$binary" | awk '{print $1}')
baseline_1127=$(shasum -a 256 "$root/compatibility/obsidian-1.12.7.json" | awk '{print $1}')
baseline_1134=$(shasum -a 256 "$root/compatibility/obsidian-1.13.4.json" | awk '{print $1}')
bun -e '
  const [path, version, revision, binary, binarySha, first, second, toolingSource] = Bun.argv.slice(1);
  await Bun.write(path, JSON.stringify({
    schemaVersion: 2,
    name: "blackglass-bridge",
    version,
    sourceRevision: revision,
    toolingSource: JSON.parse(toolingSource),
    target: { operatingSystem: "macOS", architecture: "arm64" },
    executable: binary,
    executableSha256: binarySha,
    embeddedCompatibilityBaselines: [
      { rendererVersion: "1.12.7", sha256: first },
      { rendererVersion: "1.13.4", sha256: second },
    ],
  }, null, 2) + "\n");
' "$manifest" "$version" "$revision" "$base" "$binary_sha" "$baseline_1127" "$baseline_1134" "$tooling_source"

staging=$(mktemp -d "${TMPDIR:-/tmp}/blackglass-bridge-release.XXXXXX")
cp -- "$binary" "$manifest" "$root/LICENSE" "$root/docs/bridge-cli.md" "$staging/"
mv -- "$staging/bridge-cli.md" "$staging/INSTALL.md"
find "$staging" -exec touch -t 198001010000 {} +
(cd -- "$staging" && COPYFILE_DISABLE=1 zip -X -9 -q "$archive" ./*)

(cd -- "$output" && shasum -a 256 "$base" > "$base.sha256")
(cd -- "$output" && shasum -a 256 "$base.zip" > "$base.zip.sha256")
cd -- "$root"
bun run tools/verify-standalone-bridge.ts "$output" "$revision"
printf '%s\n%s\n%s\n%s\n%s\n' \
  "$binary" "$binary.sha256" "$archive" "$archive.sha256" "$manifest"
