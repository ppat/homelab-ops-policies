#!/usr/bin/env bash
# allow-replicaset-cleanup.sh
#
# Removes the `[ReplicaSet,*,*] [ReplicaSet/?*,*,*]` entries from the `kyverno` ConfigMap's
# `resourceFilters` key, in place, on whatever cluster KUBECONFIG points at.
#
# WHY THIS EXISTS: the Kyverno chart's DEFAULT `resourceFilters` value excludes ReplicaSets from
# EVERY policy engine, admission and background/cleanup alike, upstream of and independent of any
# policy's own `matchConstraints`/`conditions`. Measured against a stock chart install with no
# custom values -- the same install .github/workflows/e2e-tests.yaml performs: an unconditional
# `DeletingPolicy` over every `apps/v1` ReplicaSet, with correct RBAC and a LIST returning real
# items, never reaches the cleanup controller's per-object delete path until these two entries
# are gone. Pods and Deployments are not blanket-filtered this way, so this is a
# ReplicaSet-specific default rather than a general property of background cleanup.
#
# A CROSS-REPO WORKAROUND, NOT A FIX. A consuming estate's own Kyverno values must carry the
# equivalent override or `cleanup-empty-replicasets` has never deleted anything there. This
# script only lets the Chainsaw tier prove the policy's own logic in an environment that would
# otherwise swallow every deletion before the policy's CEL is reached. See
# best-practices/cleanup-empty-replicasets.yaml's header.
#
# Read-modify-write against the LIVE value, never a hardcoded replacement: the chart's default
# string covers many unrelated entries this script has no opinion about and must not revert if
# the chart changes its default.
#
# Saves the pre-patch value to ${ORIG_FILE:-/tmp/kyverno-resourceFilters.orig} for the paired
# restore-replicaset-cleanup-filter.sh, which must run in a `finally:` block -- see that script.
set -euo pipefail

orig_file="${ORIG_FILE:-/tmp/kyverno-resourceFilters.orig}"

current="$(kubectl -n kyverno get configmap kyverno -o jsonpath='{.data.resourceFilters}')"
updated="${current//\[ReplicaSet,\*,\*\] /}"
updated="${updated//\[ReplicaSet\/\?\*,\*,\*\] /}"

if [[ "${updated}" == "${current}" ]]; then
  echo "FAIL: expected to find '[ReplicaSet,*,*]'/'[ReplicaSet/?*,*,*]' in the kyverno ConfigMap's" >&2
  echo "  resourceFilters and did not -- either the chart's default changed (re-verify this" >&2
  echo "  script's assumption) or something already removed them (this script is now redundant" >&2
  echo "  and should be dropped, not silently left as a no-op)." >&2
  exit 1
fi

printf '%s' "${current}" > "${orig_file}"

kubectl -n kyverno patch configmap kyverno --type=merge \
  -p "$(printf '{"data":{"resourceFilters":%s}}' "$(printf '%s' "${updated}" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')")"

echo "OK: removed the ReplicaSet resourceFilters entries from the kyverno ConfigMap (original saved to ${orig_file})."
