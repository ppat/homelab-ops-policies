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

## Policy kinds

The tree holds a mix, and the `kind:` line in each policy file is the
authority on which is which: a growing set is
`policies.kyverno.io/v1 ValidatingPolicy`, the rest are still Kyverno's
deprecated `ClusterPolicy`/`ClusterCleanupPolicy`, ported one at a time.
`best-practices/restrict-node-port.yaml` and
`pod-security-standard/restricted/restrict-volume-types.yaml` are the
house-style references — their file headers state the
conventions (`metadata.name` equals the file basename, alphabetical `spec`
keys, null-safe statically-bool CEL, where provenance and snapshot comments
go).

`ValidatingPolicy.spec.matchConditions` is a flat top-level list whose
entries are ANDed, so appending to it can only ever narrow a policy. That is
the seam the exemption layer uses: Pod Security Standards policy files are
exemption-free mirrors of the upstream standard, and each estate exemption is
a JSON6902 patch under
`pod-security-standard/<profile>/exemptions/<policy>.yaml`, wired up by a
`patches:` entry in that profile's `kustomization.yaml`. See
`pod-security-standard/restricted/exemptions/restrict-volume-types.yaml`, the
house-style reference for an exemption patch. `best-practices/` policies keep
their exemptions inline — the split buys diffability against an external
standard, which those policies don't have.

A consumer therefore applies the `kustomize build` output of a profile
directory, never a single file. Both test tiers run against that built output
(`ci/scripts/build-policies.sh`).

## What this repo is (and isn't)

This is a content-only repo: Kyverno policy YAML, nothing else. There is no
application code, no Flux wiring, and no cluster awareness — this repo
doesn't know what's consuming it, how many
consumers there are, or what they're called. It's released independently and
referenced by a pinned tag from wherever it's applied, the same pattern
`homelab-ops-kubernetes-apps` uses for its modules: one versioned artifact,
consumed via a Flux `GitRepository` + `Kustomization.spec.path` pair defined
entirely on the consumer's side.

If a task starts to require knowing about a specific cluster, a specific
`Kustomization`, or Flux state — that's out of scope here. It belongs in the
repo that wires this content up (currently `homelab-ops-kubernetes-clusters`).

## Repository layout

- `best-practices/` — validate/mutate/cleanup policies not tied to Pod
  Security Standards
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

- **Enforcement mode is a point-of-use decision, not something to hardcode
  per intended consumer here.** It is spelled `validationFailureAction` on
  `ClusterPolicy` and `validationActions` on `ValidatingPolicy`, and is
  absent from the mutate and cleanup/deleting kinds either way. A consumer
  wanting a different mode overrides it with a `Kustomization.spec.patches`
  entry targeting the relevant kind, the way the
  `homelab-ops-kubernetes-clusters` repo's `policy-*.yaml` Kustomizations do.
  Don't add cluster-flavored variants of the same policy to work around this.
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
unmodified module. A legacy `ClusterPolicy` is more monolithic — narrowing
its rule logic means rewriting the rule — so for those the dividing line is
enforcement mode and blanket exclusions (patchable from outside) versus what
the policy actually validates/mutates, which has to be right for every
consumer as authored. A `ValidatingPolicy` is less constrained: its
`matchConditions` list is an append-only narrowing seam, which is what the
exemption layer described above uses.

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

Each remaining CI concern gets its own workflow file rather than sharing one:

- `.github/workflows/policy-smoke-check.yaml` — probes every policy in the
  repo (both the shipped per-file YAML and the `kustomize build` output of
  each profile) against `ci/policy-tests/smoke-resource.yaml` with `kyverno
  apply`, asserting each one still parses, is accepted by Kyverno's CRD
  schema, and has no CEL compile or runtime error. Not that it behaves any
  particular way.
- `.github/workflows/policy-cli-tests.yaml` — the `kyverno test` tier:
  `cli.kyverno.io/v1alpha1 Test` files under `ci/policy-tests/kyverno/`,
  mirroring the policy tree by profile and policy name. This is where a
  policy's rule semantics and its exemption expressions are asserted, per
  resource, with pass/fail/skip distinguished. No cluster required.
- `.github/workflows/e2e-tests.yaml` — the Chainsaw cluster tier: a real kind
  cluster on the estate's pinned Kubernetes minor plus the estate's pinned
  Kyverno chart, running `ci/policy-tests/chainsaw/`. Reserved for what a
  cluster can prove and the CLI cannot (policy readiness against the real
  webhook, rejection under a `Deny` validation action, an exemption firing
  for a controller-created pod), not a re-run of the CLI tier.

The Kyverno CLI version, the kind node image and the Kyverno Helm chart
version move together, and track what the estate actually runs — CI that
exercises a different engine than production is testing the wrong thing.

`.github/workflows/release.yaml` runs release-please on pushes to `main`.
`.pre-commit-config.yaml` mirrors the yamllint/markdownlint/shellcheck/
commitlint checks locally via `pre-commit run --all-files`; it does not
include the Kubernetes-manifest or Kyverno-CLI validation above, which are
CI-only.
