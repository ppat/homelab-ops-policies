#!/usr/bin/env bash
# allow-replicaset-cleanup.sh
#
# Removes the `[ReplicaSet,*,*] [ReplicaSet/?*,*,*]` entries from the `kyverno` ConfigMap's
# `resourceFilters` key, in place, on whatever cluster KUBECONFIG points at.
#
# WHY THIS EXISTS -- discovered empirically (Wave F-delete, cleanup-empty-replicasets): the
# Kyverno Helm chart's DEFAULT `resourceFilters` value excludes ReplicaSets from EVERY policy
# engine, admission and background/cleanup alike, upstream of and unrelated to any policy's own
# `matchConstraints`/`conditions`. Measured directly against a stock `helm install kyverno
# kyverno/kyverno --version 3.8.2` (the same install e2e-tests.yaml performs, no custom values):
# an unconditional `DeletingPolicy` matching every `apps/v1` ReplicaSet, with correct RBAC and a
# LIST call that returns real items, never reaches the deleting-controller's per-object
# match-and-delete code path until these two entries are removed. Deployments and Pods are NOT
# blanket-filtered this way (only specific `kyverno`-namespaced ones are) -- this is a
# ReplicaSet-specific default, not a general "background cleanup is filtered" property.
#
# THIS IS A CROSS-REPO WORKAROUND, NOT A FIX. The estate's actual Kyverno `HelmRelease` values
# (homelab-ops-kubernetes-apps, infra-security-core's kyverno module) must carry the equivalent
# override for `cleanup-empty-replicasets` to ever do anything on a real cluster -- this script
# only lets the Chainsaw tier prove the policy's OWN logic is correct in an environment that
# would otherwise silently swallow every deletion before this policy's CEL is ever evaluated.
# Verify the estate's real values already override `resourceFilters`; if they do not, this
# policy -- and its legacy `ClusterCleanupPolicy` predecessor -- has likely never actually
# cleaned up a ReplicaSet in production. See cleanup-empty-replicasets.yaml's own header for the
# full writeup.
#
# Read-modify-write against the LIVE value rather than a hardcoded full replacement: the chart's
# default `resourceFilters` string is long and covers many unrelated entries (kyverno's own
# managed resources, kube-system, etc.) that this script has no opinion about and must not
# accidentally revert if the chart changes its default between chart bumps.
#
# Saves the PRE-PATCH value to ${ORIG_FILE:-/tmp/kyverno-resourceFilters.orig} so the paired
# restore-replicaset-cleanup-filter.sh can put it back in a `finally:` block -- this ConfigMap is
# chart-installed, not created by this test, so Chainsaw's own cleanup (which only reverses what
# a test itself applied/created) will not undo this patch. Leaving it un-reverted would leak a
# global, cluster-wide config change into whatever Chainsaw test happens to run next in the same
# `parallel: 1` suite.
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
