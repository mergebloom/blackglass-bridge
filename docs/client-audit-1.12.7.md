# Independent client protocol audit: Obsidian 1.12.7

An independent agent inspected the authorized minified renderer artifact while
the server was implemented. This project retains only narrowly scoped
compatibility identifiers and excerpts needed to locate reviewed semantic
boundaries; it does not include a complete extracted source file or a
redistributable upstream application artifact.

## Compatibility findings applied

- Initial replay cannot be the full log: the client suppresses deletions during
  initial setup, so only current live heads are safe. Resume replay remains the
  ordered log after the client's version.
- The originating socket must receive a committed `push` notification before
  the request's final `ok`; this is how its remote-file state advances.
- History UI consumes a server-side `ts`, including for deletion revisions whose
  client mtime/ctime may be zero.
- Deleted items are oldest-first; history items are newest-first and paginate by
  UID.
- Restore is represented as a new revision and purge must retain live heads and
  a monotonic version.
- The `usernames` response is the top-level user map, not a wrapped object.
- Pre-authentication errors use `{res:"err",msg}`; authenticated operation
  errors use `{err}`.
- Standard managed encryption creates a random server password and 16-byte salt,
  then binds the client-derived key hash on first authorized access.

## Stable implementation boundary

Six fixed-length client-ASAR incisions implement two endpoint changes: the
control-plane origin is replaced in both `app.js` and the independent no-vault
`starter.js`, and the data-host authorization condition is replaced in
`app.js`. The main process CLI socket is replaced with the same-length dedicated
`.blackglass-c.sock` name, its registration target becomes the distinct local
`blackglass-cli` command, and its macOS runtime root prefers `BLACKGLASS_HOME`.
That sixth incision is qualified only for the current macOS target. The
official desktop wrapper is inspected and hash-bound but is never copied or
patched into a Blackglass release. A separate open-source launcher enforces the
three reviewed wrapper policies: an explicit mode-0700 isolated profile,
`updateDisabled: true`, and one exact renderer alias. It verifies and supervises
a private byte-identical official runtime supplied by the user. The GUI's native
`HOME` is preserved for login Keychain access; the dedicated short
`BLACKGLASS_HOME` holds only runtime sockets and a launch lease. All protocol
compatibility lives in named, tested server code. Minified identifiers and byte
offsets are not treated as stable APIs.

For a new release, the analyzer must rediscover each semantic anchor exactly
once and exactly match every packed JavaScript identity, every explicitly
reviewed JavaScript identity in `obsidian.asar.unpacked` and
`app.asar.unpacked`, request-helper and network-constructor inventory, reviewed
literal route and its helper location, literal-operation location,
outbound-message field shape, and inbound `onMessage` operation. The 1.12.7
renderer has no unpacked JavaScript; its wrapper has the reviewed `btime` and
`get-fonts` native-binding shims. An unknown, removed, moved, or changed item
causes generation to fail before any client profile is touched.

The packaged qualification also opens `starter.html` from a genuinely empty
default profile and requires successful `/user/signin` and `/vault/list`
responses at the configured TLS control origin. This prevents normal-vault E2E
setup from masking a broken fresh-install route. Its canonical recovery corpus
also contains a runtime-generated PNG larger than the client's 2 MiB piece size;
the bound manifest makes multipart upload and byte-identical cold download a
release requirement without committing the generated image.
