#!/usr/bin/env bash
set -euo pipefail

readonly actionlint_image="rhysd/actionlint:1.7.12@sha256:b1934ee5f1c509618f2508e6eb47ee0d3520686341fec936f3b79331f9315667"

pull_status=1
for attempt in 1 2 3; do
  if docker pull "$actionlint_image"; then
    pull_status=0
    break
  fi
  if [[ "$attempt" -lt 3 ]]; then
    sleep "$((attempt * 5))"
  fi
done

if [[ "$pull_status" -ne 0 ]]; then
  echo "error: unable to pull the pinned actionlint image after three attempts" >&2
  exit 1
fi

exec docker run --rm \
  -v "$PWD:/repo:ro" \
  -w /repo \
  "$actionlint_image" \
  .github/workflows/ci.yml \
  .github/workflows/release.yml
