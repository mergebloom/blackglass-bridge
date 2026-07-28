# Blackglass Bridge architecture

## Responsibility

Blackglass Bridge owns the desktop compatibility boundary:

1. inspect an authorized upstream renderer against a reviewed versioned baseline;
2. inventory every packed JavaScript file, every JavaScript file in the two
   unpacked resource trees, plus request helpers, network constructors, control
   routes, and inbound and outbound Sync operations/message shapes;
3. require exact source hashes and exact inventory/semantic-anchor matches;
4. replace them without changing the surrounding renderer logic;
5. patch the copied Electron wrapper to force an isolated canonical profile at
   mode `0700`, disable its upstream package updater, and pin the embedded
   qualified renderer;
6. rebuild both ASAR integrity records;
7. bind the official DMG digest and full source tree, then stage, verify, sign,
   and publish a separate macOS application copy;
8. launch it through LaunchServices with a genuinely empty default profile,
   prove the native starter's sign-in and vault-list requests use the configured
   TLS origin, and record the exact process, executable, app, adapter, debug
   port, and local TLS identities; and
9. run the isolated-vault Sync and source-loss recovery qualification.

It does not implement authentication, persistence, WebSocket synchronization,
or production operations. Those belong to Blackglass Server.

## Stable boundary with Blackglass Server

Bridge expects two endpoints:

- an HTTP control origin, such as `http://127.0.0.1:3000`; and
- a Sync WebSocket host, such as `127.0.0.1:3003`.

The protocol contract is documented in
[`protocol/obsidian-1.12.7.md`](protocol/obsidian-1.12.7.md). Bridge treats the
server as an external dependency and the E2E runner accepts its binary through
`BLACKGLASS_SERVER_BINARY`. The default is the release artifact in the sibling
`blackglass-server` project.

## Release maintenance

For each new desktop release, rerun static analysis and the semantic-anchor
tests. Review and commit a new compatibility baseline; never carry the prior
release's inventory forward automatically. The baseline explicitly records the
reviewed `obsidian.asar.unpacked` and `app.asar.unpacked` JavaScript paths,
sizes, and SHA-256 identities. If any packed or unpacked JavaScript file,
anchor, request helper, network constructor, route, operation, or message shape
is new, removed, or changed, generation stops. Packaging then reproduces the
three-incision renderer from the reviewed source and canonical endpoints and
requires a byte-identical result. A single release manifest binds
the baseline, source/result hashes, endpoints, patcher formats, wrapper, and app
identity into the isolated E2E report. The E2E TLS certificate, resolver rules,
proxy routes, and server ports are derived from that run's endpoint-bound
network plan rather than duplicated constants. Live process-tree checks and
sanitized CDP traces first prove the empty-profile starter flow, then begin
before normal Sync login and remain attached through the server restart,
post-restart transfers, and a separately identified cold-recovery client. They
prove that the configured HTTPS and WSS endpoints, not retained development or
upstream fallbacks, handled every qualified lifecycle phase.

Packaging also records a deterministic identity for the Git-tracked
release-critical source, configuration, tests, workflows, and documentation.
Ignored files and generated validation JSON do not affect that tree identity,
while a relevant untracked or modified file makes the packaging source dirty.
The release-tag gate requires the tested source commit to be an ancestor and
permits only a linear sequence of generated qualification-record commits after
it; the tooling tree at the tag must remain byte-identical.

## Safety boundaries

- The installed Obsidian application is read-only.
- Real user profiles and vaults are refused by project tooling.
- Generated apps, credentials, and E2E vaults stay under ignored data paths.
- Plaintext loopback endpoints are permitted only for local testing.
- Non-loopback deployments require authenticated TLS endpoints.
- An explicit `--user-data-dir` is honored for disposable E2E clients; ordinary
  launches default to the separate Blackglass Bridge profile. The wrapper
  rejects a non-canonical path at setup and enforces directory mode `0700` for
  both forms.
