# Blackglass Bridge

Blackglass Bridge is desktop compatibility tooling for using the built-in
Obsidian Sync experience with a self-hosted Blackglass Server.

It analyzes an authorized desktop release, changes the control and data
endpoints, enforces a separate mode-`0700` local profile with upstream updates
disabled, rebuilds the package integrity metadata, and creates a separately
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

The long-term target is the existing app experience with no loss of
functionality while its services are self-hosted. The supported table below
states what has been implemented and requalified so far.

Bridge uses six fixed-length client-ASAR incisions: three adapt the control and
Sync endpoints, while three isolate the macOS CLI runtime root, socket, and
registration name. Two fixed-length incisions apply the same socket name to the
universal CLI binary. Three fail-closed wrapper incisions isolate Blackglass
state with mode-`0700` enforcement, disable the upstream package updater, and
force the embedded qualified renderer. The GUI keeps the native `HOME` needed
by macOS secure storage; a private `BLACKGLASS_HOME` selects Bridge state. The
exact artifacts are requalified with end-to-end tests so future Obsidian
updates remain a small, repeatable maintenance task.

Blackglass began as a research project exploring frontier language-model
capabilities in minified-code analysis, protocol recovery, clean-room compatible
implementation, release adaptation, and end-to-end validation. Model-assisted
findings are accepted only when backed by deterministic tooling and tests.

## How it works

1. Compare the authorized renderer with its reviewed, versioned compatibility baseline.
2. Require exact anchor, request-helper, network-constructor, route,
   Sync-operation, and message-shape inventories.
3. Generate a deterministic compatibility ASAR for the chosen server URLs.
4. Patch the copied wrapper to isolate state, disable updates, and pin the embedded renderer.
5. Package and sign two independent `Blackglass Bridge.app` outputs, then require
   distinct invocation receipts plus matching manifests and artifact identities.
6. Bind that reproducibility proof while qualifying the exact client and server
   artifact pair with multipart Sync and recovery E2E.

The client adapter is release-specific. The Sync protocol and durable data live
in the separate Blackglass Server project, normally checked out beside this one
as `../blackglass-server`.

## Supported scope

| Area | Current support |
| --- | --- |
| Platform | macOS on Apple Silicon |
| Renderer | Obsidian 1.12.7 |
| Client behavior | Built-in sign-in; remote-vault create/list/access; E2EE Sync including multipart attachments; source-loss recovery UI |
| Packaging | Separate app identity, ad-hoc local signing, updates disabled |
| Server | Blackglass Server over loopback or HTTPS/WSS |

Mobile, Windows, Intel-only Macs, Publish, sharing, and automatic compatibility
with later Obsidian releases are not qualified yet.

## Quick start

Requirements: Bun 1.3.8 (pinned in `.bun-version`), Node.js/npm for the
lockfile-verified dependency install and E2E TLS proxy, and an authorized
official Obsidian DMG.

```sh
npm ci
bun run analyze:release -- \
  '/Volumes/Obsidian/Obsidian.app/Contents/Resources/obsidian.asar' \
  --resources '/Volumes/Obsidian/Obsidian.app/Contents/Resources'
bun run patch:client -- \
  '/Volumes/Obsidian/Obsidian.app/Contents/Resources/obsidian.asar' \
  /tmp/blackglass-bridge.asar \
  --resources '/Volumes/Obsidian/Obsidian.app/Contents/Resources' \
  --control-origin http://127.0.0.1:3000 \
  --data-host 127.0.0.1:3003
bun run package:macos -- \
  '/Volumes/Obsidian/Obsidian.app' \
  /tmp/blackglass-bridge.asar \
  '/path/to/Blackglass Bridge.app' \
  --control-origin http://127.0.0.1:3000 \
  --data-host 127.0.0.1:3003 \
  --official-dmg /path/to/Obsidian.dmg \
  --manifest /path/to/blackglass-bridge-release.json \
  --receipt /path/to/blackglass-bridge-package-receipt.json
bun run check
```

Before E2E qualification, repeat the package command into a different output
directory and run `package:macos:verify-reproducibility` with both invocation
receipts as shown in the E2E guide. Preparation refuses an app without that
bound two-build evidence.

For a real deployment, use HTTPS/WSS endpoints and follow the
[deployment guide](docs/deployment.md). Run the packaged-client qualification in
[the E2E guide](docs/e2e.md) before relying on a generated build.

## Updating for a new Obsidian release

Each upstream release must be treated as unknown: retain the DMG hash, rerun static
analysis, review and commit a new compatibility baseline, generate a new app,
then pass Sync and source-loss recovery E2E against the intended server binary.
Any new, removed, or changed packed or unpacked JavaScript file, anchor, route,
Sync operation, or message shape stops the build. The stable self-hosted server
URLs do not need to change.

`bun run baseline:candidate -- <official.dmg> <Obsidian.app> --predecessor
<reviewed-baseline.json>` creates a deterministic, untrusted predecessor-diff
packet under ignored `.data/compatibility-candidates/`. It never updates the
tracked baseline; follow the review and manual-promotion process in
[`compatibility/README.md`](compatibility/README.md).

## Safety and distribution

The official application, generated ASARs and apps, credentials, profiles, and
vault contents are inputs or ignored local artifacts. Do not commit or
redistribute them. Generated apps contain proprietary upstream code and are not
notarized distribution artifacts; share this tooling and require authorized
users to supply their own official release.

Blackglass redirects the built-in account and Sync traffic; it is not a general
network sandbox for Obsidian. Features such as Help, community plugins, embeds,
and other upstream integrations may still contact their own external services.

The copied app uses bundle identifier `com.blackglass.bridge`, does not register
Obsidian's URL scheme or iCloud container, and uses a dedicated profile so it
can coexist with an ordinary Obsidian installation. Its outer app filename and
display name are Blackglass Bridge, while the upstream `Obsidian` bundle name,
main executable, and Electron helper topology remain unchanged for runtime
compatibility.

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
