# Blackglass architecture

Blackglass Bridge is a compatibility boundary, not a reimplementation or
distribution of the Obsidian desktop application. Its public release contains a
standalone open-source launcher and reviewed compatibility baselines. A user
supplies an official DMG or application; the Bridge verifies its complete
identity, creates a private unmodified runtime copy, generates a narrowly
adapted renderer locally, and packages only the launcher plus that local
renderer.

At launch the Bridge verifies the official runtime tree and code inventory,
requires exclusive use of Obsidian's runtime identity, installs exactly one
hash-bound renderer alias into a mode-`0700` Blackglass profile, disables
renderer updates, generates a profile-local Blackglass CLI, removes only stale
Unix-socket leases, and supervises the official process tree. The renderer must
prove selection by creating `.blackglass-c.sock`; an upstream socket, changed
alias, changed adapter, changed update setting, unrelated Obsidian process, or
changed official tree fails closed.

Preserving the official application, executable, helper, and Safe Storage
identity is deliberate: renaming proprietary Electron components caused launch
failures. Files and profile state are isolated, but macOS Keychain behavior is
still provided by the official runtime identity. This is a known architectural
boundary that the conformance suite tests rather than obscures.

The companion Blackglass Server owns authentication, Rust/SQLite persistence,
WebSocket synchronization, tenant isolation, backup, and operations. Bridge
expects an HTTPS control origin and WSS data host. Exact supported combinations
come only from [compatibility/matrix.json](../compatibility/matrix.json).

For each upstream release, static analysis inventories every packed and
unpacked JavaScript file, request helper, network constructor, control route,
Sync operation, and message shape. Any source, anchor, or protocol drift creates
an untrusted candidate requiring explicit review. Source-bound release tooling
then runs deterministic patching, two independent packages, LaunchServices
smoke, full Sync/lifecycle/recovery E2E, secret redaction, and hash-chained
evidence before the compatibility matrix can gain a supported row.
