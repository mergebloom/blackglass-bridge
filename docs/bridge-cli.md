# Standalone Bridge

The macOS Apple Silicon release includes a separately downloadable
`blackglass-bridge-vVERSION-macos-arm64` executable and ZIP. It embeds only the
independent adapter and reviewed hash-and-offset compatibility baselines. It
does not contain Obsidian code, assets, or application binaries. End users do
not need Bun, Node.js, npm, or a source checkout.

Verify the adjacent checksum, make the executable runnable, and adapt an
official artifact you obtained legitimately:

```sh
shasum -a 256 -c blackglass-bridge-vVERSION-macos-arm64.sha256
chmod 0755 blackglass-bridge-vVERSION-macos-arm64
./blackglass-bridge-vVERSION-macos-arm64 adapt \
  --dmg /path/to/Obsidian-VERSION.dmg \
  --control-origin https://sync-control.example.com \
  --data-host sync-data.example.com \
  --output "$HOME/Desktop/Blackglass-output"
```

`--app /Applications/Obsidian.app` may replace `--dmg` when the installed app
tree exactly matches a reviewed baseline. A DMG-supplied build has the stronger
upstream provenance required for formal conformance and publication.

The command fails if the upstream identity, renderer inventory, wrapper,
incision hashes, code inventory, endpoint format, or output path differs from
the reviewed contract. It creates `Blackglass Bridge.app`, a release manifest,
and a package receipt. It also installs an owner-only, hash-addressed copy of the
official runtime under `~/Library/Application Support/Blackglass Runtimes/Official`;
neither the supplied artifact nor an installed Obsidian app is
modified.

The launcher contains only the standalone Blackglass executable and the
locally adapted renderer. It verifies the private official runtime before every
launch, refuses to run beside an unmanaged Obsidian instance, selects one exact
reviewed renderer alias, uses an isolated Blackglass profile, disables renderer
updates, generates a local `blackglass` CLI from the verified upstream CLI, and
supervises the official child until shutdown. The private runtime preserves the
upstream executable, helper, and application identity required for Electron
stability; native menus and windows therefore retain Obsidian's identity.

Do not redistribute the locally generated launcher or adapted renderer.
Official Blackglass Bridge release assets contain neither. Blackglass is
independent from and not endorsed by Obsidian; users must supply their own
legitimate Obsidian installation. This is a distribution boundary, not a legal
conclusion.
