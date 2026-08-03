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

Set `SELFHOST_DATA_HOST=sync-data.example.com`. End users should use the
standalone Bridge release; it requires no Bun or source checkout:

```sh
blackglass-bridge-vVERSION-macos-arm64 adapt \
  --dmg /path/to/official-Obsidian.dmg \
  --control-origin https://sync-control.example.com \
  --data-host sync-data.example.com \
  --output "$HOME/Desktop/Blackglass-output"
```

## Client rollout and upgrades

Generate one adapted app per upstream release and endpoint pair. The official
app remains untouched. Source contributors may use `patch:client` and
`package:macos` separately for analysis and qualification; that development
workflow requires the pinned Bun toolchain.

The packager verifies the DMG digest and complete extracted application tree
against the reviewed baseline, builds in a private staging directory, and only
publishes the app, manifest, and path-free invocation receipt after every check
passes. The output is ad-hoc
signed for local authorized use; it is not notarized for
redistribution. Its bundle identifier is `com.blackglass.app`; the packager
removes upstream URL-scheme and iCloud-container registrations so it can coexist
with normal Obsidian. Consequently, `obsidian://` deep links and registered
Obsidian iCloud-container behavior are outside the current parity target. The
outer filename and display name are Blackglass, but the upstream
`Obsidian` bundle name, main executable, and Electron helper topology are
deliberately preserved. Ad-hoc signing reapplies the exact reviewed entitlement
and hardened-runtime contracts to the outer app, patched CLI, helpers, framework
auxiliaries, and framework bundles; packaging and artifact inspection fail
closed on drift. A release-specific recursive inventory additionally requires
every real code bundle and Mach-O—including native modules—to remain signed and
present with the reviewed architectures. Packaging re-signs every Mach-O leaf
before its containing bundles, preserves the reviewed per-architecture runtime,
identifier, and entitlement policy, then verifies every inventory target with
strict all-architecture checks. The manifest records the pinned Bun
runtime, macOS/Xcode identity, actual Xcode-selected Git backend, packaging-tool
hashes, exact installed TypeScript and Playwright package trees, and recursively
checked bundle metadata. E2E setup and qualification recompute that environment
identity. ACLs, BSD flags, and unknown
extended attributes fail closed; macOS provenance attributes are path/value
hash-bound.

Package the same inputs a second time in another directory and run
`package:macos:verify-reproducibility`; E2E preparation requires both concrete
app/manifest/receipt sets, proves the receipts came from distinct package
invocations, recomputes the resulting path-free evidence, and binds it through
final qualification.

The copied wrapper still contains upstream proprietary code and artwork. Keep
it out of source control and distribution artifacts.

Launch it with a dedicated profile:

```sh
bun run client:launch -- \
  /path/to/generated-compatibility.asar \
  /path/to/dedicated-profile \
  /path/to/vault \
  --app '/path/to/Blackglass.app' \
  --blackglass-home /private/tmp/blackglass-runtime
```

The packaged wrapper selects
`${BLACKGLASS_HOME:-$HOME}/Library/Application Support/Blackglass`, so
ordinary Finder launches retain the standard macOS location while the launcher
can supply a distinct private, canonical, owner-only `BLACKGLASS_HOME`. Create that
directory at mode `0700`; its full CLI-socket path must fit macOS's 103-byte
Unix-socket limit. Use the same path as `HOME` only for packaged CLI subprocesses.
The GUI's native `HOME`
remains unchanged so Electron uses the login Keychain normally. It disables its
upstream package updater and refuses downloaded renderer overrides, including
Finder launches. An explicit `--user-data-dir` remains available for disposable
isolated test clients. The launcher requires existing profile and vault
directories and refuses Obsidian's normal profile. The embedded main process
also uses a dedicated `.blackglass-c.sock` under `BLACKGLASS_HOME`, so it can
coexist with normal Obsidian without unlinking Obsidian's endpoint. Only the
packaged CLI subprocess receives that path as `HOME`, which is the interface
the upstream CLI binary expects.

Blackglass uses its own `Blackglass Safe Storage` keychain item and does not
migrate Obsidian credentials. Users sign in once after installing Blackglass;
ordinary upgrades keep using the Blackglass profile and keychain namespace.
If `--blackglass-home` is omitted, the launcher uses the login-home socket and
therefore refuses to start while any other instance of the same generated app
is running. Supplying distinct validated runtime homes permits isolated
multi-profile test instances.
Endpoint inputs must be canonical: no trailing slash, case normalization,
default port spelling, path, credentials, query, or fragment.
For every upstream release:

1. verify and retain the official artifact and SHA-256 outside this project;
2. review a new versioned compatibility baseline and require its complete
   packed/unpacked-JavaScript, anchor, route, operation, and message-shape
   inventory to pass;
3. generate a new ASAR for canonical endpoints;
4. package two independent copied apps, require distinct invocation receipts
   plus matching complete identities and manifests, and retain the sanitized
   reproducibility evidence;
5. run typecheck, packaging, Bun-oracle, Rust, cross-implementation protocol,
   and isolated packaged-client recovery checks;
6. require the E2E report's reproducibility, release-manifest, server, wrapper,
   app, endpoint, and compatibility-ASAR identities to match the intended
   release artifacts;
7. roll out the qualified build without changing the stable server endpoints.

An unqualified upstream client update is expected to fail closed rather than
silently falling back to Obsidian's servers.

Package and qualify from a clean committed tooling tree. After qualification,
create the exact current `docs/validation/*-qualification.json` record in one
new commit and tag that direct linear descendant. The record path must not exist
in the qualified source commit, and the commit may not add, modify, or delete
any other file, including historical qualification records. The release
workflow verifies those constraints and byte-compares the committed record with
the record it validates.
