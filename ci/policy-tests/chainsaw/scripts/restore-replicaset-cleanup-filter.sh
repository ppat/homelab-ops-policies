#!/usr/bin/env bash
# restore-replicaset-cleanup-filter.sh
#
# Paired with allow-replicaset-cleanup.sh: restores the `kyverno` ConfigMap's `resourceFilters`
# key to the value that script saved before removing the `[ReplicaSet,*,*]` entries.
#
# Belongs in a `finally:` block so it runs regardless of pass/fail. The ConfigMap is
# chart-installed rather than created by the test, and Chainsaw's cleanup only reverses what a
# test itself applied, so nothing else will put this back.
set -euo pipefail

orig_file="${ORIG_FILE:-/tmp/kyverno-resourceFilters.orig}"

if [[ ! -f "${orig_file}" ]]; then
  echo "FAIL: ${orig_file} does not exist -- allow-replicaset-cleanup.sh must run (and succeed)" >&2
  echo "  before this script in the same test, or there is nothing to restore from." >&2
  exit 1
fi

original="$(cat "${orig_file}")"

kubectl -n kyverno patch configmap kyverno --type=merge \
  -p "$(printf '{"data":{"resourceFilters":%s}}' "$(printf '%s' "${original}" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')")"

rm -f "${orig_file}"

echo "OK: restored the kyverno ConfigMap's resourceFilters to its pre-test value."
