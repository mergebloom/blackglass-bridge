# Blackglass Bridge architecture

## Responsibility

Blackglass Bridge owns the desktop compatibility boundary:

1. inspect an authorized upstream renderer;
2. find the control-origin and Sync-host semantic anchors;
3. require exactly one match for each anchor;
4. replace them without changing the surrounding renderer logic;
5. rebuild ASAR integrity metadata;
6. package and sign a separate macOS application copy; and
7. launch it with an isolated profile and vault.

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
tests. If an anchor is missing or ambiguous, generation stops. A generated app
is distributable only after the isolated official-client E2E and source-loss
recovery checks pass against the intended Blackglass Server release.

## Safety boundaries

- The installed Obsidian application is read-only.
- Real user profiles and vaults are refused by project tooling.
- Generated apps, credentials, and E2E vaults stay under ignored data paths.
- Plaintext loopback endpoints are permitted only for local testing.
- Non-loopback deployments require authenticated TLS endpoints.
