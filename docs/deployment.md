# Deployment and client rollout

The production server is the Rust implementation in the companion Blackglass
Server repository. In a sibling checkout, follow
`../blackglass-server/docs/production.md` for the hardened native service, Caddy,
configuration, health/metrics, backups, restore drills, and rollback. The Bun
implementation is retained only as a protocol oracle.

## Endpoint layout

Use two public TLS names:

- `https://sync-control.example.com` -> `127.0.0.1:3000`
- `wss://sync-data.example.com` -> `127.0.0.1:3003`

Set `SELFHOST_DATA_HOST=sync-data.example.com` and generate the adapter with:

```sh
bun run patch:client -- \
  '/Volumes/Obsidian/Obsidian.app/Contents/Resources/obsidian.asar' \
  /path/to/generated-compatibility.asar \
  --resources '/Volumes/Obsidian/Obsidian.app/Contents/Resources' \
  --control-origin https://sync-control.example.com \
  --data-host sync-data.example.com
```

## Client rollout and upgrades

Generate one adapter per upstream release and endpoint pair. The adapter is not
the application: the official app wrapper remains installed and untouched. If
a fresh wrapper already embeds the same renderer version, create a separate
application copy:

```sh
bun run package:macos -- \
  '/Volumes/Obsidian/Obsidian.app' \
  /path/to/generated-compatibility.asar \
  '/path/to/Blackglass Bridge.app' \
  --control-origin https://sync-control.example.com \
  --data-host sync-data.example.com \
  --official-dmg /path/to/official-Obsidian.dmg \
  --manifest /path/to/blackglass-bridge-release.json
```

The packager verifies the DMG digest and complete extracted application tree
against the reviewed baseline, builds in a private staging directory, and only
publishes the app and manifest after every check passes. The output is ad-hoc
signed for local authorized use; it is not notarized for
redistribution. Its bundle identifier is `com.blackglass.bridge`; the packager
removes upstream URL-scheme and iCloud-container registrations so it can coexist
with normal Obsidian. The outer filename and display name are Blackglass Bridge,
but the upstream `Obsidian` bundle name, main executable, and Electron helper
topology are deliberately preserved. Launch it with a dedicated profile:

The copied wrapper still contains upstream proprietary code and artwork. Keep
it out of source control and distribution artifacts.

```sh
bun run client:launch -- \
  /path/to/generated-compatibility.asar \
  /path/to/dedicated-profile \
  /path/to/vault \
  --app '/path/to/Blackglass Bridge.app'
```

The packaged wrapper itself selects `~/Library/Application Support/Blackglass
Bridge`, disables its upstream package updater, and refuses downloaded renderer
overrides, including Finder launches. An explicit `--user-data-dir` remains
available for disposable isolated test clients. The launcher requires existing
profile and vault directories and refuses Obsidian's normal profile. Endpoint
inputs must be canonical: no trailing slash, case
normalization, default port spelling, path, credentials, query, or fragment.
For every upstream release:

1. verify and retain the official artifact and SHA-256 outside this project;
2. review a new versioned compatibility baseline and require its complete
   packed/unpacked-JavaScript, anchor, route, operation, and message-shape
   inventory to pass;
3. generate a new ASAR for canonical endpoints;
4. package a copied app; the packager independently reproduces and byte-compares
   the renderer and emits the bound release manifest;
5. run typecheck, packaging, Bun-oracle, Rust, cross-implementation protocol,
   and isolated packaged-client recovery checks;
6. require the E2E report's release-manifest, server, wrapper, app, endpoint, and
   compatibility-ASAR identities to match the intended release artifacts;
7. roll out the qualified build without changing the stable server endpoints.

An unqualified upstream client update is expected to fail closed rather than
silently falling back to Obsidian's servers.
