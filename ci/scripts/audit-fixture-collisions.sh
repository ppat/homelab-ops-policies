#!/usr/bin/env bash
# Enforces, repo-wide, the fixture rule that
# ci/policy-tests/kyverno/baseline/disallow-privileged-containers/kyverno-test.yaml's header
# documents in prose but nothing previously checked mechanically (surfaced during Wave E of the
# Kyverno kind migration, phase2.2 follow-up): a `kyverno test` `results[].resources` selector is
# `<namespace>/<name>`, resolved against whatever a `Test` document's own `resources:` list
# loads. Two failure modes are both silent -- neither is a `kyverno test` error, both still
# report green:
#
#   (a) COLLISION. Two different fixture FILES named under the same `Test` document's
#       `resources:` list declare the same `<namespace>/<name>`. `kyverno test` keeps only one of
#       them (confirmed empirically against the pinned CLI, v1.18.2: it logs
#       "warning: found duplicated resource" to stderr, on a line CI does not fail on, and
#       silently proceeds with whichever one it kept) -- the other stops being tested with no
#       failing assertion anywhere.
#   (b) BROKEN SELECTOR. A `results[].resources` entry names a `<namespace>/<name>` that no
#       fixture loaded by that same `Test` document's `resources:` list actually declares (a
#       typo, most often). Per restrict-node-port/kyverno-test.yaml's convention 4, this does not
#       fail -- the row's expected result is applied to EVERY loaded resource instead, so the
#       suite still goes green while asserting something other than what it claims.
#
# Collisions and selectors are both scoped to a single `Test` document (one `kind: Test` YAML
# document, identified by its own `metadata.name`) -- confirmed empirically: two `Test` documents,
# whether in separate files or two documents in the same file, load their `resources:` lists
# independently with no cross-document caching. Reusing a `<namespace>/<name>` pair ACROSS `Test`
# documents is normal and common (`default/ordinary-workload` alone appears in 20 files) and is
# NOT flagged here.
#
# Run by .github/workflows/policy-cli-tests.yaml as a dedicated step, before `kyverno test`
# itself, so a collision is reported with the offending file+resource pair rather than surfacing
# (or not surfacing at all) as an inexplicable wrong-verdict assertion failure downstream.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
test_root="${repo_root}/ci/policy-tests/kyverno"

fail=0
files_checked=0
docs_checked=0

while IFS= read -r test_file; do
  files_checked=$((files_checked + 1))
  rel_test_file="${test_file#"${repo_root}"/}"
  dir="$(dirname "${test_file}")"
  doc_count="$(yq eval-all '[.] | length' "${test_file}")"

  for ((doc_idx = 0; doc_idx < doc_count; doc_idx++)); do
    kind="$(yq eval "select(document_index==${doc_idx}) | .kind" "${test_file}")"
    if [[ "${kind}" != "Test" ]]; then
      continue
    fi
    docs_checked=$((docs_checked + 1))
    test_name="$(yq eval "select(document_index==${doc_idx}) | .metadata.name" "${test_file}")"
    doc_label="${rel_test_file} (document ${doc_idx}, Test/${test_name})"

    mapfile -t resource_files < <(yq eval "select(document_index==${doc_idx}) | .resources[]" "${test_file}")

    # <namespace>/<name> -> the resources: entry (relative path, as written in the Test document)
    # that first claimed it. Fresh per Test document -- collisions are scoped to one document, not
    # to the file or the repo (see header).
    declare -A key_owner=()

    for rel in "${resource_files[@]}"; do
      fixture_path="$(cd "${dir}" && realpath -m "${rel}")"
      if [[ ! -f "${fixture_path}" ]]; then
        echo "::error::${doc_label}: resources: entry '${rel}' does not resolve to a file (${fixture_path#"${repo_root}"/})"
        fail=1
        continue
      fi

      fixture_doc_count="$(yq eval-all '[.] | length' "${fixture_path}")"
      for ((fd = 0; fd < fixture_doc_count; fd++)); do
        ns="$(yq eval "select(document_index==${fd}) | .metadata.namespace // \"\"" "${fixture_path}")"
        name="$(yq eval "select(document_index==${fd}) | .metadata.name // \"\"" "${fixture_path}")"
        key="${ns}/${name}"

        if [[ -n "${key_owner[${key}]:-}" ]]; then
          if [[ "${key_owner[${key}]}" != "${rel}" ]]; then
            echo "::error::${doc_label}: '${key}' is declared by both '${key_owner[${key}]}' and '${rel}' -- kyverno test cannot distinguish them; one stops being tested silently"
            fail=1
          fi
          # Same file listed twice under resources: (harmless, not a cross-fixture collision) --
          # nothing to flag.
        else
          key_owner[${key}]="${rel}"
        fi
      done
    done

    mapfile -t selectors < <(yq eval "select(document_index==${doc_idx}) | (.results // [])[] | (.resources // [])[]" "${test_file}")
    for sel in "${selectors[@]}"; do
      [[ -n "${sel}" ]] || continue
      if [[ -z "${key_owner[${sel}]:-}" ]]; then
        echo "::error::${doc_label}: results[].resources selector '${sel}' matches no fixture loaded by this document's resources: list -- it silently broadens to every loaded resource instead of failing"
        fail=1
      fi
    done
  done
done < <(find "${test_root}" -name 'kyverno-test.yaml' | sort)

if [[ "${fail}" -ne 0 ]]; then
  echo ""
  echo "FAIL: fixture <namespace>/<name> collision / selector-resolution audit found problems above."
  exit 1
fi

echo "OK: audited ${docs_checked} Test document(s) across ${files_checked} kyverno-test.yaml file(s) -- no fixture collisions, no broken result selectors."
