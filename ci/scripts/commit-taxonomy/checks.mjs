// The checks behind the `commit-taxonomy` status context. Each is a named entry in CHECKS and runs
// as its own workflow step, so a red context names which one fired.
//
// WHAT THIS PROVES: that the configuration in this tree cannot compile a commit header
// commitlint.config.js would reject, and that headers already written in a pull request keep the
// claims the header fields are defined to make.
//
// WHAT IT DOES NOT PROVE: which packageRule wins for a given dependency. Renovate resolves that
// from repo state -- which files a manager finds, which of them share a branch -- and no static
// reading closes it. That half belongs to the commit-messages gate, which lints whatever the open
// mechanism actually produced.
//
// Every check refuses to guess: a config shape outside the modelled set below is a hard failure,
// never a skip. Silently ignoring what it does not understand is how a checker reports green over
// exactly the drift it exists to catch.
//
// The emittable set is derived from config text rather than from a Renovate dry-run trace, and that
// is not a shortcut: `internalChecksFilter: strict` deletes update branches whose release age has
// not elapsed, so whole classes of upgrade never reach a trace at all and a closure claim built on
// one is silently incomplete.

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'

// The release parser the message-shape patterns were derived against. A major bump can widen the
// body/footer hole without turning anything else red, so the pin is compared rather than trusted.
// A check input, not documentation.
const RELEASE_PLEASE_MAJOR = 17

// Renovate keys are classified rather than listed. HEADER_SHAPED is the shape of any key that could
// reach a commit header or a pull request title; a key of that shape in neither list below is a
// hard failure, so a preset bump introducing `commitMessage` or `prTitle` -- either of which
// replaces the whole prefix and bypasses everything modelled here -- cannot arrive unnoticed. A
// hand-listed set of keys is the same failure mode this file exists to catch, one level up.
const HEADER_SHAPED = /^(commit|semantic|prTitle)/
const HEADER_KEYS = ['semanticCommitType', 'semanticCommitScope', 'commitMessagePrefix']
const HEADER_SWITCHES = ['semanticCommits']
// Deliberately not modelled: each of these decides subject text or unrelated throttling, and no
// value of any of them can produce or suppress the type/scope prefix. commitBody and commitTrailers
// are absent on purpose -- either can put a breaking-change footer into the emitted message, which
// is release-operative and invisible to a header lint, so they are refused rather than ignored.
const SUBJECT_ONLY_KEYS = [
  'commitMessageAction', 'commitMessageExtra', 'commitMessageTopic', 'commitMessageSuffix',
  'commitMessageLowerCase', 'commitBodyTable', 'commitHourlyLimit', 'commitConcurrentLimit',
]

// Matchers this repo's own rules may use. The coverage reasoning below depends on knowing what each
// one narrows, so anything else is a hard failure rather than an assumption.
const MODELLED_LOCAL_MATCHERS = ['matchManagers', 'matchPackageNames', 'matchUpdateTypes']

// Managers with extraction occupancy in this tree. A matchManagers value outside this set is either
// a typo -- which renovate-config-validator accepts silently, leaving the rule a no-op -- or new
// occupancy the coverage model has not been taught. Both need a human. `bun` rather than `npm` is
// the load-bearing entry: bun declares supersedesManagers ["npm"], so package.json here is extracted
// by bun alone and a rule written for npm matches nothing.
const KNOWN_MANAGERS = ['bun', 'custom.regex', 'github-actions', 'pre-commit', 'renovate-config']

// Matchers that can only select an upgrade carrying a package name.
const PACKAGE_SCOPED_MATCHERS = [
  'matchPackageNames', 'matchDepNames', 'matchDepPatterns', 'matchPackagePatterns',
  'matchDepTypes', 'matchDatasources', 'matchSourceUrls', 'matchCategories',
  'matchCurrentVersion', 'matchCurrentValue', 'matchNewValue', 'matchCurrentAge',
]

// Renovate's package-name matcher returns false outright when an upgrade carries no package name,
// so a ["*"] glob -- which works at all only because the literal `*` is special-cased ahead of
// minimatch -- cannot reach a lockfile refresh. Every upgrade therefore falls in one of two classes
// whose scope has to be claimed separately.
const UPGRADE_CLASSES = [
  { id: 'carries a package name', hasPackage: true, updateType: null },
  { id: 'lockFileMaintenance, no package name', hasPackage: false, updateType: 'lockFileMaintenance' },
]

