# macOS qualification

Every release claim is tied to one ignored `.data/e2e/<run>` directory. The
gate uses disposable profiles and vaults only; it refuses the normal Obsidian
profile, an installed app, changed artifacts, reused evidence, or paths outside
the project E2E area.

## What must pass

- the exact official DMG, reviewed compatibility baseline, two-incision ASAR,
  copied app, release manifest, and Rust server binary all match by SHA-256,
  with the server binary also reporting its exact source revision;
- two separately identified live app processes use the intended renderer,
  profile, vault, DevTools target, TLS certificate, and resolver rules;
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

Launch client A and B from their prepared profiles with distinct debug ports,
the run's `tls-metadata.json`, and identity outputs named
`client-a-launch.json` and `client-b-launch.json`. Start both network captures
before using the account UI. They remain attached across the server restart and
post-restart transfers until explicitly finalized:

```sh
bun run e2e:network:capture -- .data/e2e/<run> client-a
bun run e2e:network:capture -- .data/e2e/<run> client-b
```

Through the built-in UI, client A logs in, creates an E2EE vault in Blackglass
Server, connects, unlocks, and starts Sync. Client B logs in, selects the same
vault, connects, unlocks, and starts Sync. `tools/e2e-ui.mjs` performs these
interactions and writes each PNG/JSON checkpoint pair under `evidence/`.

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
bun run recovery:drill -- verify .data/e2e/<run> \
  .data/e2e/<run>/client-b/vault
bun run e2e:network:finalize -- .data/e2e/<run> client-b-recovery
bun run e2e:qualify -- .data/e2e/<run>
```

`qualification.json` is emitted only when Sync, restart, deletion, exact
endpoint evidence across all lifecycle phases, cold recovery, permissions, and
current artifact identities all pass.
