# Deployment and client rollout

Deploy the Rust service first by following the companion Server's
[production guide](https://github.com/mergebloom/blackglass-server/blob/main/docs/production.md).
Use separate public TLS names for the control and data planes, for example:

- `https://sync-control.example.com` -> Server HTTP port 3000
- `wss://sync-data.example.com` -> Server WebSocket port 3003

Then adapt a user-supplied supported release with the standalone Bridge:

```sh
blackglass-bridge-vVERSION-macos-arm64 adapt \
  --dmg /path/to/official-Obsidian.dmg \
  --control-origin https://sync-control.example.com \
  --data-host sync-data.example.com \
  --output "$HOME/Desktop/Blackglass-output"
```

The common path needs no Bun, Node.js, source checkout, or development tools.
It creates a locally generated `Blackglass.app`, manifest, and receipt,
plus an owner-only hash-addressed copy of the verified official runtime. Close
ordinary Obsidian before opening the launcher. Blackglass uses a separate
profile and local CLI socket, disables upstream renderer updates, and refuses
competing renderer aliases or unrelated Obsidian processes.

The launcher and adapted renderer are local outputs and must not be published.
Official Bridge releases contain only the standalone open-source Bridge binary,
checksums, and source archive. The official application, copied private runtime,
ASARs, and proprietary assets remain outside public artifacts.

## Upgrades

Do not carry a compatibility claim forward by version number alone. For each
new Obsidian release, create and review a new compatibility candidate, inspect
every changed semantic incision and protocol inventory, run the fast and full
gates, build twice, and run the complete packaged-client conformance matrix.
Publish only the exact Bridge and Server revisions named by the resulting
validation record. The executable workflow is maintained in
[compatibility/README.md](../compatibility/README.md) and
[docs/e2e.md](e2e.md).
