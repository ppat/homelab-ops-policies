#!/usr/bin/env node
// Falsification harness for the commit-taxonomy checks. Every defect found while deriving this
// repo's taxonomy is re-introduced here and the checks must catch it. Coverage that has never been
// falsified is not coverage, so when modelling is added, an injection is added with it.
//
// The harness proves each injection took effect before crediting a catch, and that is not
// ceremony. Injecting subtractively into a seed object handed to commitlint's loader is silently
// ineffective -- cosmiconfig still finds the on-disk config and merges the seed over it -- and the
// first attempt at this reported "defect not reproducible" for a defect that had never been
// injected. So: config defects are injected by overriding the readers a check calls, verified by
// requiring the same check to pass on the untouched tree first and to fail with the expected
// message after; rule defects are injected into a generated config file and verified by requiring
// commitlint to ACCEPT the message under the weakened config and REJECT it under the real one. An
// injection that leaves the verdict unchanged is reported as ineffective, never as a catch.
//
// Two falsifiers are deliberately NOT built, with the prior named, because a falsifier can enforce
// exactly the prior it should be catching:
//
//   - release-please's per-run "pullRequestTitlePattern miss the part of '${scope}'" warning.
//     `${scope}` there means the TARGET BRANCH. Treating it as a defect applies commit-scope
//     semantics to a branch-semantics field.
//   - the release workflow's `paths:` filter "delaying" releases. That filter IS the
//     shipped/internal boundary the whole taxonomy is anchored to.

import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CHECKS, internals, repoEnv } from './checks.mjs'

const root = process.cwd()
const SANDBOX = join(root, 'node_modules/.commit-taxonomy-self-test')
const base = () => repoEnv(root, { prCommits: 0, prBody: '' })

const commit = (message, paths) => ({ sha: 'deadbeefcafe0000', message, paths })
const withOverrides = (overrides) => repoEnv(root, { prCommits: 0, prBody: '', overrides })

// Reader overrides that swap one file's parsed content, leaving every other read intact.
const patchJson = (target, mutate) => {
  const b = base()
  return { json: (rel) => (rel === target ? mutate(structuredClone(b.json(rel))) : b.json(rel)) }
}
const patchYaml = (target, mutate) => {
  const b = base()
  return { yaml: (rel) => (rel === target ? mutate(structuredClone(b.yaml(rel))) : b.yaml(rel)) }
}
// Only `rules` is copied, and through JSON: the config also carries the local plugin's functions,
// which no structured clone can copy. Copying at all is what stops the injection leaking into later
// cases through the require cache.
const patchCommitlint = (mutate) => {
  const b = base()
  return { commitlint: () => { const c = b.commitlint(); return mutate({ ...c, rules: JSON.parse(JSON.stringify(c.rules)) }) } }
}

// A commitlint config that requires the real one and weakens exactly one rule. Written inside
// node_modules so that `extends: ['@commitlint/config-conventional']` still resolves, and passed
// with --config so nothing is discovered from disk behind it.
const weakenedConfig = (name, body) => {
  mkdirSync(SANDBOX, { recursive: true })
  const path = join(SANDBOX, `${name}.cjs`)
  writeFileSync(path, `const base = require(${JSON.stringify(join(root, 'commitlint.config.js'))})\n${body}\n`)
  return path
}

const HEADER_ONLY_BREAKING = weakenedConfig('breaking-header-only', `
// The upstream implementation this repo's rule was derived from: it regexes the header and never
// looks at parsedCommit.notes, so every footer spelling of a breaking change escapes it.
const headerOnly = (parsed) => {
  if (!/^\\w+(\\([^)]*\\))?!:/.test(parsed.header || '')) return [true]
  return [['', 'policies-best-practices', 'policies-pod-security-standard'].includes(parsed.scope || ''), 'header-only breaking check']
}
module.exports = {
  ...base,
  plugins: [{ rules: { ...base.plugins[0].rules, 'local/breaking-type-restriction': headerOnly } }],
}`)

const NO_EMPTY_PARENS_OFF = weakenedConfig('no-empty-parens-off', `
module.exports = { ...base, rules: { ...base.rules, 'local/no-empty-parens': [0] } }`)

