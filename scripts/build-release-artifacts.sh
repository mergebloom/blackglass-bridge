#!/usr/bin/env bash
set -euo pipefail

if [[ $# -gt 2 ]]; then
  echo "usage: $0 [tree-ish] [output-directory]" >&2
  exit 2
fi

ref=${1:-HEAD}
out_dir=${2:-dist/release}
commit=$(git rev-parse --verify "${ref}^{commit}") || {
  echo "error: ${ref} does not resolve to a commit" >&2
  exit 1
}

# Read the version from the exact Git object being archived, not the worktree.
package_json=$(git show "${commit}:package.json") || {
  echo "error: ${ref} does not contain package.json" >&2
  exit 1
}
version=$(printf '%s' "$package_json" | node -e '
  let input = "";
  process.stdin.on("data", chunk => input += chunk);
  process.stdin.on("end", () => {
    const version = JSON.parse(input).version;
    if (typeof version !== "string" || !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/.test(version)) process.exit(1);
    process.stdout.write(version);
  });
') || {
  echo "error: package.json at ${ref} has no valid semantic version" >&2
  exit 1
}

name="blackglass-bridge-v${version}-tooling"
archive="${out_dir}/${name}.tar.gz"
checksum="${archive}.sha256"
mkdir -p "$out_dir"
rm -f "$archive" "$checksum"

# This allowlist is the release boundary. Do not replace it with `git archive <ref>`:
# unrelated tracked files could include proprietary upstream/generated artifacts.
release_paths=(
  .editorconfig
  .gitattributes
  .gitignore
  AGENTS.md
  CONTRIBUTING.md
  LICENSE
  README.md
  SECURITY.md
  package.json
  package-lock.json
  tsconfig.json
  docs
  packages
  scripts
  tests
  tools
)

git archive --format=tar --prefix="${name}/" "$commit" -- "${release_paths[@]}" \
  | gzip -n -9 > "$archive"

# Defense in depth: reject artifact-like paths even if someone expands the allowlist.
if tar -tzf "$archive" | grep -Eiq '(^|/)(artifacts?|fixtures/private|node_modules|coverage|vaults?|profiles?|generated|dist|build)(/|$)|\.(asar|app|dmg|pkg|exe|msi)$'; then
  echo "error: release archive contains a forbidden generated/proprietary artifact path" >&2
  rm -f "$archive" "$checksum"
  exit 1
fi

(
  cd "$out_dir"
  sha256sum "$(basename "$archive")" > "$(basename "$checksum")"
)

printf '%s\n%s\n' "$archive" "$checksum"
