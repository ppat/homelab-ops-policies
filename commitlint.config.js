// The header carries two fields of different natures: the type is release-operative and the
// scope is read by nothing. So a header can assert a release-worthy change on a diff that
// reaches no consumer, and the release notes will say so. The three local rules below exist to
// stop exactly that.

// Types that render a consumer-facing changelog line, i.e. that assert the shipped policy
// artifact changed.
const CLAIM_TYPES = ['feat', 'fix', 'perf', 'refactor', 'revert']

// The only scopes that can carry that assertion. The two policy trees are the ones the release
// workflow's `paths:` filter fires on -- read the boundary there, not from this list. The empty
// scope means "spans more than one scope and could not be split", which may include them;
// commitlint sees the header and never the diff, so nothing here can tell a true span from a
// lazy one.
const CLAIM_CARRYING_SCOPES = ['', 'policies-best-practices', 'policies-pod-security-standard']

const carriers = "'policies-best-practices', 'policies-pod-security-standard' or no scope"

const validateTypeScopePairing = (parsedCommit) => {
  const type = parsedCommit.type || ''
  const scope = parsedCommit.scope || ''
  if (!CLAIM_TYPES.includes(type)) {
    return [true]
  }
  return [
    CLAIM_CARRYING_SCOPES.includes(scope),
    `type '${type}' asserts that the shipped policy artifact changed and cannot sit on scope ` +
    `'${scope}', which reaches no consumer -- use ${carriers}, or type it chore/ci/docs/test.`,
  ]
}

// A breaking marker bumps major and renders in the changelog regardless of the type's `hidden`
// flag, so it asserts as much as a claim type does and takes the same scopes.
//
// It must be read from BOTH the raw header and `parsedCommit.notes`: the parser exposes the '!'
// only in the header text, and the `BREAKING CHANGE:` / `BREAKING-CHANGE:` spellings only in
// `notes`. A header-only regex was measured to pass every footer spelling. Do not collapse this
// back to a single test.
const validateBreakingTypeRestriction = (parsedCommit) => {
  const hasBang = /^\w+(\([^)]*\))?!:/.test(parsedCommit.header || '')
  const hasNote = (parsedCommit.notes || []).length > 0
  if (!hasBang && !hasNote) {
    return [true]
  }
  const scope = parsedCommit.scope || ''
  return [
    CLAIM_CARRYING_SCOPES.includes(scope),
    `a breaking marker cuts a major release and renders even for a hidden type, so it cannot ` +
    `sit on scope '${scope}', which reaches no consumer -- use ${carriers}.`,
  ]
}

// '()' parses as NO scope rather than as an invalid one, so `scope-enum` accepts it: '' is a
// member. Here the empty scope is a positive claim -- "this change genuinely spans more than one
// scope and could not be split" -- so a header that looks scoped would silently carry it. Only a
// raw-header test can see the parentheses at all.
const validateNoEmptyParens = (parsedCommit) => [
  !/^\w+\(\s*\)!?:/.test(parsedCommit.header || ''),
  `'()' is not a scope: it parses as no scope, which here claims the change spans more than one ` +
  `scope and could not be split -- name a scope or drop the parentheses.`,
]

module.exports = {
  extends: ['@commitlint/config-conventional'],
  plugins: [
    {
      rules: {
        'local/type-scope-pairing': validateTypeScopePairing,
        'local/breaking-type-restriction': validateBreakingTypeRestriction,
        'local/no-empty-parens': validateNoEmptyParens,
      },
    },
  ],
  rules: {
    // 140, not the estate's 120: the longest scope name here is 30 characters and the repo's
    // subject style runs to ~100, a combination measured to overflow 120 on a real header.
    'header-max-length': [2, 'always', 140],

    // disable max line length for footers
    'footer-max-line-length': [0, 'always'],

    // Disabled outright rather than exempted: Renovate pastes upstream release notes into the
    // body and `squash_merge_commit_message: COMMIT_MESSAGES` lands those markdown tables in the
    // commit body, where they cannot be rewrapped.
    'body-max-line-length': [0],

    // This set must EQUAL the key set of `changelog-sections` in release-please-config.json.
    // A type with no section renders nothing, so a batch containing only that type cuts no
    // release at all -- silently, with a green run. A section for a type this list rejects is
    // dead config. Change the two together, always.
    //
    // 'build' and 'style' are excluded. The build here (`ci/scripts/build-policies.sh`) is test
    // harness, so `build` would be the wrong-but-tempting answer for a `ci`/`test` change, and
    // it is hidden, so the miss would be silent. Cosmetic edits to policy YAML are `docs`;
    // `style` would cut a patch release for whitespace.
    'type-enum': [2, 'always',
      ['chore', 'ci', 'docs', 'feat', 'fix', 'perf', 'refactor', 'revert', 'test']
    ],

    // 'internal-dependencies' vs 'internal-workflows' splits on whether a version number moved,
    // not on the kind of file: a `rev:` bump in .pre-commit-config.yaml is a dependency, a
    // hand-edited rule in the same file is CI machinery. 'agents' is files written *for* an AI
    // coding agent, which is why README.md and DESIGN.md are 'internal' instead.
    //
    // The empty scope is a positive claim -- "spans more than one scope and could not be
    // split" -- never a fallback. It holds that meaning only while no machine can emit it,
    // which is what this repo's own Renovate packageRules are there to guarantee.
    'scope-enum': [2, 'always',
      [
        '',
        'agents',
        'github-actions',
        'internal',
        'internal-dependencies',
        'internal-workflows',
        'policies-best-practices',
        'policies-pod-security-standard',
        'release',
        'renovate'
      ]
    ],

    'local/type-scope-pairing': [2, 'always'],
    'local/breaking-type-restriction': [2, 'always'],
    'local/no-empty-parens': [2, 'always'],

    // don't validate case of body
    'body-case': [0, 'always']
  }
}
