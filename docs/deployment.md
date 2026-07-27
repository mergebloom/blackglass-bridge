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
  /path/to/official-obsidian.asar \
  /path/to/generated-compatibility.asar \
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
  '/path/to/Blackglass Bridge.app'
```

The output is ad-hoc signed for local authorized use; it is not notarized for
redistribution. Its bundle identifier is `com.blackglass.bridge`; the packager
removes upstream URL-scheme and iCloud-container registrations so it can coexist
with normal Obsidian. Launch it with a dedicated profile:

The copied wrapper still contains upstream proprietary code and artwork. Keep
it out of source control and distribution artifacts.

```sh
bun run client:launch -- \
  /path/to/generated-compatibility.asar \
  /path/to/dedicated-profile \
  /path/to/vault \
  --app '/path/to/Blackglass Bridge.app'
```

The launcher disables automatic updates only in that dedicated build/profile.
It refuses Obsidian's normal profile. For every upstream release:

1. verify and retain the official artifact and SHA-256 outside this project;
2. require `analyze:release` and every semantic patch anchor to pass exactly once;
3. generate a new ASAR and retain its upstream/generated hashes;
4. package a copied app and keep updates disabled;
5. run typecheck, packaging, Bun-oracle, Rust, cross-implementation protocol,
   and isolated packaged-client recovery checks;
6. require the E2E report's exact server and compatibility-ASAR hashes to match
   the intended release artifacts;
7. roll out the qualified build without changing the stable server endpoints.

An unqualified upstream client update is expected to fail closed rather than
silently falling back to Obsidian's servers.
