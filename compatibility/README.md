# Reviewed client compatibility baselines

One JSON file qualifies one exact authorized renderer and macOS wrapper. The
analyzer compares source/key-file hashes, semantic-anchor counts, control
routes, literal Sync operations, and outbound message field shapes. Packaging
also requires the recorded wrapper hash and the release-specific recursive
inventory of every signed macOS bundle and Mach-O architecture.

Never copy a prior file and mark it trusted automatically. For a new renderer,
inspect every reported difference, update the protocol/server intentionally,
add regression tests, and then record the newly reviewed hashes and inventory.
Critical route, request-helper, network, operation, message-shape, and inbound
operation inventories must remain non-empty; the loader rejects a baseline that
silently disables any of those semantic gates.

For a new authorized release, generate an untrusted review packet with:

```sh
bun run baseline:candidate -- \
  /path/to/official-Obsidian.dmg \
  '/path/to/Obsidian.app' \
  --predecessor compatibility/obsidian-1.12.7.json
```

The command writes once under ignored `.data/compatibility-candidates/` and
never writes into this directory. Its proposed baseline remains deliberately
untrusted. Review the packed and unpacked minified-JavaScript differences,
update the protocol and server for intentional changes, add regression tests,
then manually convert its unpacked-file marker to `status: "reviewed"` with the
reviewed paths, and promote only the reviewed `proposedBaseline` here with
`apply_patch` or an equivalent manual edit.

The repository currently preserves 1.12.7 as the compatibility floor and
tracks the reviewed 1.13.4 static baseline as the current E2E candidate. See
[`docs/protocol/obsidian-1.13.4.md`](../docs/protocol/obsidian-1.13.4.md) for its
intentional protocol delta.
