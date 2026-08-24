# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Start here

- [README.md](./README.md) — what this repo is, the policy groups, how a
  downstream repo consumes it, how it's released

There is no `DESIGN.md` yet. It's deliberately deferred until a planned
migration off deprecated Kyverno policy kinds settles what this repo's
manifests actually look like — don't write one prematurely, and don't stretch
this file or the README to cover architecture decisions that migration will
change.

## What this repo is (and isn't)

This is a content-only repo: Kyverno `ClusterPolicy`/`ClusterCleanupPolicy`
YAML, nothing else. There is no application code, no Flux wiring, and no
cluster awareness — this repo doesn't know what's consuming it, how many
consumers there are, or what they're called. It's released independently and
referenced by a pinned tag from wherever it's applied, the same pattern
`homelab-ops-kubernetes-apps` uses for its modules: one versioned artifact,
consumed via a Flux `GitRepository` + `Kustomization.spec.path` pair defined
entirely on the consumer's side.

If a task starts to require knowing about a specific cluster, a specific
`Kustomization`, or Flux state — that's out of scope here. It belongs in the
repo that wires this content up (currently `homelab-ops-kubernetes-clusters`).

## Repository layout

- `best-practices/` — validate/mutate/cleanup `ClusterPolicy`/`ClusterCleanupPolicy`
  objects not tied to Pod Security Standards
- `pod-security-standard/baseline/` — Kubernetes Pod Security Standards,
  Baseline profile, ported to Kyverno
- `pod-security-standard/restricted/` — Restricted profile; its
  `kustomization.yaml` lists `../baseline` as a resource, so applying
  `restricted` also applies everything in `baseline`

No `policies/` prefix directory — the whole repo *is* the policies content,
so a wrapping directory would just be noise.

## Keeping policies cluster-agnostic

Policy content in this repo must not bake in assumptions about which cluster,
or how many clusters, will apply it. Concretely:

- **`validationFailureAction` (Audit vs. Enforce, only present on `Validate`
  rules — `Mutate` policies and `ClusterCleanupPolicy` don't have it) is a
  point-of-use decision, not something to hardcode per intended consumer
  here.** A consumer that wants a different enforcement mode overrides it
  with a `Kustomization.spec.patches` entry targeting `kind: ClusterPolicy`,
  the same way the current `homelab-ops-kubernetes-clusters` repo's
  `policy-*.yaml` Kustomizations do it today. Don't add cluster-flavored
  variants of the same policy to work around this.
- **Namespace/workload `exclude` blocks are judged by whether the exemption
  is universal, not by which cluster happens to run the excluded thing.** An
  exclusion for `kube-system`, `cert-manager`, or similar runs-everywhere
  infra is fine to bake into the policy itself — every consumer needs it. An
  exclusion that only makes sense for one specific consumer's environment
  does not belong here; it belongs in a patch at the point of use.

This is a narrower reading of the modules-repo principle ("`dependsOn`/
`components`/`postBuild`/`patches` apply only at the point of use, never
inside the module") than it might first look: modules there compose cleanly
because each cluster's `Kustomization` can layer config *on top of* an
unmodified module. A Kyverno `ClusterPolicy` is more monolithic — there's no
equivalent "layer a patch that adds one more allowed namespace" primitive
inside the policy's own rule logic without rewriting the rule, so the
practical dividing line is enforcement mode and blanket exclusions (patchable
from outside) versus what the policy actually validates/mutates (not
meaningfully patchable, so it has to be right for every consumer as
authored).

## Commit conventions

Conventional Commits, enforced by commitlint. `commitlint.config.js` is the
source of truth for allowed types/scopes — read it rather than assuming scopes
from another repo apply here; the scope taxonomy is a placeholder pending a
dedicated redesign once the Kyverno policy-kind migration settles the repo's
shape.

## CI

`.github/workflows/lint.yaml` runs on every PR (and weekly): commit message
linting, GitHub Actions linting, markdown linting, the full `pre-commit` hook
set, Renovate config validation, YAML linting, `zizmor` (GitHub Actions
security scanning), and a `kubernetes-manifests` job — each job gated on
whether matching files changed. The `kubernetes-manifests` job runs
`ppat/validate-kubernetes-manifests` (kubeconform-based schema validation via
`flux build`/`kustomize`) against `best-practices/**/*.yaml` and
`pod-security-standard/**/*.yaml`, configured by `ci/validation/.env` and
`ci/validation/kustomization.yaml`.

`.github/workflows/static-analysis.yaml` runs the Kyverno CLI (`kyverno
apply`, no live cluster required) against the policy YAML on PRs that touch
policy files, plus weekly: a `volume-types` job that runs the fixture-based
behavioral suite in `ci/policy-tests/fixtures/restrict-volume-types/` against
the real `restrict-volume-types` policy, and a `structural-smoke-check` job
that probes every `ClusterPolicy`/`ClusterCleanupPolicy` in the repo against
`ci/policy-tests/smoke-resource.yaml` to assert each one still parses and
loads (not that it behaves any particular way).

`.github/workflows/release.yaml` runs release-please on pushes to `main`.
`.pre-commit-config.yaml` mirrors the yamllint/markdownlint/shellcheck/
commitlint checks locally via `pre-commit run --all-files`; it does not
include the Kubernetes-manifest or Kyverno-CLI validation above, which are
CI-only.
