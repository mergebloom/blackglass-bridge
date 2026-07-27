# Blackglass Bridge

Blackglass Bridge is desktop compatibility tooling for using the built-in
Obsidian Sync experience with a self-hosted Blackglass Server.

It analyzes an authorized desktop release, changes only the control and data
endpoints, rebuilds the package integrity metadata, and creates a separately
identified macOS application for local use. It never modifies the installed
Obsidian application or a real user vault.

Blackglass is independent and is not affiliated with or endorsed by Obsidian.

## Project goal

The intended outcome is to use the Obsidian desktop app's existing Sync UX and
qualified Sync functionality with a fully self-hosted server. Users keep
control of their encrypted vault data, service, backups, retention, and network
location while retaining the familiar application workflow. This provides data
sovereignty and content privacy; the server remains able to observe limited
operational metadata.

Bridge keeps the client-side change to two semantic endpoint adaptations and
requalifies the exact artifacts with end-to-end tests. That boundary is meant
to make future Obsidian updates a small, repeatable maintenance task instead of
maintaining a permanent application fork.

Blackglass began as a research project exploring frontier language-model
capabilities in minified-code analysis, protocol recovery, clean-room compatible
implementation, release adaptation, and end-to-end validation. Model-assisted
findings are accepted only when backed by deterministic tooling and tests.

## How it works

1. Inspect the authorized renderer and locate semantic endpoint anchors.
2. Require exactly one match for each anchor and fail closed otherwise.
3. Generate a deterministic compatibility ASAR for the chosen server URLs.
4. Package and sign a separate `Blackglass Bridge.app` with an isolated profile.
5. Qualify that exact client and server artifact pair with Sync and recovery E2E.

The client adapter is release-specific. The Sync protocol and durable data live
in the separate Blackglass Server project, normally checked out beside this one
as `../blackglass-server`.

## Supported scope

| Area | Current support |
| --- | --- |
| Platform | macOS on Apple Silicon |
| Renderer | Obsidian 1.12.7 |
| Client behavior | Built-in account, remote-vault, E2EE, Sync, and recovery UI |
| Packaging | Separate app identity, ad-hoc local signing, updates disabled |
| Server | Blackglass Server over loopback or HTTPS/WSS |

Mobile, Windows, Intel-only Macs, Publish, sharing, and automatic compatibility
with later Obsidian releases are not qualified yet.

## Quick start

Requirements: Bun 1.3 or newer and an authorized official Obsidian application
or renderer artifact.

```sh
bun install
bun run analyze:release -- /path/to/obsidian.asar
bun run patch:client -- \
  /path/to/obsidian.asar \
  /tmp/blackglass-bridge.asar \
  --control-origin http://127.0.0.1:3000 \
  --data-host 127.0.0.1:3003
bun run package:macos -- \
  '/Volumes/Obsidian/Obsidian.app' \
  /tmp/blackglass-bridge.asar \
  '/path/to/Blackglass Bridge.app'
bun run check
```

For a real deployment, use HTTPS/WSS endpoints and follow the
[deployment guide](docs/deployment.md). Run the packaged-client qualification in
[the E2E guide](docs/e2e.md) before relying on a generated build.

## Updating for a new Obsidian release

Each upstream release must be treated as unknown: retain its hash, rerun static
analysis and exact-match adapter tests, generate a new app, then pass Sync and
source-loss recovery E2E against the intended server binary. A changed or
ambiguous semantic anchor stops the build instead of silently using an upstream
endpoint. The stable self-hosted server URLs do not need to change.

## Safety and distribution

The official application, generated ASARs and apps, credentials, profiles, and
vault contents are inputs or ignored local artifacts. Do not commit or
redistribute them. Generated apps contain proprietary upstream code and are not
notarized distribution artifacts; share this tooling and require authorized
users to supply their own official release.

The copied app uses bundle identifier `com.blackglass.bridge`, does not register
Obsidian's URL scheme or iCloud container, and uses a dedicated profile so it
can coexist with an ordinary Obsidian installation.

Tagged GitHub releases publish only a deterministic, allowlisted tooling source
archive and its SHA-256 checksum. They never contain an official Obsidian
release, a generated ASAR or application, credentials, profiles, or vault data.
The tag must exactly match the version in `package.json` (for example, `v0.1.0`).
Maintainers can reproduce the assets with:

```sh
scripts/build-release-artifacts.sh v0.1.0 dist/release
(cd dist/release && sha256sum --check blackglass-bridge-v0.1.0-tooling.tar.gz.sha256)
```

## Validation

Sanitized evidence lives in [docs/validation](docs/validation/README.md).
Qualification is bound to the exact renderer, generated ASAR, packaged app, and
server binary hashes; rebuilding any artifact requires a new result.

## Documentation

| Guide | Purpose |
| --- | --- |
| [Architecture](docs/architecture.md) | Adapter design, ownership, and safety boundaries |
| [Deployment](docs/deployment.md) | Endpoint layout, rollout, and release maintenance |
| [Client audit](docs/client-audit-1.12.7.md) | Findings for the initial qualified renderer |
| [Protocol](docs/protocol/obsidian-1.12.7.md) | Observed client-side Sync contract |
| [E2E](docs/e2e.md) | Two-client Sync and source-loss recovery procedure |

See [CONTRIBUTING.md](CONTRIBUTING.md) before sharing changes and
[SECURITY.md](SECURITY.md) for vulnerability reporting. The independently
written tooling is available under the [MIT License](LICENSE); that license does
not cover Obsidian or generated application artifacts.
