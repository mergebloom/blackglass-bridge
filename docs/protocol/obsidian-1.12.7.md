# Obsidian 1.12.7 client protocol notes

This file records only Bridge-specific client findings. The authoritative
request, response, migration, history, purge, and recovery contracts live in
the companion [Blackglass Server protocol document](https://github.com/mergebloom/blackglass-server/blob/main/docs/protocol/obsidian-1.12.7.md).
Keeping server semantics in one repository avoids a second copy drifting across
releases.

## Client network seams

The authorized 1.12.7 artifact constructs `https://api.obsidian.md` in both the
main `app.js` renderer and the independent no-vault `starter.js` renderer. Sync
persists a control-plane-provided data host and opens `ws://` only for exact
loopback development hosts or `wss://` otherwise. The Bridge patcher therefore
uses five fixed-length, fail-closed client-ASAR incisions:

- control origin in `app.js`;
- exact Sync data-host authorization in `app.js`;
- control origin in `starter.js`;
- `.obsidian-cli.sock` to `.blackglass-b.sock` in `main.js`;
- `/usr/local/bin/obsidian` registration to `/usr/local/bin/blackglass` in
  `main.js`.

The packaged universal `obsidian-cli` binary contains one socket literal per
architecture. Both are patched to `.blackglass-b.sock` before the app is
re-signed. Prepared E2E clients also receive separate mode-`0700` homes so their
CLI sockets cannot collide.

## Route boundary

Static analysis finds 27 control routes. Blackglass Server implements all 18
routes used by the desktop account and Sync flows. The remaining routes are the
seven Publish routes, `/subscription/sync/signup-mobile`, and `/user/authtoken`;
they are outside the initial desktop Sync target. Sharing mutations are
recognized and return the single-owner deployment error described by the
server contract.

The no-vault starter has its own request helper for `/user/signin` and
`/vault/list`, so every release qualification exercises that flow separately
through LaunchServices before a vault exists.

## Compatibility boundary

The committed baseline binds every packed and unpacked JavaScript file by
identity and records semantic anchors, routes, request helpers, network
constructors, Sync operations, outbound message shapes, and inbound operation
discriminants. A changed upstream artifact fails closed. Inbound response field
details, 2 MiB piece ordering, and lifecycle behavior remain explicit review and
E2E responsibilities rather than inferred stable minified APIs.
