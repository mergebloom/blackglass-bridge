# macOS qualification

Every release claim is tied to one ignored `.data/e2e/<run>` directory. The
gate uses disposable profiles and vaults only; it refuses the normal Obsidian
profile, an installed app, changed artifacts, reused evidence, or paths outside
the project E2E area.

## What must pass

- the exact official DMG, reviewed compatibility baseline, six-incision client ASAR,
  copied app, release manifest, and Rust server binary all match by SHA-256,
  with the server binary also reporting its exact source revision;
- two separately identified live app processes use the intended renderer,
  profile, vault, DevTools target, TLS certificate, and resolver rules;
- a LaunchServices launch with a genuinely empty profile under a private
  `BLACKGLASS_HOME` preserves native `HOME`, opens the native `starter.html`
  flow, and completes `/user/signin` and `/vault/list` at the configured control
  origin without registering a local vault, while the created profile is
  observed as a real mode-`0700` directory;
- CDP traces started before login show successful POSTs to the configured HTTPS
  control origin and a `101` handshake to the configured WSS data host, with no
  loopback fallback;
- automatic A-to-B and B-to-A transfers, a propagated deletion, and a transfer
  after a graceful server restart advance SQLite monotonically;
- six native Sync UI checkpoints match the required success text; and
- after both client trees are removed, one new empty client restores a mixed
  vault byte-for-byte from server-held data.

Raw credentials, screenshots, profiles, and vaults remain ignored. Committed
records in `docs/validation` are sanitized summaries, not substitutes for
qualifying a newly built artifact.

## Run outline

Build the app and server first. Then create a fresh run and its scoped TLS
material:

```sh
bun run e2e:prepare -- .data/e2e/<run> /path/to/blackglass.asar \
  --app '/path/to/Blackglass Bridge.app' \
  --release-manifest /path/to/release-manifest.json
bun run e2e:tls:prepare -- .data/e2e/<run>
```

Run the TLS proxy and the server in separate terminals. Record the first server
as `server-initial.json`:

```sh
bun run e2e:tls:proxy -- .data/e2e/<run>
BLACKGLASS_SERVER_BINARY=/path/to/blackglass-server \
  bun run e2e:server -- .data/e2e/<run> \
  --identity-out .data/e2e/<run>/server-initial.json
```

Both commands block and must remain running. After the server is ready, run the
packaged-app smoke in a third terminal and let it finish before launching the
two E2E clients:

```sh
bun run e2e:smoke:macos -- .data/e2e/<run>
```

The smoke reserves debugging port `9320`, launches the exact prepared app via
LaunchServices with an empty disposable `BLACKGLASS_HOME`, proves the GUI kept
its native login `HOME`, authenticates through the starter renderer using the
run's owner-only credentials, verifies a successful vault list through the
run's TLS route, checks for crash reports and profile leakage, forwards a
packaged-CLI probe with `HOME` set only for that subprocess, and terminates the
exact generated app by PID through `NSRunningApplication.terminate()`.

Launch client A and B from their prepared profiles with distinct debug ports,
the run's `tls-metadata.json`, and identity outputs named
`client-a-launch.json` and `client-b-launch.json`. Start both network captures
before using the account UI. They remain attached across the server restart and
post-restart transfers until explicitly finalized:

Each launcher holds an owner-only per-client lease for its full lifetime. The
source-loss reset acquires the mutually exclusive run lock before staging or
renaming either profile, so a reset and a relaunch cannot race.

```sh
bun run client:launch -- \
  .data/e2e/<run>/client-a/user-data/obsidian-1.12.7.asar \
  .data/e2e/<run>/client-a/user-data \
  .data/e2e/<run>/client-a/vault \
  --app '/path/to/Blackglass Bridge.app' \
  --debug-port 9321 \
  --e2e-tls-metadata .data/e2e/<run>/tls-metadata.json \
  --identity-out .data/e2e/<run>/client-a-launch.json

bun run client:launch -- \
  .data/e2e/<run>/client-b/user-data/obsidian-1.12.7.asar \
  .data/e2e/<run>/client-b/user-data \
  .data/e2e/<run>/client-b/vault \
  --app '/path/to/Blackglass Bridge.app' \
  --debug-port 9322 \
  --e2e-tls-metadata .data/e2e/<run>/tls-metadata.json \
  --identity-out .data/e2e/<run>/client-b-launch.json
```

