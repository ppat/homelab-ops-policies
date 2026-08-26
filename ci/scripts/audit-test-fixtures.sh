#!/usr/bin/env bash
# Fails CI on two ways a `kyverno test` file can stop asserting what it claims while still
# reporting green. Neither is an error to the CLI; both were reproduced against the pinned
# version before this script was written.
#
#   1. COLLISION -- two fixture files under one Test document's `resources:` list declare the
#      same apiVersion+kind+namespace+name. The CLI loads one, drops the other, prints
#      "warning: found duplicated resource" on a line nothing fails on, and exits 0. The dropped
#      fixture is no longer under test and no assertion anywhere notices.
#   2. UNRESOLVED SELECTOR -- a `results[].resources` entry names a `<namespace>/<name>` that no
#      fixture in that document declares. Instead of erroring the row broadens to every loaded
#      resource, so it still passes whenever the expectation happens to hold for all of them.
#      restrict-node-port/kyverno-test.yaml's convention 4 asks every document to keep mixed
#      expectations precisely so a broadened row self-contradicts; that is a discipline, and this
#      is the check that stops it being the only defence.
#
# Scope is one Test document, never a file or the repo. Documents load their `resources:` lists
# independently -- the `-built`/`-pure` pair every exemption-carrying policy ships legitimately
# loads identical fixtures from one file -- so reuse of a name across documents is normal and
# only within-document reuse is a fault.
#
# The two checks key on different things because the CLI does. Loading dedupes on full GVK, so a
# Pod and a Service sharing a namespace+name coexist and are not a collision. Selectors carry no
# kind, so they resolve against namespace+name alone, across every loaded resource regardless of
# the result row's own `kind:`.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
test_root="${repo_root}/ci/policy-tests/kyverno"

fail=0
files_audited=0
docs_audited=0

while IFS= read -r test_file; do
  files_audited=$((files_audited + 1))
  rel_test_file="${test_file#"${repo_root}"/}"
  test_dir="$(dirname "${test_file}")"

  # One compact JSON record per Test document, so the loop below never has to index back into the
  # file by document position.
  while IFS= read -r doc; do
    docs_audited=$((docs_audited + 1))
    doc_label="Test/$(yq -p=json '.name' <<<"${doc}")"

    # apiVersion/kind/namespace/name -> the resources: entry that declared it (collision check).
    declare -A gvk_owner=()
    # namespace/name -> 1 (selector resolution).
    declare -A selectable=()

    while IFS= read -r fixture_rel; do
      fixture="${test_dir}/${fixture_rel}"
      if [[ ! -f "${fixture}" ]]; then
        echo "::error file=${rel_test_file}::${doc_label}: resources: entry '${fixture_rel}' is not a file"
        fail=1
        continue
      fi

      while IFS=$'\t' read -r gvk_key name_key; do
        if [[ -n "${gvk_owner[${gvk_key}]:-}" && "${gvk_owner[${gvk_key}]}" != "${fixture_rel}" ]]; then
          echo "::error file=${rel_test_file}::${doc_label}: '${gvk_key}' is declared by both '${gvk_owner[${gvk_key}]}' and '${fixture_rel}' -- kyverno test loads only one of them and drops the other"
          fail=1
        else
          gvk_owner["${gvk_key}"]="${fixture_rel}"
        fi
        selectable["${name_key}"]=1
      done < <(yq eval-all '[.] | .[] | select(. != null) |
        (((.apiVersion // "") + "/" + (.kind // "") + "/" + (.metadata.namespace // "") + "/" + (.metadata.name // "")) + "	" +
         ((.metadata.namespace // "") + "/" + (.metadata.name // "")))' "${fixture}")
    done < <(yq -p=json '.resources[]' <<<"${doc}")

    while IFS= read -r selector; do
      if [[ -z "${selectable[${selector}]:-}" ]]; then
        echo "::error file=${rel_test_file}::${doc_label}: results[].resources selector '${selector}' matches no fixture this document loads -- the row silently broadens to every loaded resource"
        fail=1
      fi
    done < <(yq -p=json '.selectors[]' <<<"${doc}")

    unset gvk_owner selectable
  done < <(yq eval-all -o=json -I=0 '[.] | .[] | select(.kind == "Test") | {
      "name": .metadata.name,
      "resources": (.resources // []),
      "selectors": [(.results // [])[] | (.resources // [])[]]
    }' "${test_file}")
done < <(find "${test_root}" -type f -name 'kyverno-test.yaml' | sort)

if [[ "${fail}" -ne 0 ]]; then
  echo "FAIL: fixture audit found problems above."
  exit 1
fi

echo "OK: audited ${docs_audited} Test document(s) across ${files_audited} kyverno-test.yaml file(s) -- no fixture collisions, every result selector resolves."
