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

Conventional Commits, enforced by commitlint. `commitlint.config.js` holds the
enums; this section holds the rules for choosing between them. Don't import
scopes from another repo in this estate — this one is shaped by policy groups,
not clusters or modules.

### What the header is

Nothing in the release machinery routes on **scope**. This is a single
release-please package (`.`), so a release is sized by **type plus the breaking
marker**, and scope only *renders* — it becomes the bold prefix on a changelog
line. So a scope is a claim about the diff. Make it true; it steers nothing.

The one header that is operative is the **pull request title**. This repo is
squash-merge only, so a multi-commit PR lands exactly one commit on `main`
whose subject is the PR title. The individual commit subjects survive only
inside that commit's body, and release-please does not read them there.

- **Type the PR title for the whole PR's shipped impact**, not for its biggest
  commit. A PR titled `ci:` cuts no release however its commits are typed.
- A `BREAKING CHANGE:` footer **is** still read out of the squashed body, so a
  breaking footer can force a major bump under a tame-looking title. Keep the
  title and the footers agreeing in both directions.
- Interior commit headers are for humans reading `git log`. Commitlint still
  applies to them; the release does not.
- A single-commit PR lands its own commit header, so there the two coincide.

### Types

| Type | Use for | Changelog |
| --- | --- | --- |
| `feat` | shipped policy behaviour gained or widened | ✨ Features |
| `fix` | shipped policy behaviour corrected | 🚀 Enhancements + Bug Fixes |
| `perf`, `refactor` | shipped policy reworked, behaviour held | 🚀 Enhancements + Bug Fixes |
| `revert` | undoing a shipped change | ⚙️ Other |
| `docs`, `test`, `ci`, `build`, `style`, `chore` | anything a consumer never receives | hidden |

Only the visible types can cut a release: when every commit since the last tag
maps to a hidden section the rendered changelog is empty, and release-please
skips the release entirely. That is the intended behaviour — CI, tests, docs
and dependency bumps should not version the policy artifact.

Append `!` and a `BREAKING CHANGE:` footer when a change alters what a consumer
patches against by name — the kind, the `apiVersion`, or a policy's
`metadata.name`. A breaking change bumps **major** even below 1.0.0
(`bump-minor-pre-major: false`).

### Scopes

Ordered; **take the first row that matches**, and read `''` (no scope) as a
real answer rather than a fallback.

| # | Scope | The diff touches |
| --- | --- | --- |
| 1 | *(none)* | more than one of rows 2–4 — a cross-profile change |
| 2 | `best-practices` | `best-practices/` |
| 3 | `baseline` | `pod-security-standard/baseline/` |
| 4 | `restricted` | `pod-security-standard/restricted/` |
| 5 | `policy-tests` | `ci/` — either test tier, the build script, the kubeconform harness |
| 6 | `github-actions` | `.github/workflows/` |
| 7 | `repo-tooling` | the lint/release/commit/dependency scaffolding: `commitlint.config.js`, `release-please-config.json`, `.github/renovate.json`, `.pre-commit-config.yaml`, `.yamllint`, `.markdownlint-cli2.yaml` |
| 8 | *(none)* | nothing above — e.g. a docs-only change to `README.md`, `CLAUDE.md`, `DESIGN.md` |

Rows 2–4 are the **shipped** scopes: they name the three directories a consumer
can point a Flux `Kustomization.spec.path` at, which is what makes them worth
distinguishing at all. Rows 5–7 name real surfaces no consumer ever receives.

Two scopes are machine-emitted and exist only so the bot's commits pass lint —
never hand-write them: `internal-dependencies` (Renovate) and `release`
(release-please's own `pull-request-title-pattern`).

Rules that decide the cases the table alone doesn't:

- **A policy plus its tests takes the policy's scope.** That is what the
  ordering above buys: the shipped half is what a changelog reader cares
  about, and the fixtures ride along. Only a test-only diff is `policy-tests`.
- **Exemptions get no scope of their own.** An exemption patch lives inside a
  profile directory, so it takes that profile's scope; say "exemption" in the
  subject. A second name for a sub-shape of the same surface buys ambiguity,
  not precision.
- **Scope names what the diff touched, not the blast radius.** `restricted`
  lists `../baseline` as a resource, so a `baseline` change reaches restricted
  consumers too. Still scope it `baseline`.
- **Types that claim shipped behaviour changed** — `feat`, `fix`, `perf`,
  `refactor` — belong only on rows 1–4. A workflow or harness change is `ci`,
  `test` or `chore` however substantial it feels; typing it `feat` on an
  internal scope is what silently versions the artifact for a non-event. This
  is a convention, not a commitlint rule (see below).
- **Never hand-write a dependency bump as `feat` or `fix`.** Renovate is
  configured to emit `chore` for every update, because nothing this repo
  depends on is shipped; a hand-written `feat` would undo that.

### Gotchas

- `pre-commit run --all-files` does **not** run the commitlint hook — it is a
  `commit-msg`-stage hook, and `--all-files` never reaches that stage. Commit
  messages are checked by the `commit-messages` job in `lint.yaml`, and locally
  only by an actual `git commit`.
- Nothing lints the **pull request title**, which is the one string that sizes
  the release. Check it by hand before merging.
- The scope enum and `.github/renovate.json` are a matched pair. Renovate's
  scopes come from shared presets, so a preset bump can introduce a scope the
  enum rejects — which turns every affected update into a red PR that Renovate
  will not automerge, stalling updates quietly. `.github/renovate.json` claims
  the volatile scope locally to blunt this; when it changes, change the enum in
  the same commit.

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

The e2e kind cluster's `helm install kyverno` step sets `resourceFiltersExclude`
to the same three entries the real Kyverno `HelmRelease` does (apps repo,
infrastructure/subsystems/security-core/kyverno), so the chart's chart-default
`resourceFilters` — which otherwise exclude ReplicaSets from every policy
engine — matches production here too. `cleanup-empty-replicasets`' Chainsaw
test used to patch the `kyverno` ConfigMap itself to work around this (a
per-test script, reverted after); that workaround is gone now that the
cluster-level default already matches production.
