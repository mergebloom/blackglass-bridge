# Validation records

This directory contains sanitized, non-proprietary release summaries. Raw
profiles, vaults, screenshots, credentials, databases, patched ASARs, and app
bundles stay under ignored `.data/` storage and must never be committed.

A current release record is valid only when it names the bound Blackglass release
manifest plus the exact renderer, reviewed official wrapper, standalone launcher,
packaged app, endpoint, patcher, and server artifact identities, including the
official DMG, private unmodified runtime, and complete launcher tree hashes. It also binds the clean Git revision and
deterministic release-critical tooling tree used for packaging and E2E. The
client evidence embeds a path-free proof that two distinct package invocation
receipts produced identical complete app and release-manifest identities. The
server identity includes both its binary SHA-256 and embedded source revision.
The recovery identity includes a generated image larger than the client's 2 MiB
piece size, so a record cannot claim qualification without multipart upload and
byte-identical cold recovery. Historical records demonstrate protocol behavior
but do not qualify a rebuilt or renamed artifact.

Current records are written only from a completed ignored E2E run with
`bun run e2e:validation:write`. Normal repository CI permits zero or one record
matching the current `package.json` version, and validates the record fully when
present. This lets the clean source commit pass before its evidence-only record
is generated. A tag is release-eligible only when
`bun run release:verify-eligibility -- <full-tag-commit>` finds exactly one
current canonical records and proves that the tag is the direct child of its
qualified tooling source. That one qualification commit may create only the
exact validation reports and compatibility records being validated, byte for
byte, without changing historical records or implementation paths. Both paths
reject multiple or manually weakened current claims.