// Offline copies of the extended presets, so a preset bump can be rehearsed before it is taken.
const offlinePresets = (mutate) => {
  const dir = join(SANDBOX, `presets-${Math.random().toString(36).slice(2)}`)
  mkdirSync(dir, { recursive: true })
  const b = base()
  const extendsList = b.json('.github/renovate.json').extends ?? []
  return (async () => {
    for (const ref of extendsList) {
      const m = ref.match(/^github>ppat\/renovate-presets(?::([\w-]+))?#(.+)$/)
      if (!m) continue
      const [, name = 'default', tag] = m
      const preset = JSON.parse(await b.fetchText(`https://raw.githubusercontent.com/ppat/renovate-presets/${tag}/${name}.json`))
      writeFileSync(join(dir, `${name}.json`), JSON.stringify(mutate(name, preset), null, 2))
    }
    return dir
  })()
}

// One more in-repo extends entry than the tree currently has, served from the readers rather than
// written to disk. The composed reading has to hold for any number of files under .github/renovate/,
// and asserting it only against however many exist today would stop being an assertion the first
// time that number moved.
const EXTRA_OWN_PATH = '.github/renovate/self-test-extra'
const EXTRA_OWN_REF = `github>ppat/homelab-ops-policies//${EXTRA_OWN_PATH}`
const withExtraOwnFile = (rules, place = (list) => [...list, EXTRA_OWN_REF]) => {
  const b = base()
  return {
    json: (rel) => {
      if (rel === `${EXTRA_OWN_PATH}.json`) return { packageRules: rules }
      if (rel !== '.github/renovate.json') return b.json(rel)
      const c = structuredClone(b.json(rel))
      c.extends = place(c.extends)
      return c
    },
  }
}

// Renames every scope an extended preset claims, which is what an upstream taxonomy change looks
// like from here.
const renameUpstreamScopes = (_name, preset) => {
  const walk = (node) => {
    if (Array.isArray(node)) return node.forEach(walk)
    if (!node || typeof node !== 'object') return
    for (const [key, value] of Object.entries(node)) {
      if (key === 'semanticCommitScope' && value) node[key] = `renamed-${value}`
      else walk(value)
    }
  }
  walk(preset)
  return preset
}

// --- the catalogue ---------------------------------------------------------------------------

const CASES = [
  {
    id: 'I1', check: 'closure', expect: /shipped-dependencies.*not in scope-enum/s,
    defect: 'emission claims a scope the enum rejects',
    overrides: patchJson('.github/renovate/scopes.json', (c) => { c.packageRules[0].semanticCommitScope = 'shipped-dependencies'; return c }),
  },
  {
    id: 'I2', reject: 'feat(github-actions): update actions/checkout (v7 -> v8)',
    accept: 'chore(github-actions): update actions/checkout (v7 -> v8)',
    defect: 'a linter action moving is typed as a feature, sizing a minor release of the policies',
  },
  {
    id: 'I3', check: 'self-consistency', expect: /'deps', which scope-enum rejects/,
    defect: 'commitlint.config.js reasons over a scope the enum rejects, so the predicate can never fire',
    overrides: (() => { const b = base(); return { commitlintSource: () => `${b.commitlintSource()}\nconst DEAD_SCOPES = ['deps']\n` } })(),
  },
  {
    id: 'I4', check: 'self-consistency', expect: /entry for type 'style', which type-enum rejects/,
    defect: 'the changelog grows a section for a type the enum rejects',
    overrides: patchJson('release-please-config.json', (c) => { c['changelog-sections'].push({ type: 'style', section: 'Style' }); return c }),
  },
  {
    id: 'I5', check: 'self-consistency', expect: /type 'style' is legal but has no changelog-sections entry/,
    defect: 'a type becomes legal with no changelog section, so a window holding only that type cuts no release',
    overrides: patchCommitlint((c) => { c.rules['type-enum'][2].push('style'); return c }),
  },
  {
    id: 'I6', check: 'message-shape', expect: /body paragraph is shaped like a conventional commit header/,
    defect: 'a body paragraph the release parser reads as a second commit',
    overrides: { commits: () => [commit('chore(internal-workflows): tidy\n\nfeat: add a policy nobody wrote\n', ['ci/scripts/x.sh'])] },
  },
  {
    id: 'I7', check: 'message-shape', expect: /Release-As: footer overrides the computed version/,
    defect: 'a Release-As: footer overriding the computed version',
    overrides: { commits: () => [commit('chore(internal-workflows): tidy\n\nRelease-As: 9.9.9\n', ['ci/scripts/x.sh'])] },
  },
  {
    id: 'I8', reject: 'chore(internal-dependencies)!: update pre-commit packages (major)',
    accept: 'chore(internal-dependencies): update pre-commit packages (major)',
    defect: 'a dependency major cutting a major release of the policy artifact',
  },
  {
    id: 'I9', reject: 'chore(internal-workflows): tidy\n\nsome prose\nBREAKING-CHANGE: everything\n',
    accept: 'chore(internal-workflows): tidy\n\nsome prose\n',
    defect: 'a mid-body breaking marker, which the release layer honours and a header lint cannot see',
  },
  {
    id: 'I10a', check: 'default-scope', expect: /falls through to the inherited empty scope|claimed by github>ppat\/renovate-presets/,
    defect: 'this repo stops asserting its own emission and inherits it',
    overrides: patchJson('.github/renovate/scopes.json', (c) => { c.packageRules = []; return c }),
  },
  {
    id: 'I10b', check: 'closure', expect: /resolves after this repo's own/,
    defect: 'the local rules moved ahead of the preset chain, where a preset resolves after them',
    overrides: patchJson('.github/renovate.json', (c) => { c.extends = [c.extends.at(-1), ...c.extends.slice(0, -1)]; return c }),
  },
  {
    id: 'I10c', check: 'closure', expect: /only a source's top-level extends is composed here/,
    defect: 'a preset extended from inside a packageRule, which Renovate resolves and this composition never reads',
    overrides: patchJson('.github/renovate.json', (c) => { c.packageRules = [{ matchManagers: ['bun'], extends: ['config:recommended'] }]; return c }),
  },
  {
    id: 'I11', check: 'named-scope', expect: /scope 'agents' does not cover/,
    defect: 'a named scope on a diff touching none of its footprint',
    overrides: { commits: () => [commit('docs(agents): describe the policy\n', ['best-practices/require-probes.yaml'])] },
  },
  {
    id: 'I12', check: 'empty-scope', expect: /spans more than one scope and could not be split, but every path is/,
    defect: 'the empty scope used as a fallback on a diff that does not span',
    overrides: { commits: () => [commit('chore: tidy up\n', ['ci/scripts/x.sh', 'ci/scripts/y.sh'])] },
  },
  {
    id: 'I13', check: 'default-scope', expect: /falls through to the inherited empty scope/,
    defect: 'the effective scope set back to empty, which is the prerequisite the empty scope\'s meaning rests on',
    overrides: patchJson('.github/renovate/scopes.json', (c) => {
      for (const rule of c.packageRules) delete rule.semanticCommitScope
      return c
    }),
  },
  {
    id: 'I14a', check: 'self-consistency', expect: /has a needs:/,
    defect: 'the job given a needs:, so an upstream failure makes it report skipped -- which satisfies the required context',
    overrides: patchYaml('.github/workflows/lint.yaml', (w) => { w.jobs['commit-taxonomy'].needs = ['detect-changes']; return w }),
  },
  {
    id: 'I14b', check: 'self-consistency', expect: /filters pull_request by paths/,
    defect: 'the workflow path-gated, so the required context can never clear on a pull request that misses the filter',
    overrides: patchYaml('.github/workflows/lint.yaml', (w) => { (w.on ??= {}).pull_request = { paths: ['ci/**'] }; return w }),
  },
  {
    id: 'I15', check: 'empty-scope', expect: /asserts the shipped policy artifact changed, but no path is under/,
    defect: 'a claim type on the empty scope over a diff that reaches no consumer',
    overrides: { commits: () => [commit('feat: rework the harness and the agent rules\n', ['ci/scripts/x.sh', 'CLAUDE.md'])] },
  },
  {
    id: 'I16a', check: 'self-consistency', expect: /fall in no scope footprint/,
    defect: 'a tracked file in no footprint, whose scope is therefore underivable',
    overrides: (() => { const b = base(); return { tracked: () => [...b.tracked(), 'LICENSE'] } })(),
  },
  {
    id: 'I16b', check: 'self-consistency', expect: /fall in more than one footprint/,
    defect: 'a tracked file in two footprints, whose scope is therefore ambiguous',
    mutateModule: () => {
      internals.FOOTPRINTS.push(['duplicate-of-internal', [/^README\.md$/]])
      return () => internals.FOOTPRINTS.pop()
    },
  },
  // I20-I22 came out of running the skill's Layer 1 attack against this checker: the header-shaped
  // keys were enumerated from Renovate's and release-please's own schemas rather than by hand, and
  // three sites turned up that the first version walked past.
  {
    id: 'I20', check: 'closure', expect: /semanticCommits resolves to 'disabled'/,
    defect: 'semantic commits switched off, so Renovate emits no type(scope) prefix at all',
    overrides: patchJson('.github/renovate.json', (c) => { c.semanticCommits = 'disabled'; return c }),
  },
  {
    id: 'I21', check: 'closure', expect: /'commitMessage'.*does not model it/,
    defect: 'a whole-message template, which replaces the prefix and bypasses every field modelled here',
    overrides: patchJson('.github/renovate.json', (c) => { c.commitMessage = '{{{commitMessageAction}}} {{{depName}}}'; return c }),
  },
  {
    id: 'I22', check: 'closure', expect: /group-pull-request-title-pattern renders/,
    defect: 'a release-please title pattern rendering a header the gate rejects',
    overrides: patchJson('release-please-config.json', (c) => { c['group-pull-request-title-pattern'] = 'release ${version}'; return c }),
  },
  {
    id: 'I17', reject: 'chore(internal-workflows): tidy\n\nBREAKING CHANGE: the policies moved\n',
    weakened: HEADER_ONLY_BREAKING,
    defect: 'the breaking-marker rule reverted to regexing the header only, which passes every footer spelling',
  },
  {
    id: 'I18', reject: 'feat(): rework everything',
    weakened: NO_EMPTY_PARENS_OFF,
    defect: 'the empty-parens rule removed, so a header that looks scoped silently carries the empty scope\'s claim',
  },
]

// --- runner ----------------------------------------------------------------------------------

const results = []
const record = (id, verdict, detail) => { results.push({ id, verdict, detail }); console.log(`  ${verdict.padEnd(11)} ${id}  ${detail}`) }

const run = async (name, env) => {
  try { return await CHECKS[name](env) } catch (e) { return { fail: [`threw: ${e.message}`], note: [] } }
}

console.log('baseline -- every check must pass on the untouched tree, or a catch below proves nothing')
for (const name of Object.keys(CHECKS)) {
  const { fail } = await run(name, base())
  if (fail.length) record(name, 'BASELINE-RED', fail.join(' / '))
  else console.log(`  ok          ${name}`)
}

console.log('\ninjections')
for (const c of CASES) {
  if (c.reject !== undefined) {
    const rejected = base().lint(c.reject)
    if (rejected.accepted) { record(c.id, 'NOT CAUGHT', `${c.defect}: commitlint accepted it`); continue }
    // Non-vacuity: the same message minus the defect, or the same message under a config with the
    // rule weakened, must be accepted. Otherwise the rejection proves nothing about this defect.
    const control = c.weakened ? base().lint(c.reject, c.weakened) : base().lint(c.accept)
    if (!control.accepted) { record(c.id, 'INEFFECTIVE', `${c.defect}: the control is rejected too, so the rejection is not attributable`); continue }
    record(c.id, 'caught', c.defect)
    continue
  }
  const restore = c.mutateModule?.()
  const before = await run(c.check, base())
  const injected = await run(c.check, c.overrides ? withOverrides(c.overrides) : base())
  restore?.()
  if (c.mutateModule) {
    // A module-level injection cannot be compared against an untouched baseline in the same
    // process, so effectiveness is proven by the message instead.
    if (injected.fail.some((f) => c.expect.test(f))) record(c.id, 'caught', c.defect)
    else record(c.id, 'NOT CAUGHT', `${c.defect}: ${c.check} reported ${injected.fail.join(' / ') || 'nothing'}`)
    continue
  }
  if (before.fail.length) { record(c.id, 'INCONCLUSIVE', `${c.defect}: ${c.check} was already red before injection`); continue }
  if (!injected.fail.length) { record(c.id, 'NOT CAUGHT', `${c.defect}: ${c.check} still passes, so the injection changed nothing the check reads`); continue }
  if (!injected.fail.some((f) => c.expect.test(f))) { record(c.id, 'WRONG CATCH', `${c.defect}: ${c.check} failed for another reason -- ${injected.fail.join(' / ')}`); continue }
  record(c.id, 'caught', c.defect)
}

// I19 -- the preset-bump rehearsal, guarded in both directions. The point is not that a rename is
// caught: after this repo claims its scopes locally and last, a rename must NOT move a header. So
// the guard is that the checks stay green under a renamed preset, and the falsifier is that they go
// red once the local claims are gone -- without which the guard would be satisfied by a check that
// reads nothing at all.
{
  const dir = await offlinePresets(renameUpstreamScopes)
  const renamed = repoEnv(root, { prCommits: 0, prBody: '', offlinePresets: dir })
  const guard = [...(await run('default-scope', renamed)).fail, ...(await run('closure', renamed)).fail]
  if (guard.length) record('I19-guard', 'NOT CAUGHT', `an upstream scope rename reaches this repo's headers: ${guard.join(' / ')}`)
  else record('I19-guard', 'held', 'an upstream scope rename moves no header here: neither the emittable set nor the claimed scope changes')

  const stripped = repoEnv(root, {
    prCommits: 0, prBody: '', offlinePresets: dir,
    overrides: patchJson('.github/renovate/scopes.json', (c) => { c.packageRules = []; return c }),
  })
  const falsifier = await run('default-scope', stripped)
  if (falsifier.fail.length) record('I19-falsifier', 'caught', 'with the local claims removed, the renamed preset decides the scope')
  else record('I19-falsifier', 'NOT CAUGHT', 'the guard above is vacuous: removing the local claims changed nothing')

  const unmodelled = await offlinePresets((name, preset) => {
    if (name === 'default') preset.packageRules[0].commitMessagePrefix = '{{depName}}-chore:'
    return preset
  })
  const refuse = await run('closure', repoEnv(root, { prCommits: 0, prBody: '', offlinePresets: unmodelled }))
  if (refuse.fail.some((f) => /cannot be checked/.test(f))) record('I19-refuse', 'caught', 'a preset bump introducing an unmodelled commitMessagePrefix is refused rather than assumed harmless')
  else record('I19-refuse', 'NOT CAUGHT', 'an unmodelled commitMessagePrefix passed silently')
}

// I23 -- the composed reading of several in-repo extends entries, guarded in both directions. An
// added file must change no verdict on its own, and each falsifier is a defect that a per-file
// reading cannot see: one puts a shared preset between two in-repo files, the other hides an
// unclassifiable matcher in the second of them.
{
  const benign = [{ matchManagers: ['bun'], semanticCommitScope: 'internal-dependencies' }]
  const added = withOverrides(withExtraOwnFile(benign))
  const guard = [...(await run('closure', added)).fail, ...(await run('default-scope', added)).fail]
  if (guard.length) record('I23-guard', 'NOT CAUGHT', `an added in-repo extends entry is not composed: ${guard.join(' / ')}`)
  else record('I23-guard', 'held', 'in-repo extends entries compose whatever their number and order')

  const interleaved = withOverrides(withExtraOwnFile(benign, (list) => {
    const own = list.filter((r) => r.startsWith('github>ppat/homelab-ops-policies//'))
    const foreign = list.filter((r) => !own.includes(r))
    return [...foreign.slice(0, -1), ...own, foreign.at(-1), EXTRA_OWN_REF]
  }))
  const order = await run('closure', interleaved)
  if (order.fail.some((f) => /resolves after this repo's own/.test(f))) record('I23-order', 'caught', 'a shared preset sitting between two in-repo files, where its packageRules accumulate last and win')
  else record('I23-order', 'NOT CAUGHT', `a preset resolving after an in-repo file passed: ${order.fail.join(' / ') || 'nothing reported'}`)

  const opaque = await run('closure', withOverrides(withExtraOwnFile([{ matchFileNames: ['**/*.json'], semanticCommitScope: 'internal-dependencies' }])))
  if (opaque.fail.some((f) => /uses matchFileNames/.test(f))) record('I23-matcher', 'caught', 'a matcher the coverage model cannot classify, in an in-repo file that is not the first one')
  else record('I23-matcher', 'NOT CAUGHT', `an unclassifiable matcher in a later in-repo file passed: ${opaque.fail.join(' / ') || 'nothing reported'}`)
}

rmSync(SANDBOX, { recursive: true, force: true })

const bad = results.filter((r) => r.verdict !== 'caught' && r.verdict !== 'held')
console.log(`\n${results.length - bad.length} of ${results.length} assertions held`)
if (bad.length) {
  console.error('\nself-test FAILED -- the checks below cannot be trusted:')
  for (const r of bad) console.error(`  - ${r.id} [${r.verdict}] ${r.detail}`)
  process.exit(1)
}
