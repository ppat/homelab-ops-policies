---
description: How to choose the type and scope of a commit in this repo — type is a release decision, scope is a claim about the diff that must be kept true.
---

# Commit types and scopes

The two header fields have different natures, and every rule below depends on the distinction:

> **Type is operative.** It sizes the version bump and decides whether a release happens at all.
>
> **Scope is operative in nothing.** Nothing branches on it. Its only job is to be true.

The type says what a consumer receives; the scope says which surface the diff touched. Both sets are
closed — `commitlint.config.js` is the source of truth for their membership, and adding a member is a
design change, not an improvisation.

Squash-merge lands a single-commit PR's **commit header** and a multi-commit PR's **PR title**. Keep a
PR to one commit; otherwise the title is the release-facing string and nothing here has checked it.

## Choosing a scope

### Step 0 — does the diff span more than one scope's footprint?

- **Yes → split it into one pull request per scope.** This is the default, and it is the point: the
  taxonomy shapes how work is broken up, not only how it is labelled.
- **Genuinely atomic — splitting would land something broken or meaningless → the empty scope**, with
  the subject naming what it spans. Rare by construction. If it stops being rare, the boundary is
  wrong and the two shipped scopes should merge; relaxing the norm is the wrong repair.
- **No → step 1.**

The empty scope is *chosen* here and reachable only here. Falling through the step 1 table yields
`internal`, never the empty scope — that is what stops it becoming a dumping ground.

### Step 1 — the table, in order, stopping at the first match

| # | Scope | The diff |
| --- | --- | --- |
| 1 | `release` | a release cut authored by release-please |
| 2 | `renovate` | this repo's Renovate configuration, and nothing else — including a shared-preset pin bump |
| 3 | `github-actions` | moves an action `uses:` ref, and nothing else |
| 4 | `internal-dependencies` | moves any other pinned tool, hook or image version, and nothing else |
| 5 | `policies-best-practices` | `best-practices/` and its own test directories |
| 6 | `policies-pod-security-standard` | `pod-security-standard/` and its own test directories |
| 7 | `internal-workflows` | this repo's own machinery: workflow logic, `ci/scripts/`, `ci/validation/`, the shared test harness under `ci/policy-tests/`, linter and commitlint configs, release-please config and manifest, toolchain manifests and lockfiles |
| 8 | `agents` | `CLAUDE.md`, `.claude/`, anything else written for an AI coding agent |
| 9 | `internal` | anything else: `README.md`, `DESIGN.md`, repo-root residue |

**Rows 5–9 partition the tracked tree.** Every tracked file falls in exactly one, so they cannot
compete: a single-footprint diff matches exactly one of them, and a multi-footprint diff never reaches
step 1. A file matching none of them is a defect in this table, not a licence to improvise.

**Only rows 1–4 are genuinely ordered**, because they are line-level rather than path-level: each says
"a version moved and nothing else did". A workflow edit that *also* re-pins an action fails row 3's
"and nothing else" and lands on row 7. Row 2 takes precedence over row 4 so that every change to the
Renovate config — bot bump or hand-edit — carries one greppable name, since those are the changes that
can move machine emission.

**A policy's own test directories ride with that policy's shipped scope.**
`ci/policy-tests/{kyverno,chainsaw}/best-practices/` is row 5;
`ci/policy-tests/{kyverno,chainsaw}/{baseline,restricted}/` is row 6. Only the shared harness is row 7.
Without this rule the split-by-scope norm would be unsatisfiable — every policy change touches
`ci/policy-tests/`.

**Rows 4 and 7 split on what the diff did to the lines, not on the kind of file.** A `rev:` bump in
`.pre-commit-config.yaml` with nothing else is `internal-dependencies`; hand-editing a rule in the same
file is `internal-workflows`. Linter configs and `commitlint.config.js` are CI rules, never
dependencies.

**Rows 5 and 6 are a path test, not a judgement test.** The shipped trees are whatever the `paths:`
filter in `.github/workflows/release.yaml` names — read the boundary there, never from a list here. A
change inside one fires the release workflow whatever the motivation was, so the scope claim is true;
the type carries whether a consumer received anything. That is why `ci(policies-best-practices):` is
coherent rather than contradictory.

**Row 1 is release-please's own cuts only.** A hand-edit to `release-please-config.json` or
`.release-please-manifest.json` is row 7. Keeping row 1 mechanically decidable is what lets a check
verify it.

**Row 8 is files written *for* an agent**, not documentation generally. `README.md` and `DESIGN.md` are
written for humans and are row 9, even though `CLAUDE.md` cites them. The test is the intended reader,
not the citation graph.

## Types

