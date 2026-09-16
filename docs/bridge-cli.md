# Standalone Bridge

Releases include separately downloadable executables and ZIPs for Apple Silicon
macOS, Linux amd64, and Linux arm64. They embed only the independent adapter and
reviewed hash-and-offset compatibility baselines. They do not contain Obsidian
code, assets, or application binaries. End users do not need Bun, Node.js, npm,
or a source checkout.

## macOS

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
the reviewed contract. It creates a self-contained `Blackglass.app`, a release
manifest, and a package receipt. The reviewed official runtime is copied into
the generated app; neither the supplied artifact nor an installed Obsidian app
is modified.

The generated app contains the standalone Blackglass executable, the locally
adapted renderer, and the user's reviewed official runtime. It verifies that
embedded official runtime before every launch, refuses to run beside an
unmanaged Obsidian instance, selects one exact
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

## macOS profile upgrades

Quit the current client before opening a newly adapted, reviewed version. The
launcher records the selected renderer hash in the isolated profile and keeps
hash-addressed renderer history. A journal makes interrupted switches resumable
by reopening the same new app. Account settings, vault registrations, and local
notes are preserved; unknown aliases or mismatched hashes stop the launch.

For a profile created before renderer receipts existed, keep the previous
generated app. Perform the first upgrade with:

```sh
open /path/to/new/Blackglass.app --args \
  --blackglass-previous-app /path/to/previous/Blackglass.app
```

Both apps must verify, and the previous renderer must match the profile. Later
upgrades use the receipt automatically. Renderer history is not a vault backup:
back up local data before upgrades. Selecting an older renderer with a current
launcher is supported, but does not guarantee downgrade compatibility of
Obsidian's own local data formats. The runtime guard retries brief partial
settings writes for up to 500 ms; persistent corruption, renderer changes, or
disabled update protection still stop the client.

## Linux desktop and CLI

Use `linux-amd64` when `uname -m` prints `x86_64`; use `linux-arm64` when it
prints `aarch64` or `arm64`. Blackglass 0.5.0 Linux tooling accepts only the
reviewed official Obsidian 1.13.4 tar archive for that architecture:

| Architecture | Official archive | SHA-256 |
| --- | --- | --- |
| amd64 | `obsidian-1.13.4.tar.gz` | `ebac249f949b6894819fbb4bc5657ec8892f006cefed955d34a6c1ffe262f16b` |
| arm64 | `obsidian-1.13.4-arm64.tar.gz` | `e2d44d26369bd035e1ad58f63113073fb791b52f4c26cce22ced63b492a7136e` |

Verify and adapt without root access:

```sh
sha256sum -c blackglass-bridge-vVERSION-linux-amd64.sha256
chmod 0755 blackglass-bridge-vVERSION-linux-amd64
./blackglass-bridge-vVERSION-linux-amd64 adapt \
  --tar "$HOME/Downloads/obsidian-1.13.4.tar.gz" \
  --control-origin https://sync-control.example.com \
  --data-host sync-data.example.com \
  --output "$HOME/Downloads/Blackglass-linux"
"$HOME/Downloads/Blackglass-linux/install.sh"
```

The installer writes one versioned client below
`${XDG_DATA_HOME:-$HOME/.local/share}/blackglass`, a desktop entry and icon below
the XDG data directory, and a `blackglass` command below
`${XDG_BIN_HOME:-$HOME/.local/bin}`. Add that binary directory to `PATH` if your
desktop distribution does not already do so.

```sh
blackglass --launch       # start the desktop client
blackglass --help         # forward an Obsidian CLI request
blackglass version        # CLI commands require a registered/open vault
```

The isolated Blackglass profile enables CLI access, disables upstream updates,
and uses an owner-only runtime directory and `.blackglass-c.sock`; it does not
reuse the upstream CLI socket. Every launch re-verifies the official runtime,
adapted renderer, native CLI, and Bridge executable. The Linux client requires
a graphical desktop session and the common shared libraries required by the
official Obsidian tar distribution.

The generated Linux directory contains the user's official runtime and adapted
renderer. It is a local install image, not a public Blackglass release asset;
do not redistribute it.
