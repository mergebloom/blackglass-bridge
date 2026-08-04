---
name: qualify-obsidian-release
description: Analyze and qualify an exact user-supplied official Obsidian desktop release for Blackglass Bridge and Blackglass Server. Use when adding support for a new Obsidian renderer, adapting a new official DMG or application, reviewing minified client or protocol changes, producing a new Bridge client, or proving that an exact Bridge/Server combination is compatible end to end.
---

# Qualify an Obsidian release

Treat every upstream release as an untrusted compatibility candidate. Make a
support claim only through the generated compatibility matrix after the exact
packaged client and exact server revision pass every required scenario.

## Establish authority and inputs

1. Read the repository `AGENTS.md`, `README.md`,
   [`compatibility/README.md`](../../../compatibility/README.md), and
   [`docs/e2e.md`](../../../docs/e2e.md) completely before changing files.
2. Locate the companion Server repository, normally `../blackglass-server`, and
   read its `AGENTS.md`, `README.md`, `docs/e2e.md`, and
   `docs/distribution.md` before changing server code.
3. Obtain these inputs from the user or current task context:
   - a user-supplied official Obsidian DMG or application;
   - the expected version, or permission to discover it;
   - whether the macOS desktop session is unlocked for GUI qualification;
   - the signing policy: ad-hoc or stable Apple signing/notarization;
   - explicit commit, push, tag, and release-publishing authority.
4. Inspect both worktrees and preserve unrelated changes. Do not create or
   switch branches unless explicitly requested. Do not push, tag, publish, or
   use production credentials without explicit authority.
5. Keep upstream applications, DMGs, ASARs, extracted/minified source,
   screenshots, profiles, credentials, and private endpoints only in ignored
   `.data` or temporary paths. Never commit them.

## Review the untrusted release

1. Verify the supplied artifact and extract or mount it without modifying the
   installed Obsidian application or a real user profile.
2. Use the latest supported renderer in `compatibility/matrix.json` as the
   predecessor unless the task explicitly selects another reviewed baseline.
3. Generate the write-once untrusted packet using `bun run
   baseline:candidate -- ... --predecessor ...`. Use the exact invocation in
   [`compatibility/README.md`](../../../compatibility/README.md).
4. Review every reported change in:
   - packed and unpacked JavaScript inventories;
   - semantic anchors and patch/wrapper incisions;
   - control-plane routes and request helpers;
   - WebSocket constructors, operations, inbound messages, and shapes;
   - wrapper identity, CLI behavior, update behavior, and runtime supervision.
5. Compare relevant protocol documentation with the candidate. Inspect local
   proprietary code only as an input to the review; record hashes, counts,
   shapes, and conclusions rather than excerpts.
6. Classify the result and act narrowly:
   - **Identity-only:** promote reviewed identities without changing protocol
     or server behavior.
   - **Moved or changed incision:** update the smallest Bridge transformation
     and add regression tests for the new semantic contract.
   - **Protocol change:** update the Rust server, protocol documentation, exact
     fixtures, migration behavior if needed, and regression/integration tests.
   - **Unresolved change:** fail closed and do not promote or package it.
7. Promote only a manually reviewed `proposedBaseline`. Never copy a prior
   baseline and mark it reviewed automatically.

## Bind and build the candidate

1. Run Bridge and Server fast gates while iterating, then their complete
   release checks. Fix causes; never weaken gates or source binding.
2. Bump Bridge or Server versions only when their release contracts require a
   new artifact. Keep every cross-repository revision reference exact.
3. Create clean commits with the user-required identity before freezing a
   release candidate. If commit authority is absent, stop at this gate and
   report the exact reason.
4. Create the immutable candidate with `release:candidate:create`. Keep actual
   deployment endpoints in ignored candidate state; use neutral example
   endpoints in tracked source and documentation.
5. Run `release:doctor`, then `release:run` with full checks, Linux builds,
   client preparation, exact DMG/application inputs, and GUI/signing flags that
   match the task. Reuse only complete hash-receipted stages. Reject partial,
   stale, dirty, or revision-mismatched outputs.
6. Require native server, Linux amd64 and arm64 packages, checksums, standalone
   Bridge, two independent macOS packages, receipts, and reproducibility
   evidence. Resource-qualify each Linux artifact only on a matching native
   Linux runner; never substitute emulation or another binary.

## Qualify the packaged client

Prepare a fresh immutable run directory for each scenario:

- `E2E-RELEASE-SYNC-RECOVERY`
- `E2E-P3-TENANCY`
- `E2E-P4-CUSTOM-E2EE`
- `E2E-P4-MANAGED-ENCRYPTION`

Follow [`docs/e2e.md`](../../../docs/e2e.md) exactly. Test the packaged
application, not development assets. Prove native launch and profile isolation,
authentication/session and tenant isolation, exact HTTPS/WSS routing,
background bidirectional convergence, mixed and multipart files, deletion,
restart continuity, custom and managed encryption, collaboration attribution
and lifecycle, wrong-password rejection, outsider isolation, and clean-profile
server-only recovery. Also verify backup, restore, previous-schema migration,
graceful shutdown, secret redaction, tamper detection, and hash-chained
evidence against the same release candidate.

Use a fresh run directory when a GUI qualification is invalidated. Preserve
failed evidence outside final checkpoint paths and do not recapture by
overwriting immutable evidence.

## Promote and report

1. Copy only sanitized, self-named reports into `docs/validation`.
2. Add the matrix entry with `compatibility:add` only after all four scenarios
   pass. Generate `compatibility/MATRIX.md` from `matrix.json` and run
   `compatibility:check`, `tooling:verify-qualified`, and
   `release:verify-eligibility` as documented.
3. Run final Bridge and Server release checks, distribution-boundary scans,
   forbidden-identifier/domain/secret scans, `git diff --check`, and worktree
   inspection.
4. Commit only intended tracked code, baselines, documentation, and sanitized
   evidence. Push or publish only when explicitly authorized.
5. Report exact versions, revisions, upstream identities, protocol/incision
   changes, scenario results, artifact paths and SHA-256 hashes,
   reproducibility, resource measurements, signing state, remaining
   limitations, commits, and push/publication state.
