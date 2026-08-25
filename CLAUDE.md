# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Start here

- [README.md](./README.md) — what this repo is, the policy groups, how a
  downstream repo consumes it, how it's released
- [DESIGN.md](./DESIGN.md) — why the repo is shaped this way: the pure-mirror /
  exemption-patch layering, the migration off the deprecated policy kinds, the
  test tiers, the regression tally, and the decisions still open

## What this repo is (and isn't)

This is a content-only repo: Kyverno policy YAML, nothing else. There is no
application code, no Flux wiring, and no cluster awareness — this repo doesn't
know what's consuming it, how many consumers there are, or what they're called.
It's released independently and referenced by a pinned tag from wherever it's
applied, the same pattern `homelab-ops-kubernetes-apps` uses for its modules:
one versioned artifact, consumed via a Flux `GitRepository` +
`Kustomization.spec.path` pair defined entirely on the consumer's side.

If a task starts to require knowing about a specific cluster, a specific
`Kustomization`, or Flux state — that's out of scope here. It belongs in the
repo that wires this content up (currently `homelab-ops-kubernetes-clusters`).

## Repository layout

The policy directories **are** the released artifact — a consumer points a Flux
`Kustomization.spec.path` straight at one. Nothing test-shaped may live in them.

```text
best-practices/                     # Validate/Mutate/Delete policies not tied to PSS.
                                    #   Exemptions stay INLINE in each policy file.
pod-security-standard/
  baseline/                         # PSS Baseline mirrors (pure, exemption-free)
    exemptions/<policy>.yaml        #   JSON6902 patch docs, one per exemption-bearing policy
    kustomization.yaml              #   resources: + patches: wiring the two together
  restricted/                       # PSS Restricted; lists ../baseline as a resource
    exemptions/<policy>.yaml
    kustomization.yaml
ci/
  policy-tests/
    kyverno/<profile>/<policy>/     # `kyverno test` tier (offline)
    chainsaw/<profile>/<policy>/    # Chainsaw tier (live kind cluster)
    chainsaw/<profile>/ready-smoke/ #   one per profile: every policy reaches Ready
    chainsaw/scripts/               #   shared helper scripts used by chainsaw steps
    chainsaw/.chainsaw.yaml         #   shared Chainsaw config
    chainsaw/kind-config.yaml       #   the CI kind cluster
    smoke-resource.yaml             # the one Pod policy-smoke-check.yaml probes against
    .build/                         # GITIGNORED: `kustomize build` output, per policy
  scripts/build-policies.sh         # produces .build/ — run it before running tests locally
  validation/                       # kubeconform harness config for lint.yaml
```

No `policies/` prefix directory — the whole repo *is* the policies content,
so a wrapping directory would just be noise.

## Policy kinds and house style

Everything is `policies.kyverno.io/v1`: `ValidatingPolicy`, `MutatingPolicy`,
`DeletingPolicy`. The legacy `kyverno.io/v1 ClusterPolicy` and
`kyverno.io/v2beta1 ClusterCleanupPolicy` kinds are gone from this repo and must
not come back — they are deprecated since Kyverno v1.17 and removed in v1.20.

Read these files first; they set the house style and their headers state the
conventions rather than merely following them:

- `best-practices/restrict-node-port.yaml` — the `ValidatingPolicy` shape and
  CEL conventions (`metadata.name` equals the file basename, alphabetical `spec`
  keys, null-safe statically-bool CEL, where provenance comments go).
- `pod-security-standard/restricted/restrict-volume-types.yaml` — the PSS-mirror
  family conventions: the `PSS-SNAPSHOT` marker, the empty `matchConditions`
  seam, autogen off.
- `pod-security-standard/restricted/exemptions/restrict-volume-types.yaml` — the
  exemption-patch shape, including the seven numbered rules its header states
  (negation direction, `name`+`generateName` concatenation and the *narrower*
  rationale that actually justifies it, glob translation, namespace always part
  of the predicate).
- `best-practices/cleanup-empty-replicasets.yaml` — the fuller `DeletingPolicy`
  reference, including the field-name trap below.

Traps worth knowing before writing CEL here:

- **`spec.variables` are not visible inside `spec.matchConditions`** — compile
  error, `undefined field`. Exemption expressions inline everything.
- **`DeletingPolicy.spec` has no `matchConditions` field.** The equivalent is
  `spec.conditions[]`, same `{name, expression}` item shape. The CRD is
  structural with strict decoding, so a typo here is rejected outright rather
  than silently ignored.
