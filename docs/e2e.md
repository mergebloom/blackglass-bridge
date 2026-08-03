# macOS qualification

Every release claim is tied to one ignored `.data/e2e/<run>` directory. The
gate uses disposable profiles and vaults only; it refuses the normal Obsidian
profile, an installed app, changed artifacts, reused evidence, or paths outside
the project E2E area.

## What must pass

- the exact official DMG, reviewed compatibility baseline, reviewed client adapter,
  two independently packaged launcher/manifest/receipt outputs, and Rust server binary all
  match by SHA-256,
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

### Resumable preparation

Freeze one clean client/server pair before starting expensive work. The server
release contract must already name the exact client commit:

```sh
bun run release:candidate:create -- \
  .data/release-candidates/release.json \
  --server-repo ../blackglass-server \
  --control-origin https://sync.example.test \
  --data-host sync-data.example.test

bun run release:run -- .data/release-candidates/release.json \
  --server-repo ../blackglass-server \
  --full-checks --linux --prepare-client \
  --renderer 1.12.7 \
  --official-app '/Volumes/Obsidian/Obsidian.app' \
  --official-dmg /path/to/Obsidian.dmg \
  --run .data/e2e/release
```

For the Phase 3/4 matrix, prepare a separate immutable run for each required
scenario by adding one of:

```text
--scenario E2E-P3-TENANCY
--scenario E2E-P4-CUSTOM-E2EE
--scenario E2E-P4-MANAGED-ENCRYPTION
```

When omitted, preparation uses `E2E-RELEASE-SYNC-RECOVERY`, the existing
bidirectional Sync and cold-recovery release gate. The selected scenario is
stored in `run-manifest.json`; changing it requires a fresh run directory.

The runner always repeats its release doctor, then resumes candidate-bound
checks, exact server builds, two independent standalone Bridge builds and client packages,
reproducibility verification, E2E preparation, and TLS setup. It refuses a
changed checkout or partial output set. Add `--require-gui` only from the
unlocked desktop session; that final preflight checks conflicting processes
and ports before the interactive qualification below. To retry a failed GUI
qualification, pass a fresh `--run` directory: candidate checks, builds, and
packages are reused while only that run's E2E and TLS outputs are prepared.
The preflight finds generated `Blackglass Bridge.app` processes even when
LaunchServices omits them. Generated state remains under ignored `.data` paths
and contains no credentials.

Build the app twice from the same inputs into separate directories, retaining
the receipt emitted by each package invocation, then verify the two outputs and
build the server. The verifier writes path-free evidence and fails if the
receipts do not prove distinct invocations or if either complete app identity
or release manifest differs:

```sh
bun run package:macos:verify-reproducibility -- \
  '/path/to/build-a/Blackglass Bridge.app' /path/to/build-a/release.json \
  /path/to/build-a/package-receipt.json \
  '/path/to/build-b/Blackglass Bridge.app' /path/to/build-b/release.json \
  /path/to/build-b/package-receipt.json \
  /path/to/client-reproducibility.json
```

Then create a fresh run and its scoped TLS material:

```sh
bun run e2e:prepare -- .data/e2e/<run> /path/to/blackglass.asar \
  --app '/path/to/build-a/Blackglass Bridge.app' \
  --release-manifest /path/to/build-a/release.json \
  --package-receipt /path/to/build-a/package-receipt.json \
  --second-app '/path/to/build-b/Blackglass Bridge.app' \
  --second-release-manifest /path/to/build-b/release.json \
  --second-package-receipt /path/to/build-b/package-receipt.json \
  --reproducibility-evidence /path/to/client-reproducibility.json
bun run e2e:tls:prepare -- .data/e2e/<run>
```

Preparation re-inspects both non-overlapping app/manifest/receipt sets and
recomputes the supplied evidence before it creates the run.

Run the TLS proxy and the server in separate terminals. Record the first server
as `server-initial.json`:

