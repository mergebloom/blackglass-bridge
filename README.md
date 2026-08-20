<p align="center">
  <img src="assets/blackglass-prism.png" width="144" alt="Blackglass prism">
</p>

<h1 align="center">Blackglass Bridge</h1>

Blackglass Bridge adapts a user-supplied official Obsidian desktop installation
to a user-selected [Blackglass Server](https://github.com/mergebloom/blackglass-server).
The intended result is self-hosted Sync with the native desktop application UX,
full control of service location and stored data, and a repeatable maintenance
path as new Obsidian releases appear.

The Bridge verifies an exact reviewed upstream artifact, applies narrow
endpoint and CLI incisions to a local renderer, and emits an independently
identified Blackglass launcher plus an auditable receipt. It supports
`Blackglass.app` on Apple Silicon macOS and rootless desktop/CLI installation
images on Linux amd64 and arm64. The launcher uses a private, byte-verified copy
of the official runtime without modifying the installed app, starts it with a
separate mode-`0700` profile, disables upstream renderer updates, and supervises
the complete session. Keeping the official executable and helper identity
avoids the runtime instability caused by renaming proprietary Electron
components.

## Install and adapt

Each release provides standalone executables and ZIPs for Apple Silicon macOS,
Linux amd64, and Linux arm64. End users need the matching official Obsidian DMG,
application, or Linux tar archive; Bun, Node, npm, and a source checkout are not
required.

```sh
shasum -a 256 -c blackglass-bridge-vVERSION-macos-arm64.sha256
chmod 0755 blackglass-bridge-vVERSION-macos-arm64
./blackglass-bridge-vVERSION-macos-arm64 adapt \
  --dmg /path/to/Obsidian-VERSION.dmg \
  --control-origin https://sync-control.example.com \
  --data-host sync-data.example.com \
  --output "$HOME/Desktop/Blackglass-output"
```

See the [standalone guide](docs/bridge-cli.md) for app input and output details.
Operators should deploy the companion Server first so the two exact HTTPS/WSS
endpoints are ready.

On Linux, select the executable matching `uname -m`, replace `VERSION`, and use
the matching official 1.13.4 archive:

```sh
chmod 0755 blackglass-bridge-vVERSION-linux-amd64
./blackglass-bridge-vVERSION-linux-amd64 adapt \
  --tar "$HOME/Downloads/obsidian-1.13.4.tar.gz" \
  --control-origin https://sync-control.example.com \
  --data-host sync-data.example.com \
  --output "$HOME/Downloads/Blackglass-linux"
"$HOME/Downloads/Blackglass-linux/install.sh"
blackglass --launch
```

## Support and conformance

Desktop Apple Silicon macOS and Sync are the initial fully conformed product
surface. The
[generated compatibility matrix](compatibility/MATRIX.md) is the sole support
claim for exact renderer, Bridge, Server, platform, scenario, report, and date
combinations. A row appears only after packaged-client release/recovery,
tenancy, custom-E2EE collaboration, and managed-encryption collaboration all
pass against source-bound artifacts.

Linux 1.13.4 desktop/CLI installers for amd64 and arm64 pass exact upstream,
adaptation, installation, launch, isolated-socket, and CLI forwarding checks.
They are not yet in the compatibility matrix because the full Linux Sync E2E
suite has not run. Windows, Intel Mac, mobile, Publish, and unrelated Obsidian
services are future work. Blackglass redirects the account and Sync traffic; it
is not a network sandbox for plugins, embeds, Help, or other upstream features.

The conformance suite covers authentication/session isolation, exact control
and WebSocket shapes, owner/collaborator attribution and lifecycle, outsider
isolation, background bidirectional Sync, mixed files and deletion, restart,
backup/restore/migration, clean-profile recovery, packaging, reproducibility,
secret redaction, and hash-chained evidence.

## Develop and qualify

Development uses the pinned Bun runtime and lockfile:

```sh
npm ci
bun run check
```

`release:candidate:create` freezes the exact clean Bridge/Server revisions and
reviewed artifact identities. `release:run` performs resumable checks, native
and Linux builds, two independent macOS packages, reproducibility, and E2E
preparation. Completed stages are hash-receipted; partial, changed, or
revision-mismatched state fails closed. See [E2E](docs/e2e.md) and
[compatibility maintenance](compatibility/README.md).

## Project boundary

This repository owns client inspection, reviewed compatibility baselines,
local adaptation, macOS/Linux packaging, client release artifacts, E2E
orchestration, and the conformance suite. The Server repository owns the Rust service, SQLite
schema and migrations, Linux/container artifacts, deployment, backups, and
operations. Detailed concerns live in their owning repository and are linked
rather than duplicated.

The public project does not contain or distribute Obsidian applications,
ASARs, extracted/minified source, proprietary assets, locally generated adapted
renderers, or private deployment data. Official Bridge releases contain only
Blackglass code and reviewed hash/offset baselines. The locally generated
launcher contains the user's adapted renderer and is not a public release
asset. Release and repository gates scan for forbidden artifacts, private
identifiers, domains, and secret patterns.

Obsidian is a third-party product. Blackglass is independent and is not
affiliated with or endorsed by Obsidian. Users must supply their own legitimate
Obsidian installation. This note describes the project boundary, not a legal
conclusion.

Blackglass began as a research project exploring frontier LLM capabilities in
software analysis, compatibility engineering, clean-room implementation, and
end-to-end validation. Deterministic checks and executable evidence—not model
output—control support claims.

## Documentation

| Guide | Owner |
| --- | --- |
| [User guide](https://mergebloom.github.io/blackglass-bridge/) | Beginner setup, client adaptation, operations, and guided prompts |
| [Architecture](docs/architecture.md) | Client adaptation and safety boundary |
| [Standalone Bridge](docs/bridge-cli.md) | No-development-dependency user workflow |
| [Compatibility maintenance](compatibility/README.md) | Future renderer review and promotion |
| [Compatibility matrix](compatibility/MATRIX.md) | Exact supported combinations |
| [E2E](docs/e2e.md) | Conformance operation and evidence |
| [Deployment](docs/deployment.md) | Endpoint topology and Bridge rollout |
| [`$qualify-obsidian-release`](.agents/skills/qualify-obsidian-release/SKILL.md) | Repository-local agent workflow for a new release |

See [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md), and the
[MIT License](LICENSE). The license does not cover Obsidian or generated apps.
