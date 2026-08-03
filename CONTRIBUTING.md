# Contributing

Blackglass accepts improvements to the compatibility tooling, safety
checks, tests, and documentation. Contributions must not include proprietary
application binaries, ASARs, credentials, vault contents, or generated app
bundles.

## Development gate

Use the pinned Bun 1.3.8 runtime, then run:

```sh
npm ci
bun run check
```

Client changes must remain deterministic and fail closed. Add a test for every
new semantic anchor or packaging invariant. A new upstream renderer is not
supported until its authorized artifact hash, static analysis, copied-app
packaging, and isolated recovery E2E all pass.

Keep test profiles and vaults under `.data/` or an OS temporary directory.
Never point project tooling at a normal Obsidian profile or real vault.

## Legal boundary

Submit only code and observations you are authorized to share. The MIT license
covers this repository's original tooling; it does not license Obsidian or any
other upstream application.