- **Autogen is off (`spec.autogen.podControllers.controllers: []`) on every
  policy in this repo, deliberately.** Autogen rewrites `object.` to
  `object.spec.template.` throughout a policy *including* `matchConditions`, so
  a metadata-based exemption silently stops matching on real controllers. Off by
  construction beats managed per policy. Re-enabling it anywhere means
  re-checking every exemption in that policy.
- **A kustomize patch whose `target:` matches nothing is a silent no-op**, not a
  build error. The thing that catches a mistyped target is the CLI-tier fixture
  asserting `skip` on that exemption's firing resource.

## Keeping policies cluster-agnostic

Policy content in this repo must not bake in assumptions about which cluster,
or how many clusters, will apply it. Concretely:

- **Enforcement mode is a point-of-use decision.** `spec.validationActions`
  exists only on `ValidatingPolicy` (`MutatingPolicy` and `DeletingPolicy` have
  no equivalent). Everything here ships `[Audit]`; a consumer that wants
  `[Deny]` or `[Audit, Warn]` overrides it with a `Kustomization.spec.patches`
  entry targeting `kind: ValidatingPolicy`. Don't add cluster-flavored variants
  of the same policy to work around this.
- **Namespace/workload exemptions are judged by whether the exemption is
  universal, not by which cluster happens to run the excluded thing.** An
  exemption for `kube-system`, `cert-manager`, or similar runs-everywhere infra
  is fine to carry here — every consumer needs it. One that only makes sense for
  one specific consumer's environment belongs in a patch at the point of use.

### Exclusions *are* patchable from outside now — this repo's older claim is false

An earlier version of this file said policy exclusions were "not meaningfully
patchable from outside," so the practical dividing line was enforcement mode and
blanket exclusions versus everything else. **That was true of the legacy
`ClusterPolicy` API and is no longer true.** It described `exclude:` blocks
nested inside positional `rules[]`, where an outside patch had to index into a
list whose order was part of the policy's meaning.

The new kinds have a genuine seam:

- `ValidatingPolicy` and `MutatingPolicy` carry a flat, top-level
  `spec.matchConditions[]` of `{name, expression}` items; `DeletingPolicy`
  carries `spec.conditions[]` with the same item shape.
- **Every entry is ANDed**, and each states when the policy *should* apply. So
  an appended entry can only ever remove resources from what the policy looks
  at. It cannot weaken a validation, and it cannot reorder anything — there is
  no positional meaning to break.
- That makes `- op: add, path: /spec/matchConditions/-` a safe, composable
  append that anyone in the chain can perform: this repo does it from
  `<profile>/kustomization.yaml`, and a consumer can do exactly the same thing
  from its own `Kustomization.spec.patches` with identical content and
  semantics. Relocating an exemption estate-side is a file move, not a redesign.
- Every PSS mirror declares `matchConditions: []` precisely so the append path
  always exists, including on policies that have no exemptions today. The empty
  list is accepted both by the CLI compiler and by the live CRD.

What is *still* not patchable from outside is the thing the policy actually
validates or mutates — `spec.validations[].expression` is a single CEL string,
so "allow one more volume type" from outside means replacing the expression, not
extending it. That half of the original claim stands, and it is why a mirror
still has to be right for every consumer as authored. The exclusion half does
not.

## Testing

