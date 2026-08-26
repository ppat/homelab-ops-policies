# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Start here

- [README.md](./README.md) — the policy inventory, how a consumer wires this up,
  how it is released
- [DESIGN.md](./DESIGN.md) — why the repo is shaped this way: the group split,
  the two layers, the test tiers, the regression tally

Three files carry the house style and are cited by every other file rather than
having their contents copied. Read the relevant one before writing a new policy:

| Writing a… | Read first |
| --- | --- |
| `ValidatingPolicy` (any group) | `best-practices/restrict-node-port.yaml` |
| PSS mirror | `pod-security-standard/restricted/restrict-volume-types.yaml` |
| `DeletingPolicy` | `best-practices/cleanup-empty-replicasets.yaml` |
| exemption patch | `pod-security-standard/restricted/exemptions/restrict-volume-types.yaml` |
| CLI test | `ci/policy-tests/kyverno/best-practices/restrict-node-port/kyverno-test.yaml` |

## What this repo is (and isn't)

Kyverno policy YAML and its tests. No application code, no Flux wiring, no
cluster awareness — this repo does not know what consumes it, how many
consumers there are, or what they are called. If a task starts to require
knowing about a specific cluster, a specific `Kustomization`, or Flux state, it
belongs in the repo that wires this content up (currently
`homelab-ops-kubernetes-clusters`).

There is no `policies/` prefix directory: the whole repo *is* the policy
content.

## Two layers

Layer 1 is the policy file, carrying no estate content. Layer 2 is
`exemptions/<policy>.yaml` beside it — a JSON6902 patch appending to
`spec.matchConditions`, wired by a `patches:` entry in that directory's
`kustomization.yaml`. This applies repo-wide, to `best-practices` as much as to
the PSS groups.

Invariants:

- **Every exemption is a `matchConditions` append.** Not `namespaceSelector`,
  not `objectSelector`, not `excludeResourceRules`. Entries are ANDed and each
  states when the policy *applies*, so an exemption is written as a negation and
  an append can only ever narrow. One shape to review, one shape to test.
- **An exclusion is baked into a policy file only when it is universal — every
  consumer needs it — and the kind offers no append seam.** Exactly one does
  today: `cleanup-empty-replicasets`' `kube-system` `namespaceSelector`
  (`DeletingPolicy` has no `matchConditions`; its `spec.conditions` is not an
  appendable seam either). Everything else goes in Layer 2, including
  `kube-system` when it appears alongside estate-specific entries.
- **A policy that can carry exemptions declares `matchConditions: []` even with
  none.** A JSON6902 append onto `/spec/matchConditions/-` fails the kustomize
  build when the parent key is absent, so the empty list is the seam a future
  exemption needs. Policies deliberately kept exemption-free
  (`disallow-cri-sock-mount`, `disallow-latest-tag`, `restrict-node-port`)
  declare no seam, and each says why.
- **A patch whose `target:` matches nothing is a silent kustomize no-op.** The
  `version: v1` in a target tracks the apiVersion the policy file declares, and
  `kind:` must match — `best-practices/` holds three kinds behind one patch
  layer. What catches a mistyped target is the CLI tier, not the build.
- **Never a whole-list `add`/`replace` on `matchConditions`.** An append cannot
  drop a sibling entry; a whole-list write can, silently.

## Autogen

Every `ValidatingPolicy` and `MutatingPolicy` in this repo sets
`spec.autogen.podControllers.controllers: []` explicitly. Two reasons, and both
hold even where the field is inert:

- With autogen on, Kyverno rewrites `object.` to `object.spec.template.`
  throughout the policy **including `matchConditions`**, so a metadata-based
  exemption silently stops matching controller-created Pods.
- `kyverno test` simulates the autogen rewrite while the cluster's `mpol`
  webhook (measured) covers `pods` only, so a policy left on the default has the
  offline tier asserting a controller mutation the cluster never performs.

Accepted cost: under `[Deny]` a non-compliant pod controller is itself admitted
and only its Pods rejected.

`best-practices/restrict-node-port.yaml` is the one policy that omits the block,
because it matches Services; its file states this so the absence is not copied.
`spec.autogen` has no `enabled` field — `autogen: {enabled: false}` is pruned as
unknown and leaves autogen on.

Autogen is separate from **match scope**, which is a per-policy judgement about
whose violation the policy is reporting. `require-probes` matches Deployments,
DaemonSets and StatefulSets rather than Pods, deliberately accepting that a bare
Pod goes unflagged; every other Pod-shaped policy matches `pods`.

## Mutate policies

All three pin both switches off:

```yaml
evaluation:
  background:
    enabled: false
  mutateExisting:
    enabled: false
```

No mutation in this repo applies outside a live admission request. Both fields
already default to false, and both are written anyway — a mutate policy produces
no PolicyReport row, so a rewrite of an already-running object has nothing to
attribute it to and nothing to surface it. `add-emptydir-sizelimit.yaml` records
what that cost the estate once. `mutateExisting` does not exist on
`ValidatingPolicy`, so it is not carried over by copying a validate policy;
`background.enabled: true` on the validate policies is what populates
PolicyReports.

## CEL conventions

- Over a field the API defines as optional:
  `object.<path>.?<field>.orValue(<the API's own default>)`.
- The outermost operator of every expression must be a comparison, `!`, `&&`,
  `||`, or a bool-returning macro. Kyverno's compiler requires each expression to
  be statically bool: `object.spec` is unstructured, so
  `object.spec.?x.orValue(true)` types as `dyn` and is rejected at compile time
  even though it evaluates to a boolean. Comparing against the default satisfies
  both null-safety and static typing.