// Rows 5-9 of the scope table in .claude/rules/commits.md, as path predicates. They must partition
// the tracked tree: a file in none makes its scope undecidable, a file in two makes it ambiguous.
// Both are asserted by the self-consistency check rather than assumed.
const FOOTPRINTS = [
  ['policies-best-practices', [
    /^best-practices\//,
    /^ci\/policy-tests\/(kyverno|chainsaw)\/best-practices\//,
  ]],
  ['policies-pod-security-standard', [
    /^pod-security-standard\//,
    /^ci\/policy-tests\/(kyverno|chainsaw)\/(baseline|restricted)\//,
  ]],
  ['internal-workflows', [
    /^\.github\//, /^\.vscode\//,
    /^ci\/(?!policy-tests\/(kyverno|chainsaw)\/(best-practices|baseline|restricted)\/)/,
    /^(commitlint\.config\.js|package\.json|bun\.lock)$/,
    /^(release-please-config\.json|\.release-please-manifest\.json)$/,
    /^(\.yamllint|\.markdownlint-cli2\.yaml|\.shellcheckrc|\.pre-commit-config\.yaml)$/,
  ]],
  ['agents', [/^\.claude\//, /^CLAUDE\.md$/]],
  ['internal', [/^(README|DESIGN|CHANGELOG)\.md$/, /^\.git(ignore|attributes)$/]],
]

// Necessary path conditions for the scopes a diff can witness. Rows 1-4 of the scope table are
// line-level ("a version moved and nothing else did"), so only the half a path can testify to is
// here. internal-dependencies has no footprint of its own: a pin lives in the machinery it pins.
const SCOPE_PATH_CONDITIONS = {
  ...Object.fromEntries(FOOTPRINTS.map(([name, patterns]) => [name, patterns])),
  release: [/^(CHANGELOG\.md|README\.md|\.release-please-manifest\.json)$/],
  renovate: [/^\.github\/renovate(\.json|\/)/],
  'github-actions': [/^\.github\/workflows\//, /^actions\//],
  'internal-dependencies': FOOTPRINTS.find(([name]) => name === 'internal-workflows')[1],
}

const CLAIM_TYPES = ['feat', 'fix', 'perf', 'refactor', 'revert']
const HEADER_RE = /^(?<type>[a-zA-Z]+)(?:\((?<scope>[^)]*)\))?(?<bang>!)?: /

const memo = (fn) => { let v; let done = false; return (...a) => { if (!done) { v = fn(...a); done = true } return v } }

// Shared across every env in the process so the self-test's repeated runs fetch each preset once.
const FETCHED = new Map()

export const repoEnv = (root, opts = {}) => {
  const require = createRequire(join(root, 'package.json'))
  const text = (rel) => readFileSync(join(root, rel), 'utf8')
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' })
  return {
    root,
    offlinePresets: opts.offlinePresets ?? null,
    text,
    json: (rel) => JSON.parse(text(rel)),
    yaml: memoBy((rel) => parseYaml(text(rel))),
    commitlint: () => require(join(root, 'commitlint.config.js')),
    commitlintSource: () => text('commitlint.config.js'),
    // The gate's own binary, not a re-implementation of it: a checker that models acceptance
    // instead of invoking it can only ever agree with itself.
    lint: (message, configPath = join(root, 'commitlint.config.js')) => {
      try {
        execFileSync(join(root, 'node_modules/.bin/commitlint'), ['--config', configPath],
          { cwd: root, input: message, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })
        return { accepted: true, output: '' }
      } catch (e) {
        return { accepted: false, output: `${e.stdout ?? ''}${e.stderr ?? ''}`.trim() }
      }
    },
    tracked: memo(() => git('ls-files').trim().split('\n').filter(Boolean)),
    commits: memo(() => readCommits(git, opts)),
    prBody: () => opts.prBody ?? process.env.COMMIT_TAXONOMY_PR_BODY ?? '',
    fetchText: async (url) => {
      if (!FETCHED.has(url)) {
        const res = await fetch(url)
        if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`)
        FETCHED.set(url, await res.text())
      }
      return FETCHED.get(url)
    },
    ...(opts.overrides ?? {}),
  }
}

function memoBy(fn) {
  const cache = new Map()
  return (key) => { if (!cache.has(key)) cache.set(key, fn(key)); return cache.get(key) }
}

// The pull request's own commits, with headers and changed paths. Empty on any event that carries
// no pull request, which is what makes the pull-request-state checks no-ops on the schedule run
// rather than failures -- the repo-state checks are what that run is for.
function readCommits(git, opts) {
  const count = Number(opts.prCommits ?? process.env.COMMIT_TAXONOMY_PR_COMMITS ?? 0)
  if (!count) return []
  const shas = git('log', '--no-merges', '--format=%H', `HEAD~${count}..HEAD`).trim().split('\n').filter(Boolean)
  return shas.map((sha) => ({
    sha,
    message: git('log', '-1', '--format=%B', sha),
    paths: git('show', '--name-only', '--format=', sha).trim().split('\n').filter(Boolean),
  }))
}

const parseHeader = (message) => {
  const header = message.split('\n', 1)[0]
  const m = header.match(HEADER_RE)
  if (!m) return null
  return {
    header,
    type: m.groups.type,
    scope: m.groups.scope ?? '',
    breaking: Boolean(m.groups.bang) || /^BREAKING[ -]CHANGE:/m.test(message),
  }
}

const footprintOf = (path) => FOOTPRINTS.filter(([, pats]) => pats.some((p) => p.test(path))).map(([name]) => name)

const matchers = (rule) => Object.keys(rule).filter((k) => k.startsWith('match'))

// Whether a rule reaches every upgrade in a class, some of them, or none. "Some" is enough to
// narrow a scope but never enough to claim one for a whole class.
const reach = (rule, cls) => {
  const keys = matchers(rule)
  if (!keys.length) return 'all'
  if (!cls.hasPackage && keys.some((k) => PACKAGE_SCOPED_MATCHERS.includes(k))) return 'none'
  if (rule.matchUpdateTypes) {
    if (cls.updateType) {
      if (!rule.matchUpdateTypes.includes(cls.updateType)) return 'none'
      return keys.length === 1 ? 'all' : 'some'
    }
    return rule.matchUpdateTypes.every((t) => t === 'lockFileMaintenance') ? 'none' : 'some'
  }
  const universal = Array.isArray(rule.matchPackageNames)
    && rule.matchPackageNames.length === 1 && rule.matchPackageNames[0] === '*'
  const narrowing = keys.filter((k) => !(k === 'matchPackageNames' && universal))
  if (narrowing.length) return 'some'
  return cls.hasPackage ? 'all' : 'none'
}

// Every extends entry resolved to something readable, in resolution order, with this repo's
// self-reference read from the working tree. Renovate itself fetches that entry from the default
// branch -- which is why a Renovate dry-run silently validates main rather than an unpushed change,
// and why this file reads the tree instead.
const loadSources = async (env) => {
  const root = env.json('.github/renovate.json')
  const sources = [{ name: '.github/renovate.json', config: root, local: true }]
  const uncovered = []
  const entries = root.extends ?? []
  for (const [i, ref] of entries.entries()) {
    const shared = ref.match(/^github>ppat\/renovate-presets(?::([\w-]+))?#(.+)$/)
    const own = ref.match(/^github>ppat\/homelab-ops-policies\/\/(.+)$/)
    if (shared) {
      const [, name = 'default', tag] = shared
      const body = env.offlinePresets
        ? readFileSync(join(env.offlinePresets, `${name}.json`), 'utf8')
        : await env.fetchText(`https://raw.githubusercontent.com/ppat/renovate-presets/${tag}/${name}.json`)
      sources.push({ name: ref, config: JSON.parse(body), local: false })
    } else if (own) {
      sources.push({ name: ref, config: env.json(`${own[1]}.json`), local: true, isLastExtends: i === entries.length - 1 })
    } else {
      uncovered.push(ref)
    }
  }
  return { sources, uncovered }
}

const walkSites = (sources) => {
  const sites = []
  const walk = (node, ctx, path) => {
    if (Array.isArray(node)) return node.forEach((v, i) => walk(v, ctx, `${path}[${i}]`))
    if (!node || typeof node !== 'object') return
    const rule = matchers(node).length ? node : ctx.rule
    for (const [key, value] of Object.entries(node)) {
      if (HEADER_SHAPED.test(key)) sites.push({ ...ctx, rule, path: `${path}.${key}`, key, value })
      walk(value, { ...ctx, rule }, `${path}.${key}`)
    }
  }
  for (const { name, config, local } of sources) walk(config, { source: name, local, rule: null }, name)
  return sites
}

// A prefix built only from the semanticCommit* variables carries no literal of its own; what it
// renders is those values, collected separately. Anything else must be a whole literal header --
// or, if it is neither, it is refused rather than assumed harmless.
const HANDLEBARS = /\{\{#if [^}]*\}\}|\{\{\/if\}\}|\{\{\{?semanticCommit(?:Type|Scope)\}?\}\}/g
const LITERAL_HEADER = /^([a-z]+)(?:\(([^)]*)\))?(!)?:$/

const classifyPrefix = (value) => {
  if (/^[()!:\s]*$/.test(value.replace(HANDLEBARS, ''))) return { kind: 'template', breaking: value.includes('!') }
  const m = value.match(LITERAL_HEADER)
  if (m) return { kind: 'literal', type: m[1], scope: m[2] ?? '', breaking: Boolean(m[3]) }
  return { kind: 'unmodelled' }
}

const renderPrefix = (template, type, scope) => template
  .replace(/\{\{#if semanticCommitScope\}\}(.*?)\{\{\/if\}\}/g, (_, body) => (scope ? body : ''))
  .replace(/\{\{\{?semanticCommitType\}?\}\}/g, type)
  .replace(/\{\{\{?semanticCommitScope\}?\}\}/g, scope)

// Renovate's own default when no rule sets commitMessagePrefix.
const IMPLICIT_PREFIX = '{{semanticCommitType}}{{#if semanticCommitScope}}({{semanticCommitScope}}){{/if}}:'

// Increasing precedence for top-level keys: presets in the order they are extended, then this
// repo's own config, whose keys override every preset it pulls in. sources[0] is always the repo's
// own file, so the fold below reads it last.
const topLevelOrder = (sources) => [...sources.slice(1), sources[0]]

// Fold the header-carrying fields down to what a class of upgrade emits. Top-level values are the
// base; packageRules then apply in array order, later winning per field, with this repo's own rules
// last because the self-referenced preset is the last extends entry (asserted separately).
//
// `narrow` holds the scopes a rule that reaches only part of the class can still produce, keyed by
// matcher so a later rule with the same matcher replaces an earlier one. A rule reaching the whole
// class clears it: everything declared before it is overridden outright, which is the mechanism by
// which this repo's unconditional claim neutralises every preset rule above it.
const effective = (sources, cls) => {
  const out = { type: null, scope: null, prefix: null, scopeClaim: null, narrow: new Map() }
  for (const { name, config, local } of topLevelOrder(sources)) {
    if (config.semanticCommitType !== undefined) out.type = config.semanticCommitType
    if (config.semanticCommitScope !== undefined) { out.scope = config.semanticCommitScope; out.scopeClaim = { where: `${name} (top level)`, local } }
  }
  for (const { name, config, local } of sources) {
    for (const [i, rule] of (config.packageRules ?? []).entries()) {
      const r = reach(rule, cls)
      if (r === 'none') continue
      if (r === 'some') {
        if (rule.semanticCommitScope) out.narrow.set(JSON.stringify(matchers(rule).sort().map((k) => [k, rule[k]])), rule.semanticCommitScope)
        continue
      }
      if (rule.semanticCommitType !== undefined) out.type = rule.semanticCommitType
      if (rule.semanticCommitScope !== undefined) { out.scope = rule.semanticCommitScope; out.scopeClaim = { where: `${name} packageRules[${i}]`, local }; out.narrow.clear() }
      if (rule.commitMessagePrefix !== undefined) out.prefix = rule.commitMessagePrefix
    }
  }
  if (!out.scope) out.scopeClaim = null
  return out
}

// ---------------------------------------------------------------------------------------------

const closure = async (env) => {
  const fail = []
  const note = []
  const { sources, uncovered } = await loadSources(env)
  const sites = walkSites(sources)
  const rules = env.commitlint().rules
  const types = rules['type-enum'][2]
  const scopes = rules['scope-enum'][2]

  for (const site of sites) {
    const where = site.local ? fail : note
    const suffix = site.local ? '' : ' (upstream: emitted unless a local rule overrides it, asserted below)'
    if (!HEADER_KEYS.includes(site.key) && !HEADER_SWITCHES.includes(site.key)) {
      if (!SUBJECT_ONLY_KEYS.includes(site.key)) fail.push(`'${site.key}' at ${site.path} can reach a commit header or a pull request title and this check does not model it -- classify it before trusting anything below`)
      continue
    }
    if (site.key === 'semanticCommits' || typeof site.value !== 'string') continue
    if (site.key === 'semanticCommitType' && !types.includes(site.value)) where.push(`type '${site.value}' at ${site.path} is not in type-enum${suffix}`)
    if (site.key === 'semanticCommitScope' && !scopes.includes(site.value)) where.push(`scope '${site.value}' at ${site.path} is not in scope-enum${suffix}`)
    if (site.key !== 'commitMessagePrefix') continue
    const prefix = classifyPrefix(site.value)
    if (prefix.kind === 'unmodelled') {
      fail.push(`commitMessagePrefix '${site.value}' at ${site.path} is neither a semanticCommit* template nor a literal header -- cannot be checked`)
    } else if (prefix.kind === 'literal') {
      if (!types.includes(prefix.type)) where.push(`literal prefix at ${site.path} carries type '${prefix.type}', not in type-enum${suffix}`)
      if (!scopes.includes(prefix.scope)) where.push(`literal prefix at ${site.path} carries scope '${prefix.scope}', not in scope-enum${suffix}`)
    }
  }

  // The literal walk above only proves the vocabulary is clean. This is what proves the tree's own
  // rules are the ones that decide, so an upstream rename cannot reach a header here: deleting them,
  // moving the self-reference off the end of the extends chain, or widening a matcher past the
  // model all re-fail at this assertion.
  const local = sources.find((s) => s.local && s.isLastExtends !== undefined)
  if (!local) {
    fail.push('.github/renovate.json extends no preset of this repo\'s own, so this repo asserts nothing about what its bots emit')
    return { fail, note }
  }
  if (!local.isLastExtends) fail.push(`${local.name} is not the last extends entry, so a later preset's packageRules resolve after this repo's own and win`)
  for (const [i, rule] of (local.config.packageRules ?? []).entries()) {
    const unmodelled = matchers(rule).filter((k) => !MODELLED_LOCAL_MATCHERS.includes(k))
    if (unmodelled.length) fail.push(`local packageRules[${i}] uses ${unmodelled.join(', ')}; the coverage model does not model those matchers`)
    for (const manager of rule.matchManagers ?? []) {
      if (!KNOWN_MANAGERS.includes(manager)) fail.push(`local packageRules[${i}] matches manager '${manager}', which has no extraction occupancy here -- either a typo, which renovate-config-validator accepts silently, or occupancy this check has not been taught`)
    }
  }

  // Compose the header behind every scope this repo's rules claim and put each through commitlint.
  // Closure over the set of headers those rules can claim; NOT over which of them a given dependency
  // draws, which is repo state and belongs to the merge-time gate.
  const emittable = new Map()
  for (const cls of UPGRADE_CLASSES) {
    const eff = effective(sources, cls)
    for (const scope of new Set([eff.scope ?? '', ...eff.narrow.values()])) {
      emittable.set(renderPrefix(eff.prefix ?? IMPLICIT_PREFIX, eff.type ?? 'chore', scope), cls.id)
    }
  }
  // Both a normal subject and a degenerate one: an update carrying no version variables renders
  // commitMessageExtra's placeholders as empty, and a sibling repo emits exactly that shape today.
  for (const [prefix, clsId] of emittable) {
    for (const subject of ['update something (1.2.3 -> 1.2.4)', 'update lockfile bun ( -> )']) {
      const verdict = env.lint(`${prefix} ${subject}`)
      if (!verdict.accepted) fail.push(`'${prefix} ${subject}' is emittable for an upgrade that ${clsId}, and commitlint rejects it:\n${verdict.output}`)
    }
  }

  // Without semanticCommits enabled Renovate emits no type(scope) prefix at all, so every bot
  // header fails the gate at once. Resolved rather than read from one file: this repo sets none, so
  // the value comes from the preset chain and a bump can move it.
  const semanticCommits = topLevelOrder(sources).reduce((acc, s) => (s.config.semanticCommits ?? acc), undefined)
  if (semanticCommits !== 'enabled') fail.push(`semanticCommits resolves to '${semanticCommits ?? 'unset'}', not 'enabled': Renovate then emits no type(scope) prefix and every bot commit fails the gate`)

  // Scope-carrying sites outside Renovate: release-please composes its own pull request titles, and
  // with squash merges the title is what lands on main. Every title-pattern key the config declares
  // is linted, so a key this check has never seen is still covered.
  const releasePlease = env.json('release-please-config.json')
  const titleKeys = Object.keys(releasePlease).filter((k) => k.endsWith('title-pattern'))
  for (const key of titleKeys) {
    const rendered = releasePlease[key].replace(/\$\{[a-zA-Z]+\}/g, 'x')
    const verdict = env.lint(rendered)
    if (!verdict.accepted) fail.push(`release-please's ${key} renders '${rendered}', which commitlint rejects:\n${verdict.output}`)
    else note.push(`release-please ${key} renders: ${rendered}`)
  }

  note.push(`walked ${sites.length} header-shaped keys across ${sources.length} config sources; semanticCommits resolves to '${semanticCommits}'`)
  note.push(`emittable prefixes: ${[...emittable.keys()].join(' | ')}`)
  note.push(`extends entries not read, assumed to set no header field: ${uncovered.join(', ') || 'none'}`)
  return { fail, note }
}

// ---------------------------------------------------------------------------------------------

const defaultScope = async (env) => {
  const fail = []
  const note = []
  const { sources } = await loadSources(env)
  const lockfiles = env.tracked().filter((p) => /(^|\/)(bun\.lock|package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$/.test(p))

  for (const cls of UPGRADE_CLASSES) {
    if (!cls.hasPackage && !lockfiles.length) { note.push(`no lockfile tracked, so no upgrade can fall in the ${cls.id} class`); continue }
    const eff = effective(sources, cls)
    if (!eff.scopeClaim) {
      fail.push(
        `nothing claims a scope for every upgrade that ${cls.id}, so one falls through to the inherited empty scope. ` +
        'Here the empty scope is a positive claim -- "spans several scopes and could not be split" -- and it carries that ' +
        'meaning only while no machine can emit one. A bot header with an empty scope is in-enum, passes every other ' +
        'check, and is silently false.'
      )
    } else if (!eff.scopeClaim.local) {
      fail.push(
        `the scope for every upgrade that ${cls.id} is claimed by ${eff.scopeClaim.where}, a shared preset. ` +
        'A rename or a dropped rule there moves this repo\'s bot headers with no local commit and no review, and the ' +
        'fallback is the empty scope, which is in-enum and therefore silent. Restate the claim in this repo\'s own rules.'
      )
    } else {
      note.push(`${cls.id}: scope '${eff.scope}' claimed unconditionally by ${eff.scopeClaim.where}`)
    }
  }
  return { fail, note }
}

// ---------------------------------------------------------------------------------------------

const selfConsistency = async (env) => {
  const fail = []
  const note = []
  const rules = env.commitlint().rules
  const types = rules['type-enum'][2]
  const scopes = rules['scope-enum'][2]

  const sections = env.json('release-please-config.json')['changelog-sections'].map((s) => s.type)
  for (const t of types) if (!sections.includes(t)) fail.push(`type '${t}' is legal but has no changelog-sections entry: a release window holding only that type renders nothing and cuts no release, silently and green`)
  for (const t of sections) if (!types.includes(t)) fail.push(`changelog-sections has an entry for type '${t}', which type-enum rejects: dead config`)

  // The two lists commitlint.config.js reasons over. Read from source rather than from the module
  // because they are not exported; the naming convention is the seam, so a rename fails here rather
  // than quietly narrowing what gets checked.
  const consts = [...env.commitlintSource().matchAll(/const (\w+_(SCOPES|TYPES))\s*=\s*\[([^\]]*)\]/g)]
  if (!consts.length) fail.push('commitlint.config.js declares no *_SCOPES or *_TYPES list -- this cross-check has nothing to read and would pass vacuously')
  for (const [, name, kind, body] of consts) {
    const literals = [...body.matchAll(/'([^']*)'/g)].map((m) => m[1])
    const enumerated = kind === 'SCOPES' ? scopes : types
    for (const literal of literals) {
      if (!enumerated.includes(literal)) fail.push(`commitlint.config.js's ${name} names '${literal}', which ${kind === 'SCOPES' ? 'scope-enum' : 'type-enum'} rejects: a predicate that can never fire`)
    }
    note.push(`${name}: ${literals.map((l) => l || "''").join(', ')}`)
  }

  const orphans = []
  const overlaps = []
  for (const path of env.tracked()) {
    const hits = footprintOf(path)
    if (!hits.length) orphans.push(path)
    if (hits.length > 1) overlaps.push(`${path} -> ${hits.join(', ')}`)
  }
  if (orphans.length) fail.push(`${orphans.length} tracked file(s) fall in no scope footprint, so no scope is derivable for a diff touching them: ${orphans.slice(0, 10).join(', ')}`)
  if (overlaps.length) fail.push(`tracked file(s) fall in more than one footprint, so the derived scope is ambiguous: ${overlaps.slice(0, 10).join('; ')}`)
  if (!orphans.length && !overlaps.length) note.push(`the footprints partition all ${env.tracked().length} tracked files`)

  // This job's own wiring. A skipped job reports `skipped`, and `skipped` SATISFIES a required
  // status check; a job that never triggers never reports at all and leaves every pull request
  // permanently unmergeable with no in-band fix. Both make a required context enforce nothing while
  // looking enforced, and neither is visible in a green run -- so the shape is asserted from inside
  // the job it describes.
  const workflow = env.yaml('.github/workflows/lint.yaml')
  const on = workflow.on ?? workflow[true]
  const job = workflow.jobs?.['commit-taxonomy']
  if (!job) fail.push('lint.yaml has no commit-taxonomy job, but branch protection requires the context it reports')
  else {
    if (job.needs) fail.push('the commit-taxonomy job has a needs:, so an upstream failure makes it report skipped -- which satisfies the required context instead of blocking on it')
    if (job.if) fail.push('the commit-taxonomy job has an if:, so it can report skipped -- which satisfies the required context instead of blocking on it')
  }
  for (const trigger of ['pull_request', 'workflow_dispatch', 'schedule']) {
    if (!(trigger in (on ?? {}))) fail.push(`lint.yaml does not trigger on ${trigger}; the repo-state checks in this job go stale without it`)
  }
  if (on?.pull_request?.paths || on?.pull_request?.['paths-ignore']) fail.push('lint.yaml filters pull_request by paths, so this job does not report on every pull request and a required context waiting on it can never clear')
  return { fail, note }
}

// ---------------------------------------------------------------------------------------------

const messageShape = async (env) => {
  const fail = []
  const note = []
  const types = env.commitlint().rules['type-enum'][2]

  // release-please parses the whole message and splits it on blank lines: a paragraph shaped like a
  // conventional commit becomes its own release entry, so a chore-headed commit can cut a minor.
  // commitlint validates the header and sees none of it.
  const paragraph = new RegExp(`(?:^|\\n)[ \\t]*\\n(?:[a-z]+(?:\\([^)]*\\))?!:|(?:${types.join('|')})(?:\\([^)]*\\))?:)[ \\t]`)
  for (const commit of env.commits()) {
    const short = commit.sha.slice(0, 8)
    if (paragraph.test(commit.message)) fail.push(`${short}: a body paragraph is shaped like a conventional commit header, so the release parser reads it as a second commit and can size the release off it`)
    if (/^[ \t]*Release-As:[ \t]*\S/im.test(commit.message)) fail.push(`${short}: a Release-As: footer overrides the computed version outright`)
    if (commit.message.includes('BEGIN_COMMIT_OVERRIDE')) fail.push(`${short}: a BEGIN_COMMIT_OVERRIDE block replaces the release-facing message wholesale`)
  }
  // Only the override marker is checked in the pull request body. With squash_merge_commit_message
  // set to COMMIT_MESSAGES the body reaches the release parser through nothing else, and the
  // paragraph pattern would fire on any body quoting a commit header -- which the pull requests
  // maintaining this taxonomy do constantly.
  if (env.prBody().includes('BEGIN_COMMIT_OVERRIDE')) fail.push('the pull request body carries a BEGIN_COMMIT_OVERRIDE block, which replaces the release-facing message wholesale')

  const pinned = env.text('.github/workflows/release.yaml').match(/ppat\/github-workflows\/[^@]+@([0-9a-f]{40})/)
  if (!pinned) {
    fail.push('cannot find the pinned release workflow in release.yaml, so the parser behind the patterns above is unknown')
  } else {
    const remote = await env.fetchText(`https://raw.githubusercontent.com/ppat/github-workflows/${pinned[1]}/.github/workflows/release-please.yaml`)
    const version = remote.match(/RELEASE_PLEASE_VERSION:\s*"([^"]+)"/)
    if (!version) fail.push('the pinned release workflow declares no RELEASE_PLEASE_VERSION, so which parser the patterns above describe is unknown')
    else if (Number(version[1].split('.')[0]) !== RELEASE_PLEASE_MAJOR) fail.push(`the release parser is now ${version[1]}, past the ${RELEASE_PLEASE_MAJOR}.x the patterns above were derived from: re-derive them, then move RELEASE_PLEASE_MAJOR`)
    else note.push(`release parser ${version[1]} is within the ${RELEASE_PLEASE_MAJOR}.x the patterns were derived from`)
  }
  note.push(`${env.commits().length} commit(s) inspected`)
  return { fail, note }
}

// ---------------------------------------------------------------------------------------------

// The shipped trees, read from the release workflow's paths filter rather than listed here, so the
// boundary has exactly one definition. The bare-file entries in that filter are release machinery
// that re-triggers the workflow; the directory globs are the trees a consumer receives.
const shippedTrees = (env) => {
  const release = env.yaml('.github/workflows/release.yaml')
  const paths = (release.on ?? release[true])?.push?.paths ?? []
  const trees = paths.filter((p) => p.endsWith('/**')).map((p) => p.replace(/\/\*\*$/, ''))
  if (!trees.length) throw new Error('release.yaml\'s paths filter names no directory globs, so the shipped boundary cannot be read')
  return trees
}

const emptyScope = async (env) => {
  const fail = []
  const note = []
  const shipped = shippedTrees(env)
  for (const commit of env.commits()) {
    const parsed = parseHeader(commit.message)
    if (!parsed || parsed.scope !== '') continue
    const short = commit.sha.slice(0, 8)
    const spanned = [...new Set(commit.paths.flatMap(footprintOf))]
    if (spanned.length < 2) {
      fail.push(`${short}: the empty scope claims the diff spans more than one scope and could not be split, but every path is ${spanned[0] ?? 'unclassified'}. Falling through the scope table yields 'internal', never the empty scope.`)
    }
    if ((CLAIM_TYPES.includes(parsed.type) || parsed.breaking) && !commit.paths.some((p) => shipped.some((tree) => p.startsWith(`${tree}/`)))) {
      fail.push(`${short}: type '${parsed.type}'${parsed.breaking ? ' with a breaking marker' : ''} asserts the shipped policy artifact changed, but no path is under ${shipped.join(' or ')}. commitlint accepts this because it reads the header and never the diff.`)
    }
    note.push(`${short}: empty scope spans ${spanned.join(', ') || 'nothing classified'}`)
  }
  return { fail, note }
}

// ---------------------------------------------------------------------------------------------

// ADVISORY, with a sunset: review the fire log after 30 merged pull requests carrying named scopes.
// Promote to required if it has produced at least one true positive and no false positives; delete
// it if it is noise-only. A check left advisory indefinitely spends the audit attention it asks for
// and buys nothing.
const namedScope = async (env) => {
  const fail = []
  const note = []
  for (const commit of env.commits()) {
    const parsed = parseHeader(commit.message)
    if (!parsed || !parsed.scope) continue
    const short = commit.sha.slice(0, 8)
    const condition = SCOPE_PATH_CONDITIONS[parsed.scope]
    if (!condition) { note.push(`${short}: scope '${parsed.scope}' states no condition a diff can witness`); continue }
    const stray = commit.paths.filter((p) => !condition.some((re) => re.test(p)))
    if (stray.length) fail.push(`${short}: scope '${parsed.scope}' does not cover ${stray.slice(0, 5).join(', ')}${stray.length > 5 ? ` and ${stray.length - 5} more` : ''} -- split the change, or claim the empty scope if it is genuinely atomic`)
    else note.push(`${short}: scope '${parsed.scope}' covers all ${commit.paths.length} changed path(s)`)
  }
  return { fail, note }
}

export const CHECKS = {
  closure,
  'default-scope': defaultScope,
  'self-consistency': selfConsistency,
  'message-shape': messageShape,
  'empty-scope': emptyScope,
  'named-scope': namedScope,
}

export const internals = { FOOTPRINTS, UPGRADE_CLASSES, classifyPrefix, effective, footprintOf, parseHeader, reach, renderPrefix }
