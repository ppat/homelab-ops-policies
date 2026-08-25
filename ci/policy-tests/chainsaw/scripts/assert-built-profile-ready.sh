#!/usr/bin/env bash
# assert-built-profile-ready.sh <built-profile-dir>
#
# Asserts that EVERY policy in a built profile directory (ci/policy-tests/.build/<profile>/,
# produced by ci/scripts/build-policies.sh) has reached Ready on the cluster. Used by the
# per-profile ready-smoke Chainsaw tests: the cheapest cluster-level catch for engine-level
# rejects -- CEL the webhook refuses, RBAC the background controller lacks -- across every policy
# at once.
#
# WHY THIS IS A SCRIPT AND NOT A CHAINSAW `assert:` BLOCK. Two independent reasons, both of which
# a future reader will otherwise try to "simplify" away:
#
#   1. ANY vs ALL. A chainsaw resource-shaped assertion that names a Kind but no `metadata.name`
#      is checked against every object of that Kind and is satisfied the moment ANY ONE of them
#      matches -- not when all of them do (verified in this org's own assertion-semantics suite:
#      homelab-ops-kubernetes-apps ci/test/assertion-semantics/chainsaw-test.yaml, the
#      `collections-match-any-not-all` Test; that repo keeps
#      ci/test/chainsaw/scripts/daemonset-node-coverage.sh for exactly this gap). "Every policy in
#      this profile is Ready" is an ALL claim, so it needs an explicit count comparison, which is
#      what this script is. A bare collection assert would go green with one Ready policy and
#      twenty-nine broken ones.
#   2. TWO DIFFERENT STATUS SHAPES coexist in a profile. `ClusterPolicy`/`ClusterCleanupPolicy`
#      report readiness as a `Ready` entry in `.status.conditions[]`; the `policies.kyverno.io`
#      kinds report it as the boolean `.status.conditionStatus.ready` (with `WebhookConfigured`
#      and `RBACPermissionsGranted` entries under `.status.conditionStatus.conditions[]`). Both
#      are handled below, so one script covers a profile holding any mix of the two.
#
# Reads the BUILT stream rather than the source tree so it sees exactly the resources the
# accompanying `apply:` step installed -- including anything an exemption patch changed, and
# excluding the exemptions/ patch files, which are not manifests.
set -euo pipefail

built_dir="${1:?usage: assert-built-profile-ready.sh <built-profile-dir>}"
deadline_seconds="${2:-120}"

mapfile -t entries < <(
  # `kind/name` per built document. Cluster-scoped kinds only -- everything this repo ships is.
  yq --no-doc '[.kind, .metadata.name] | join("/")' "${built_dir}"/*.yaml
)

if [[ "${#entries[@]}" -eq 0 ]]; then
  echo "FAIL: no built policies found under ${built_dir}." >&2
  echo "  This assertion is vacuously satisfiable when the directory is empty, so an empty" >&2
  echo "  directory is treated as a failure rather than a pass. Did ci/scripts/build-policies.sh" >&2
  echo "  run before this test?" >&2
  exit 1
fi

echo "Asserting all ${#entries[@]} policies from ${built_dir} reach Ready (deadline ${deadline_seconds}s)..."

# KINDS THAT DO NOT PUBLISH READINESS AT ALL, and must therefore be asserted more weakly.
# Measured on a stock Kyverno install: a `ClusterCleanupPolicy` sits at `status: null`
# indefinitely after being accepted -- its CRD declares a `status.conditions` array, but nothing
# populates it until the policy's schedule first fires, and this repo's schedules are hourly and
# daily. Existence is still a real signal for that kind rather than a shrug: the cleanup
# controller's admission webhook REJECTS a cleanup policy outright when it lacks delete
# permission on the target kind ("cleanup controller has no permission to delete kind Pod"), so a
# ClusterCleanupPolicy that exists is one whose RBAC was granted -- which is the entire thing
# this smoke test wants to know about it.
#
# Enumerated explicitly, never inferred from "no status found", so a policy kind that SHOULD be
# reporting Ready and silently stops cannot quietly downgrade itself into the weaker assertion.
readiness_exempt_kinds=" ClusterCleanupPolicy "

# `DeletingPolicy` gets its own weaker check, kept separate from readiness_exempt_kinds above:
# the code path is the same, the reasoning is not, and the two will diverge again the moment
# either kind's status behaviour changes. Both points below are measured, not inferred:
#
#   - `status.conditionStatus.ready` and `.conditions[]` -- the exact fields this script's "new
#     shape" branch checks -- are declared in the DeletingPolicy CRD and never populated by the
#     cleanup controller, which only ever writes `status.lastExecutionTime`. Left to the checks
#     below, this kind would burn the full deadline and then report not-ready in the case where
#     everything is working.
#   - Existence proves LESS here than it does for ClusterCleanupPolicy. Missing cleanup-controller
#     RBAC does not block admission for a DeletingPolicy the way it does for a
#     ClusterCleanupPolicy: one targeting a kind the controller cannot delete is admitted without
#     complaint, and the failure surfaces only in controller logs at execution time. What
#     existence still proves is that the CEL compiled -- a bad `spec.conditions[].expression` IS
#     refused by `validate-policy.kyverno.svc`.
#
# RBAC coverage for this kind is therefore proven only by the dedicated cleanup-empty-replicasets
# Chainsaw test (../best-practices/cleanup-empty-replicasets/), which patches the schedule down
# and asserts a real deletion end to end.
existence_only_kinds=" DeletingPolicy "

deadline=$((SECONDS + deadline_seconds))
declare -a not_ready=()
while :; do
  not_ready=()
  for entry in "${entries[@]}"; do
    kind="${entry%%/*}"
    name="${entry##*/}"
    if [[ "${readiness_exempt_kinds}" == *" ${kind} "* || "${existence_only_kinds}" == *" ${kind} "* ]]; then
      if kubectl get "${kind}" "${name}" >/dev/null 2>&1; then
        continue
      fi
      not_ready+=("${entry} (kind publishes no reliable readiness signal within this test's budget; the object itself is absent)")
      continue
    fi
    # Both readiness shapes, queried separately. A jsonpath over an absent field yields the empty
    # string rather than an error, so a policy whose status is not yet populated simply reports
    # empty and is counted as not-ready this round instead of aborting the loop.
    new_shape="$(kubectl get "${kind}" "${name}" -o jsonpath='{.status.conditionStatus.ready}' 2>/dev/null || true)"
    legacy_shape="$(kubectl get "${kind}" "${name}" -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}' 2>/dev/null || true)"
    if [[ "${new_shape}" == "true" || "${legacy_shape}" == "True" ]]; then
      continue
    fi
    not_ready+=("${entry} (conditionStatus.ready='${new_shape}' conditions[Ready]='${legacy_shape}')")
  done
  [[ "${#not_ready[@]}" -eq 0 ]] && break
  (( SECONDS >= deadline )) && break
  sleep 3
done

if [[ "${#not_ready[@]}" -ne 0 ]]; then
  echo "FAIL: ${#not_ready[@]} of ${#entries[@]} policies from ${built_dir} did not reach Ready:" >&2
  printf '  - %s\n' "${not_ready[@]}" >&2
  exit 1
fi

echo "OK: all ${#entries[@]} policies from ${built_dir} are Ready."
