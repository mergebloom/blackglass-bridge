# Open-source platform readiness plan

This plan turns the completed Phase 3/4 implementation into a source-bound,
shareable Server, Bridge, and Conformance Suite without changing the supported
platform surface. Detailed procedures remain in their owning guides.

## Acceptance stages

1. **Distribution boundary** — public Git and release assets contain no
   proprietary application/source/assets, private deployment identity, or
   secrets. Bridge consumes a user-supplied official artifact and emits a local
   independently identified launcher, manifest, and receipt.
2. **Server operations** — non-root read-only Compose deployment, exact origins,
   TLS example, health, graceful shutdown, portable data root, transactional
   backup publication, restore/migration drills, and explicit rollback limits.
3. **Source-bound artifacts** — exact clean Bridge and Server commits produce
   attested native and Linux artifacts. Bridge is compiled twice from a detached
   exact commit; complete or partial cached output is verified or rejected.
4. **Safe client adaptation** — reviewed hashes and semantic inventories gate
   every incision; isolated profiles/runtime homes, update protection, official
   child supervision, clean recovery, and multiple supervised test clients are
   covered by tests.
5. **Conformance and promotion** — four distinct immutable packaged-client runs
   per renderer cover release recovery, tenancy, custom E2EE, and managed
   encryption. Scenario reports, validation records, and generated matrix files
   form one exact qualification-only commit.
6. **Readiness evidence** — full unit/integration/license/distribution gates,
   amd64/arm64 builds, reproducibility, packaged launch/E2E, backup/restore/
   migration, resource measurements, artifact hashes, and final Git inspection.

## Dependencies and stop conditions

Stages 1–4 precede the source freeze. Stage 5 consumes only exact artifacts from
that freeze, and stage 6 may not infer support from historical or partial runs.
Failures are fixed at their source; gates, hashes, revision binding, and required
scenarios are not weakened. Publishing and pushing remain separate operator
actions requiring explicit authorization.

The executable workflow is in [the E2E guide](../e2e.md), compatibility review
and promotion are in [the baseline guide](../../compatibility/README.md), and
Server deployment/operations are owned by the companion Server repository.