Each launcher blocks and belongs in its own terminal. After both identity files
exist, start each capture in another terminal; these commands also block until
their finalizers are written:

```sh
bun run e2e:network:capture -- .data/e2e/<run> client-a
bun run e2e:network:capture -- .data/e2e/<run> client-b
```

Through the built-in UI, client A logs in, creates an E2EE vault in Blackglass
Server, connects, unlocks, and starts Sync. Client B logs in, selects the same
vault, connects, unlocks, and starts Sync. The operator opens the relevant
native dialogs; `tools/e2e-ui.mjs` is a launch-bound CDP helper for the form
submissions and evidence snapshots, not a full-flow orchestrator. Typical
client-A calls are:

```sh
bun tools/e2e-ui.mjs 9321 snapshot \
  .data/e2e/<run>/evidence/client-a/settings.png \
  .data/e2e/<run>/evidence/client-a/settings.json
bun tools/e2e-ui.mjs 9321 login .data/e2e/<run>/credentials.json
bun tools/e2e-ui.mjs 9321 create-vault .data/e2e/<run>/credentials.json
bun tools/e2e-ui.mjs 9321 unlock-vault .data/e2e/<run>/credentials.json
```

Use port `9322` for client B, select the created vault in the native chooser,
and use the same `login`, `unlock-vault`, and `snapshot` helpers. Snapshot paths
must use the required checkpoint stems below. The recovery client uses port
`9323` and the same bound helpers.

Use `e2e:observe` for the three allowed proof transfers and one deletion. The
first A-to-B transfer occurs before stopping the initial server. Restart the
same binary as `server-restarted.json`; the remaining observations occur after
it is ready. Explicitly pause/resume Sync once on each client after readiness so
the traces record a fresh WSS handshake, then perform the remaining observations.
Finalize both traces only after all four observations exist; the
finalizer binds them to the restarted server and requires a successful WSS
handshake after its ready time:

```sh
bun run e2e:network:finalize -- .data/e2e/<run> client-a
bun run e2e:network:finalize -- .data/e2e/<run> client-b
```

After both capture processes finish successfully, run:

```sh
bun run e2e:verify -- .data/e2e/<run>
```

The verifier requires these checkpoint stems:

- `evidence/client-a/settings`, `created`, and `unlocked`;
- `evidence/client-b/vault-chooser`, `converged`, and `deleted-files`.

## Source-loss recovery

Add the mixed fixture to client A, wait for background Sync to advance the
database, and capture it:

```sh
bun run recovery:drill -- create .data/e2e/<run>/client-a/vault
bun run recovery:drill -- capture .data/e2e/<run> \
  .data/e2e/<run>/client-a/vault
```

Stop both clients. The reset command permanently removes only the two validated
disposable client trees and creates a new empty client B:

```sh
bun run e2e:reset-for-recovery -- .data/e2e/<run>
```

Launch that client with identity output `client-b-recovery-launch.json`, then
start `e2e:network:capture` for `client-b-recovery` before login. Restore through
the same built-in UI and capture `evidence/recovery/client-b-restored.png` plus
its JSON peer. Verify recovery, explicitly finalize its trace, and qualify:

```sh
bun run client:launch -- \
  .data/e2e/<run>/client-b/user-data/obsidian-1.12.7.asar \
  .data/e2e/<run>/client-b/user-data \
  .data/e2e/<run>/client-b/vault \
  --app '/path/to/Blackglass Bridge.app' \
  --debug-port 9323 \
  --e2e-tls-metadata .data/e2e/<run>/tls-metadata.json \
  --identity-out .data/e2e/<run>/client-b-recovery-launch.json
```

The recovery launcher blocks in its own terminal. Once its identity exists,
start the recovery capture in another terminal, complete the built-in recovery
UI, and then run the remaining commands:

```sh
bun run e2e:network:capture -- .data/e2e/<run> client-b-recovery
bun run recovery:drill -- verify .data/e2e/<run> \
  .data/e2e/<run>/client-b/vault
bun run e2e:network:finalize -- .data/e2e/<run> client-b-recovery
bun run e2e:qualify -- .data/e2e/<run>
```

`qualification.json` is emitted only when the empty-profile starter route,
Sync, restart, deletion, exact endpoint evidence across all lifecycle phases,
cold recovery, permissions, and current artifact identities all pass.