| Type | The diff | Changelog | Alone in a release window |
| --- | --- | --- | --- |
| `feat` | shipped policy behaviour gained or widened | ✨ Features | minor |
| `fix` | shipped policy behaviour corrected | 🚀 Enhancements + Bug Fixes | patch |
| `perf` | shipped policy reworked to evaluate cheaper, matching held | 🚀 Enhancements + Bug Fixes | patch |
| `refactor` | shipped policy reworked, behaviour held | 🚀 Enhancements + Bug Fixes | patch |
| `revert` | undoing a shipped change | ⚙️ Other | patch |
| `docs` | prose, YAML comments, agent instructions | 🛠 Improvements | patch |
| `test` | fixtures or suites in either test tier | 🛠 Improvements | patch |
| `chore` | anything else that keeps the repo working | 🧹 Miscellaneous | patch |
| `ci` | workflows, build and audit scripts, the chainsaw rig | hidden | no release |

`build` and `style` are not legal here. There is a build script, but it is test harness — `ci` or
`test`. Cosmetic edits to policy YAML are `docs`; `style` would cut a patch release for whitespace.

A breaking marker cuts a **major** and renders even for a hidden type, so it is a release decision
independent of the type it sits on.

## The pairing rule

**`feat`, `fix`, `perf`, `refactor`, `revert`, and any breaking marker, require a shipped scope or the
empty scope.** Those types render a consumer-facing line asserting the policy artifact changed, and
nothing outside the shipped trees can make that assertion true. Internal surfaces take `chore`, `ci`,
`docs` or `test`, with the word "fix" in the subject where it belongs.

The rule covers every breaking-marker spelling — `type!:`, a `BREAKING CHANGE:` footer, and
`BREAKING-CHANGE:` anywhere in the body — because the release layer honours all of them.

Consequence worth internalising: **a dependency update is always `chore`.** Nothing this repo depends
on reaches a consumer; every tracked pin is CI or test-harness machinery. A linter action moving is not
a feature of the policies.

**On the empty scope the pairing rule is only half the check.** commitlint sees the header and never
the diff, so it cannot tell a spanning diff that includes a shipped tree from one that spans only
internal surfaces. The standing obligation: a claim type or breaking marker on the empty scope must
touch at least one shipped path. An empty scope spanning only internal surfaces takes `chore`, `ci`,
`docs` or `test`.

## Cases that would otherwise be guessed

| Situation | Header |
| --- | --- |
| A policy, its exemption patch, its `kustomization.yaml` entry, and its fixtures | One shipped scope. The two-layer split and the 1:1 test rule are not scope boundaries. |
| A change to one tree whose only effect on the other is a cross-reference path inside a **comment** | **Two commits.** The comment fix is `docs` on the other tree's scope. This shape recurs, because exemption comments name files across trees — it looks like a span and is not. |
| A change genuinely spanning both trees that cannot be split | Empty scope, both trees named in the subject. |
| Policy work plus a `CLAUDE.md`, `README.md` or `DESIGN.md` update | **Two pull requests.** The doc change stands alone and lands cleanly. |
| A new policy that also needs a new **shared** chainsaw helper | **Two pull requests**, helper first as `ci(internal-workflows):`. |
| A doc change that is really a design change | Paths decide the scope; substance decides the type. If shipped behaviour changed it is not `docs`, whatever the file count says. |
| Comment-only edits inside policy YAML | `docs(<that tree's scope>):`. Scope true, type true. |
| Renovate and release-please headers | Leave them alone. They are asserted by this repo's own Renovate `packageRules` and by the release PR title pattern. |

## Gotchas

**Empty parentheses are not a scope.** `feat():` parses as *no scope*, so a header that looks scoped
would silently carry the empty scope's meaning — which here is a positive claim, not a default. Name a
scope or drop the parentheses.

**The gate and the release parser read different strings.** commitlint validates the header. The
release parser reads the whole commit message *and* the pull request body. Three consequences:

- a body paragraph beginning with a conventional-commit header after a blank line becomes its own
  release entry, so a `chore:`-headed commit can cut a minor or a major;
- a `Release-As:` footer overrides the computed version outright;
- a `BEGIN_COMMIT_OVERRIDE` block in the pull request body replaces the entire release-facing message.

None of these is visible to the header lint. They are properties of a pinned parser, so a release-tool
bump can widen the hole without turning anything red — that is the invariant to re-check when the pin
moves.

**Every legal type must have a `changelog-sections` entry in `release-please-config.json`.** A type
with no entry renders nothing, and a batch containing only that type cuts no release at all —
silently, with a green run. An entry for a type the enum rejects is dead config. Change the two
together, always.

**Only the shipped trees fire the release workflow.** An internal change accumulates nothing until a
later push touches `best-practices/` or `pod-security-standard/`; `workflow_dispatch` is the manual
escape.

**Machine emission is asserted locally, not inherited.** This repo's own Renovate `packageRules` must
remain the last setters of the commit type, scope and message prefix, and the effective default scope
must never be empty — the empty scope's meaning rests on no machine being able to emit one. A shared
preset must never decide a header here. That is the invariant to re-check after any preset pin moves,
not the preset's current contents.

**A gated check is a silent pass.** Anything enforcing a rule that needs the diff — the empty scope's
meaning, scope-versus-paths concordance — must be wired with no `paths:` filter, no `needs:` and no
broadening `if:`. A skipped job reports `skipped`, and `skipped` **satisfies** a required status check;
a check that never reports at all leaves every pull request permanently unmergeable.