- `spec.variables` are not in scope inside `matchConditions` (compile error:
  undefined field). Exemption expressions inline everything; accept the
  repetition.
- Name matching concatenates `name` and `generateName`
  (`(object.metadata.?name.orValue('') + object.metadata.?generateName.orValue(''))`).
  Not for the usually-cited reason: the apiserver generates the name *before*
  admission, so live controller-created Pods carry both. The concatenation is
  there for shapes carrying only one, which is what `kyverno test` fixtures are.

## Keeping policies cluster-agnostic

Policy content must not assume which cluster, or how many clusters, apply it.

- **Enforcement mode is a point-of-use decision.** `validationActions` is
  `[Audit]` on every `ValidatingPolicy` here; a consumer wanting `[Deny]`
  patches it from its own `Kustomization`. Do not add cluster-flavoured variants
  of a policy to work around this.
- **An exclusion that only makes sense for one environment belongs in Layer 2**,
  where it can be moved consumer-side unchanged. See the invariants above for
  the line.

## Naming and layout

- `metadata.name` equals the file basename. `ci/scripts/build-policies.sh` names
  its split output after `metadata.name` — the only identifier surviving
  `kustomize build` — so a mismatch makes a test referencing
  `.build/<profile>/<basename>.yaml` find nothing rather than error.
- `spec` keys are written in the CRD's alphabetical order, so a pure file and
  the built output diff cleanly.
- Prose explaining *why* goes in YAML comments. The `policies.kyverno.io/*`
  annotations stay short and machine-shaped; they are upstream's catalogue
  metadata, not this repo's commentary.

## Testing

Two tiers, both run against `kustomize build` output via
`ci/scripts/build-policies.sh` (writes to the gitignored
`ci/policy-tests/.build/`).

| Tier | Path | Owns |
| --- | --- | --- |
| `kyverno test` | `ci/policy-tests/kyverno/<profile>/<policy>/` | Rule semantics and exemption expressions, per resource, offline |
| Chainsaw | `ci/policy-tests/chainsaw/<profile>/<policy>/` | Only what a live cluster adds: policy readiness, real admission under `[Deny]`, mutations landing on live objects, `DeletingPolicy` schedules firing |

A Chainsaw directory exists only where a cluster proves something the offline
tier cannot. A policy without one is covered by the CLI tier plus its profile's
`ready-smoke`; that is the steady state, not a gap.

Rules for the CLI tier:

- **An exemption-carrying policy needs two `Test` documents in one file**:
  `<policy>-built` against the built output and `<policy>-pure` against the
  policy file, same fixtures. Every exemption fixture is `skip` in the first and
  `fail` (or, for a mutate policy, `pass`) in the second. Either document alone
  is vacuous — the pure half is the only thing that catches a mistyped patch
  target, and the built half is the only thing that proves the exemption fires.
- **One firing fixture per exemption *member*, not per entry.** A namespace
  inside an `in [...]` list without its own fixture can be deleted and the suite
  stays green.
- **Fixture identity is `<namespace>/<name>`.** Two fixture files in one `Test`
  document sharing both collide silently and one stops being asserted. Reuse
  across directories is fine.
- **A selector matching nothing broadens rather than fails.** This tier cannot
  assert that a resource went unmatched: unasserted extras pass silently. Use
  `failOnMissingResources: true` on rows carrying `patchedResources`.
- **For a mutate policy, `result: pass` means only "a mutation was produced
  without error".** The assertion lives in `patchedResources`.

Local runs:

```bash
./ci/scripts/build-policies.sh
kyverno test ci/policy-tests/kyverno --detailed-results --remove-color
pre-commit run --all-files
```

The Kyverno CLI version (`policy-cli-tests.yaml`, `policy-smoke-check.yaml`),
the Kyverno chart version (`e2e-tests.yaml`) and the kind node image
(`ci/policy-tests/chainsaw/kind-config.yaml`) move in lockstep with what the
estate runs. CI that exercises a different engine than production tests the
wrong thing.

## CI

| Workflow | Runs |
| --- | --- |
| `lint.yaml` | commitlint, GitHub Actions linting, markdownlint, yamllint, `zizmor`, Renovate config validation, the full `pre-commit` set, and kubeconform-based manifest validation of both policy trees (`ci/validation/`) — gated on changed paths except `pre-commit`, which always runs |
| `policy-smoke-check.yaml` | Every policy, pure and built, against one unremarkable Pod: does it parse, pass Kyverno's CRD schema, and compile its CEL |
| `policy-cli-tests.yaml` | The `kyverno test` tier |
| `e2e-tests.yaml` | The Chainsaw tier on a kind cluster with the estate's pinned Kyverno chart |
| `release.yaml` | release-please, on pushes to `main` |
| `renovate.yaml` | Dependency-update PRs |

One workflow per concern, so a red check names what broke without anyone
opening it.

The smoke check never trusts an exit code. `kyverno apply` silently *drops* a
policy that fails Kyverno's CRD schema — it still prints its "Applying N policy
rule(s)" line and exits 0 — while a valid policy failing a rule against an
arbitrary resource exits non-zero for uninteresting reasons. The job asserts on
the reported rule count and on the absence of any `^Error:` line instead; that
second signal is what surfaces a CEL compile error.

## Commit conventions

Conventional Commits, enforced by commitlint. `commitlint.config.js` is the
source of truth for allowed types and scopes — read it rather than assuming a
sibling repo's scopes apply. The scope enum is a placeholder pending a dedicated
taxonomy design; nothing should be built on the current list.
