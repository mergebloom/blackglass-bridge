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
the reviewed contract. It creates a new `Blackglass.app`, release manifest, and
package receipt. The source app is never modified. The generated app uses an
isolated Blackglass profile, disables upstream application updates, and keeps
the upstream executable/helper names required for Electron stability.

The output app contains the user-supplied proprietary application and is for
that user’s local use. Do not redistribute it. Blackglass is independent from
and not endorsed by Obsidian; users must supply their own legitimate Obsidian
installation. This is a distribution boundary, not a legal conclusion.
