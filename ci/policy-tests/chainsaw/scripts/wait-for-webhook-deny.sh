#!/usr/bin/env bash
# wait-for-webhook-deny.sh <manifest> [deadline-seconds]
#
# Blocks until the Kyverno admission webhook REJECTS <manifest>, or fails loudly at the deadline.
# Every Chainsaw test in this repo that patches a policy to `[Deny]` and then asserts a rejection
# calls this first.
#
# WHY IT EXISTS -- this replaces upstream kyverno/policies' blind `sleep 10s`, which this repo
# deliberately does not inherit (design doc phase2.0-policy-migration-design-v3.md §6.4). A
# policy's Ready conditions say the webhook is CONFIGURED; they do not say the API server has
# picked that configuration up. In the window between the two, a `[Deny]` policy admits what it
# is supposed to refuse, so a test's `expect: ($error != null)` fails for a reason that has
# nothing to do with the policy. A fixed sleep manages that window badly in both directions: too
# short and the suite is flaky, too long and every test pays for it forever.
#
# The observable polled here is the only one that means what the test needs: not "is the policy
# Ready", but "does the API server actually refuse this write". `--dry-run=server` runs the full
# admission chain, webhooks included, and persists nothing -- so the caller can poll with the
# very fixture it is about to apply for real, without consuming it.
#
# A non-zero exit from `kubectl apply` is conflated with rejection on purpose: at this point in a
# test the manifest has already been applied successfully at least once in some form, and any
# other error (unreachable API server, malformed YAML) will fail the caller's own steps
# immediately afterwards with a better message than this loop could produce. The deadline branch
# dumps the policy so a genuine hang is debuggable from the CI log alone.
set -euo pipefail

manifest="${1:?usage: wait-for-webhook-deny.sh <manifest> [deadline-seconds]}"
deadline_seconds="${2:-90}"
# `default` rather than the test's own namespace: this repo's policies are cluster-scoped and
# none of its exemptions name `default`, so a probe there is never accidentally exempted.
probe_namespace="${3:-default}"

deadline=$((SECONDS + deadline_seconds))
until ! kubectl apply --dry-run=server --namespace "${probe_namespace}" -f "${manifest}" >/dev/null 2>&1; do
  if (( SECONDS >= deadline )); then
    echo "FAIL: no admission webhook rejected ${manifest} within ${deadline_seconds}s." >&2
    echo "  The policy under test reported Ready, so suspect webhook propagation, or that" >&2
    echo "  validationActions was not patched to [Deny], or that the fixture is not actually a" >&2
    echo "  violation. Current ValidatingPolicy objects follow." >&2
    kubectl get validatingpolicy -o yaml >&2 || true
    exit 1
  fi
  sleep 1
done

echo "OK: the admission webhook rejects ${manifest}; the policy is live."