Two tiers. Which tier a claim belongs in is a real design question, not a
preference — see [DESIGN.md](./DESIGN.md#test-architecture-two-tiers) for the
ownership table.

- **`kyverno test` (`ci/policy-tests/kyverno/`, no cluster).** Owns validation
  and mutation rule semantics, and owns exemption *expressions* — including the
  `generateName`-only resource shape, which only exists offline. Asserts per
  resource, with `pass`/`fail`/`skip` distinguished. Every policy has a suite
  here. Known structural limit: this tier **cannot** assert "this resource was
  not matched at all" — no selector variant expresses it.
- **Chainsaw (`ci/policy-tests/chainsaw/`, live kind cluster).** Owns what only
  a cluster can show: policies reaching Ready against the real webhook and real
  RBAC, actual rejection under an in-test patch to `[Deny]`, mutations landing
  on live objects with no Audit backstop, `DeletingPolicy` schedules firing
  through the cleanup controller, and an exemption firing for a
  controller-created Pod arriving through real admission. A Chainsaw test exists
  only where the cluster adds information the CLI cannot produce — it is not a
  re-run of the CLI suite. A policy with no directory here is covered by its
  profile's `ready-smoke` plus the CLI tier, which is the intended steady state.

Rules that apply to both tiers:

- **Run against built output.** `ci/scripts/build-policies.sh` writes
  `kustomize build` of each profile into `ci/policy-tests/.build/<profile>/<policy>.yaml`
  (gitignored, named after `metadata.name`). Tests reference that, never a raw
  policy file — a policy plus its exemption patch is what a consumer applies,
  and a patch file alone is not valid YAML.
- **Every exemption gets a firing fixture**: a resource the pure policy flags and
  the built policy skips, paired with an assertion that the same resource *fails*
  against the pure file. An exemption without one rots silently.
- **Non-vacuous pairing**: a `-good` fixture is only meaningful next to a `-bad`
  sibling proving the policy still rejects, and an exemption fixture must carry a
  violation the policy would actually flag.

## Commit conventions

Conventional Commits, enforced by commitlint. `commitlint.config.js` is the
source of truth for allowed types and scopes — read it rather than assuming
scopes from another repo apply here.

The scope enum is still a placeholder. A dedicated pass to derive this repo's
commit taxonomy from scratch has not run yet; don't over-specify scopes or build
tooling around the current list. Most commits here need no scope at all.

The Kyverno kind migration was authored as breaking changes — `feat!` with a
`BREAKING CHANGE:` footer — because it changes the kind consumers patch against
by name. The intent is that these cut **v1.0.0**. That release has not been cut
yet (the repo is on `0.0.1`), and cutting it needs a config change first:
release-please bumps MINOR rather than MAJOR on a breaking change below 1.0.0
unless `release-please-config.json` sets `bump-minor-pre-major: false`, which it
currently does not.

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

Each remaining CI concern gets its own workflow file rather than sharing one
(the former bundled `static-analysis.yaml` was split into the first two below):

- `.github/workflows/policy-smoke-check.yaml` — probes every policy in the
  repo (both the shipped per-file YAML and the `kustomize build` output of
  each profile) against `ci/policy-tests/smoke-resource.yaml` with `kyverno
  apply`, asserting each one still parses, is accepted by Kyverno's CRD
  schema, and has no CEL compile or runtime error. Not that it behaves any
  particular way. It never trusts `kyverno apply`'s exit code — a malformed
  policy is silently *dropped* and still exits 0; the job reads the reported
  rule count and greps for `^Error:` instead.
- `.github/workflows/policy-cli-tests.yaml` — the `kyverno test` tier. Runs
  `ci/scripts/audit-fixture-collisions.sh` first: `kyverno test`'s
  `results[].resources` selector is `<namespace>/<name>`, resolved against
  whatever a single `Test` document's own `resources:` list loads, and two
  ways that can go wrong are both silent to the CLI itself — two fixture
  files sharing a `<namespace>/<name>` (only one gets tested; the CLI logs a
  warning but still exits clean) and a selector that matches no loaded
  fixture (it silently broadens to every loaded resource instead of
  failing). The script fails CI on either, scoped per `Test` document (reuse
  of a `<namespace>/<name>` pair *across* documents is normal and common,
  not flagged). See the script's own header for how this was verified
  against the pinned CLI.
- `.github/workflows/e2e-tests.yaml` — the Chainsaw cluster tier.

The Kyverno CLI version, the kind node image, and the Kyverno Helm chart
version are kept in lockstep across those three files and with what the
estate actually runs; each pin carries a comment saying so.

`.github/workflows/release.yaml` runs release-please on pushes to `main`.
`.github/workflows/renovate.yaml` runs Renovate on a schedule.
`.pre-commit-config.yaml` mirrors the yamllint/markdownlint/shellcheck/
commitlint checks locally via `pre-commit run --all-files`; it does not
include the Kubernetes-manifest or Kyverno-CLI validation above, which are
CI-only.

One CI-fidelity gap worth knowing: the e2e kind cluster installs the Kyverno
chart with default values, whose `resourceFilters` exclude ReplicaSets from
every policy engine. Production overrides that in the apps repo's Kyverno
`HelmRelease`; the Chainsaw suite works around it with a per-test script
(`ci/policy-tests/chainsaw/scripts/allow-replicaset-cleanup.sh`). Aligning the
harness with production would be a fidelity improvement, not a correctness fix.