```sh
bun run e2e:tls:proxy -- .data/e2e/<run>
server_source_revision=$(git -C /path/to/blackglass-server rev-parse --verify HEAD)
BLACKGLASS_SERVER_BINARY=/path/to/blackglass-server \
  bun run e2e:server -- .data/e2e/<run> \
  --identity-out .data/e2e/<run>/server-initial.json \
  --expected-server-source-revision "$server_source_revision"
```

On a new run the server harness provisions the primary and isolation-test
accounts through the server's offline `user create` command before starting any
listener. A restart reuses the existing SQLite account state. No plaintext
runtime bootstrap setting is accepted or supplied.

The launcher bundles the verified proxy source to an owner-only temporary
directory and runs it with Node.js. This avoids a Bun 1.3.8 TLS-upgrade socket
forwarding defect while keeping the documented command and source provenance
unchanged.

The source revision must be the exact 40-character lowercase commit used to
build the selected server binary; the runner rejects any mismatch before
writing server artifact or process evidence. Both commands block and must remain
running. After the server is ready, run the
packaged-app smoke in a third terminal and let it finish before launching the
two E2E clients:

Run the smoke from the active, unlocked macOS desktop session with Xcode Command
Line Tools available. Quit every Obsidian and Blackglass Bridge application
first; the smoke fails closed before launch if either bundle identifier is
running. It also requires its loopback debugging port to be unused.

```sh
bun run e2e:smoke:macos -- .data/e2e/<run>
```

The smoke reserves debugging port `9320`, launches the exact prepared app via
LaunchServices with an empty disposable `BLACKGLASS_HOME`, proves the GUI kept
its native login `HOME`, authenticates through the starter renderer using the
run's owner-only credentials, verifies a successful vault list through the
run's TLS route, verifies that DevTools listens only on loopback, observes a
full eight-second post-readiness health interval, checks for crash reports and
profile leakage, forwards a profile-local CLI probe with `HOME` set only for
that subprocess, and terminates the exact official child by PID through
`NSRunningApplication.terminate()` while proving its launcher supervisor exits.

Launch client A and B from their prepared profiles with distinct debug ports,
the run's `tls-metadata.json`, and identity outputs named
`client-a-launch.json` and `client-b-launch.json`. Start both network captures
before using the account UI. They remain attached across the server restart and
post-restart transfers until explicitly finalized:

Each launcher holds an owner-only per-client lease for its full lifetime. The
source-loss reset acquires the mutually exclusive run lock before staging or
renaming either profile, so a reset and a relaunch cannot race. A dead-owner
lease is recovered only when its nonce, executable, arguments, and process
identity prove it stale; an active or malformed lease fails closed.

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
native dialogs. `release:run` has already prepared and bound the artifacts;
`tools/e2e-ui.mjs` is its launch-bound CDP helper for form submissions and
evidence snapshots, not an unattended native-dialog driver. Typical
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
same binary as `server-restarted.json`, with the same
`--expected-server-source-revision`; the remaining observations occur after it
is ready. Explicitly pause/resume Sync once on each client after readiness so
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

Add the versioned mixed fixture to client A, wait for background Sync to advance
the database, and capture it:

```sh
bun run recovery:drill -- create .data/e2e/<run>/client-a/vault
bun run recovery:drill -- capture .data/e2e/<run> \
  .data/e2e/<run>/client-a/vault
```

The capture refuses a missing or changed canonical member. Its reviewed corpus
contains six Markdown notes plus two PNGs, SVG, PDF, canvas, CSV, JSON, and
JavaScript files. One PNG is generated deterministically at runtime and exceeds
the client's 2 MiB piece size, making multipart upload and cold download
mandatory. Exact paths, sizes, digests, piece boundary, and the extension summary
remain bound through the recovery report and final validation record. In both
the initial and recovery Sync setup, enable images, PDFs, and unsupported/other
file types before starting Sync.

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
it is bound to the distinct immutable `client-b-recovery-runtime.json` receipt;
the first client B identity and receipt remain available for reset evidence.
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
byte-identical user-content recovery including its multipart image
(`.obsidian/` local settings are excluded), permissions, and current artifact
identities all pass.

