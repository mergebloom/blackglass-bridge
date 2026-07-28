# Validation records

This directory contains sanitized, non-proprietary release summaries. Raw
profiles, vaults, screenshots, credentials, databases, patched ASARs, and app
bundles stay under ignored `.data/` storage and must never be committed.

A current release record is valid only when it names the bound Bridge release
manifest plus the exact renderer, wrapper, packaged app, endpoint, patcher, and
server artifact identities, including the official DMG and complete source and
packaged application tree hashes. It also binds the clean Git revision and
deterministic release-critical tooling tree used for packaging and E2E. The
server identity includes both its binary SHA-256 and embedded source revision.
Historical records demonstrate protocol behavior but do not qualify a rebuilt
or renamed artifact.

Current records are written only from a completed ignored E2E run with
`bun run e2e:validation:write`. The repository test requires exactly the record
matching `package.json` and rejects pending or manually weakened claims.
