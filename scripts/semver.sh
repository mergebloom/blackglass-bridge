#!/usr/bin/env bash

# SemVer 2.0 without build metadata. Keep this grammar aligned with
# tools/semver.ts; tests/semver.test.ts exercises both implementations.
is_supported_semver() {
  local version=${1-}
  local LC_ALL=C
  local core='(0|[1-9][0-9]*)'
  local nonnumeric='[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*'
  local prerelease="(${core}|${nonnumeric})"
  local pattern="^${core}\\.${core}\\.${core}(-${prerelease}(\\.${prerelease})*)?$"
  [[ "$version" =~ $pattern ]]
}

is_supported_release_tag() {
  local tag=${1-}
  [[ "$tag" == v* ]] && is_supported_semver "${tag#v}"
}
