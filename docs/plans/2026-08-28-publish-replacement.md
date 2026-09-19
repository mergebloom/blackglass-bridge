# Blackglass Publish replacement

Blackglass Publish should preserve the native Obsidian 1.13.4 publishing workflow while moving site data, access control, and public delivery onto the user's Blackglass Server. The user supplies the official application and the public Publish runtime; neither repository carries proprietary runtime bytes.

## Proven foundation

- The reviewed public renderer is represented by a hash-only 17-asset manifest in `compatibility/publish-web-2026-08-28.json`.
- Bridge verifies every referenced asset, semantic data-route anchor, and runtime hash; it fails closed on missing or changed inputs.
- Bridge applies three exact origin/branding incisions and emits a source-bound receipt.
- Server independently verifies that receipt, the canonical manifest identity, every asset hash and size, and the absence of unbound files or symlinks.
- The adapted runtime has rendered from both the Bridge fixture server and the Rust replay server with native Markdown, graph, search, theme switching, and no external requests or browser errors.
- The clean-room desktop contract in `compatibility/publish-client-1.13.4.json` binds 17 routes and 22 semantic request anchors to the official 1.13.4 ASAR without retaining source text.

The replay command is a development spike, not the production Publish service. It intentionally binds only to loopback and serves a synthetic site.

## Product contract

The initial production implementation must support:

1. Native create, list, switch, delete, invite, accept, remove, and collaborator-list flows.
2. Atomic file list, upload, download, and unpublish behavior with the client's 50 MB per-file limit.
3. Site options, navigation ordering and hiding, light/dark/system themes, logo, graph, search, outline, backlinks, and theme toggle.
4. Site-wide password protection, password revocation, collaborator authorization, and strict owner-only administration.
5. Public Markdown, images, PDFs, CSS, JavaScript, favicons, permalinks, aliases, sitemap, RSS, and search.
6. User-controlled hostname and TLS, no required Blackglass-operated service, no telemetry, and no default analytics.

The official behavior references are the concise [Publish overview](https://obsidian.md/help/publish), [site management](https://obsidian.md/help/Obsidian%2BPublish/Manage%2Bsites), [customization](https://obsidian.md/help/Obsidian%2BPublish/Customize%2Byour%2Bsite), [collaboration](https://obsidian.md/help/publish/collaborate), [security](https://obsidian.md/help/publish/security), [limitations](https://obsidian.md/help/publish/limitations), and [permalinks](https://obsidian.md/help/publish/permalinks).

## Production sequence

1. Add an atomic SQLite migration for sites, memberships, invitations, slugs, options, passwords, file metadata, and content-addressed blob references.
2. Put blobs beneath the existing portable data root; write through bounded staging files, fsync, rename, and then commit metadata. Garbage collection must never race a committed reference.
3. Enable Publish only when the runtime directory, expected runtime hash, and exact public hostname are configured and verified at startup. Otherwise retain the current `publish: false` behavior.
4. Implement the seven authenticated control routes, followed by the ten site-control/data routes in the reviewed contract. Reuse session expiry, admission control, quotas, revocation, and constant-shape error handling.
5. Serve public routes from an isolated router with strict path normalization, security headers, conditional caching, password sessions, and no access to control APIs.
6. Generate cache/search/sitemap/RSS state transactionally from the same published revision so visitors never see a partially deployed site.
7. Add native-client conformance for owner, collaborator, outsider, password, upload/remove, restart, backup/restore, and upgrade flows; then add public-browser parity fixtures for every supported content type and option.

## Release gate

A renderer/server pair is supported only after the exact client ASAR contract, adapted public runtime receipt, Server revision, packaged application, and full native/public E2E evidence are hash-bound in the compatibility matrix. New client or web runtime hashes create an untrusted candidate and require explicit incision and protocol review.