## Phase 3 and Phase 4 scenario evidence

Named tenancy and collaboration runs use immutable checkpoints in the order
declared by `tools/e2e-scenario.ts`. Capture each checkpoint through the bound
client debugging port; the command writes the screenshot, sanitized UI state,
safe database projection, file assertions, and an immutable proof record:

Start one network capture for each of clients A, initial B, and C immediately
after launch and before the first scenario action. The capture records only sanitized
methods, endpoint paths, statuses, and WebSocket handshakes; it never records
request bodies, tokens, account addresses, or URL query strings.

For Phase 3, capture `client-a`, `client-b`, and `client-c`. For either Phase 4
scenario, capture `client-a`, `client-b-initial`, and `client-c`; the initial-B
role reads `client-b-launch.json` but writes distinct network evidence.

```sh
bun run e2e:network:capture -- .data/e2e/<phase-3-run> client-a
bun run e2e:network:capture -- .data/e2e/<phase-3-run> client-b
bun run e2e:network:capture -- .data/e2e/<phase-3-run> client-c

bun run e2e:network:capture -- .data/e2e/<phase-4-run> client-a
bun run e2e:network:capture -- .data/e2e/<phase-4-run> client-b-initial
bun run e2e:network:capture -- .data/e2e/<phase-4-run> client-c
```

```sh
bun run e2e:scenario:capture -- .data/e2e/<run> \
  phase-4-custom/wrong-password 9322
```

The capture binds one exact renderer window. Close stale settings/dialog
windows before capture with `e2e-ui.mjs PORT close-auxiliary`. `click-text`
requires one exact match unless an explicit in-range index is supplied. Failed
captures are preserved under `evidence/failed-attempts`; incomplete final-file
pairs are quarantined and may be recaptured because the proof is published
last.

Use these exact proof filenames when creating scenario content:

- `Blackglass E2E Tenant A Proof.md` and `Blackglass E2E Tenant B Proof.md`;
- `Blackglass E2E Owner Proof.md` and `Blackglass E2E Collaborator Proof.md`;
- `Blackglass E2E Former Member Proof.md`, created on B only after revocation;
- `Blackglass E2E Cold Bootstrap Proof.md`, created on A before B's clean bootstrap.

Before the Phase 4 cold-bootstrap checkpoint, finalize B's initial capture at
`self-left`, stop client B, and replace its
entire disposable client lifecycle—not merely its vault directory:

```sh
bun run e2e:reset-client -- .data/e2e/<run> client-b
```

The command records the removed tree, preserves only the exact prepared
adapter, creates a genuinely empty vault and fresh profile, and refuses active
launch leases. The cold-bootstrap proof binds this reset record and the later
fresh launch. Write that identity as `client-b-cold-launch.json`, start the
`client-b-cold` network capture before signing in, and finalize it after the
cold-bootstrap checkpoint.

```sh
bun run e2e:network:finalize -- .data/e2e/<run> client-b-initial
bun run e2e:reset-client -- .data/e2e/<run> client-b
# Launch fresh B with --identity-out .../client-b-cold-launch.json, then:
bun run e2e:network:capture -- .data/e2e/<run> client-b-cold
```

The verifier refuses missing, reordered, overwritten, cross-run, cross-client,
or semantically inconsistent checkpoints. It verifies encryption-mode storage,
membership transitions, user attribution, disabled-session revocation, tenant
file absence, bidirectional byte equality, former-member local retention, and
cold-bootstrap convergence before emitting `scenario-report.json`:

```sh
bun run e2e:network:finalize -- .data/e2e/<run> client-a
bun run e2e:network:finalize -- .data/e2e/<run> client-b-cold
bun run e2e:network:finalize -- .data/e2e/<run> client-c
bun run e2e:scenario:verify -- .data/e2e/<run>
```

The report contains only hashes, counts, IDs, timestamps, and pass/fail state;
it does not copy account addresses, passwords, vault content, or renderer code.
