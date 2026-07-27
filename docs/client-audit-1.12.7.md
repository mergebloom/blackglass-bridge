# Independent client protocol audit: Obsidian 1.12.7

An independent agent inspected the authorized minified renderer artifact while
the server was implemented. No extracted proprietary source was added to this
project.

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

Only two semantic client incisions are made: the control-plane origin and the
data-host authorization condition. All protocol compatibility lives in named,
tested server code. Minified identifiers and byte offsets are not treated as
stable APIs.

For a new release, the analyzer must rediscover each semantic anchor exactly
once and inventory the operation/route literals. A changed or ambiguous anchor
causes generation to fail before any client profile is touched.
