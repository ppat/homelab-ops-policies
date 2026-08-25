const { maxLineLength } = require('@commitlint/ensure');

// Renovate composes dependency-update commit bodies from templates that can emit
// lines longer than the limit humans are held to (grouped updates list one row per
// dependency, and release-note/config-warning blocks are not wrapped). Exempting
// those bodies keeps the length rule strict for prose without failing machine
// commits nobody can reflow.
//
// The predicate must match what Renovate ACTUALLY emits in this repo, or the
// exemption is dead code. Every Renovate commit here is `chore` (forced in
// .github/renovate.json, because nothing this repo depends on is shipped) carrying
// one of the two dependency scopes below. If either of those facts changes, this
// list changes with it.
const machineDependencyScopes = ['internal-dependencies', 'github-actions'];

const validateBodyMaxLengthIgnoringDeps = (parsedCommit) => {
  const { type, scope, body } = parsedCommit
  const isDepsCommit = type === 'chore' && machineDependencyScopes.includes(scope)

  const bodyMaxLineLength = 120;

  return [
    isDepsCommit || !body || maxLineLength(body, bodyMaxLineLength),
    `commit message body line length must not exceed ${bodyMaxLineLength}`,
  ]
}

module.exports = {
  extends: ['@commitlint/config-conventional'],
  plugins: ['commitlint-plugin-function-rules'],
  rules: {
    // increase max line length for header
    'header-max-length': [2, 'always', 120],

    // disable max line length for footers
    'footer-max-line-length': [0, 'always'],

    // disable default 'body-max-line-length' rule and add custom rule for body-max-line-length
    'body-max-line-length': [0],
    'function-rules/body-max-line-length': [
      2,
      'always',
      validateBodyMaxLengthIgnoringDeps
    ],

    // The closed set of scopes for this repo. Each one names a surface that
    // actually exists here; see CLAUDE.md "Commit conventions" for the
    // stop-at-first-match rule that picks between them, and for why a change
    // spanning more than one of them takes no scope at all.
    //
    // Two entries are emitted by machines and cannot be dropped without
    // breaking them: `github-actions` and `internal-dependencies` come from
    // Renovate (via the shared presets in .github/renovate.json), and `release`
    // comes from release-please's own `pull-request-title-pattern`.
    'scope-enum': [2, 'always',
      [
        // no scope: the change spans several scopes below, or fits none of them
        '',

        // shipped: the three policy directories a consumer can point a Flux
        // Kustomization.spec.path at, and which therefore are the artifact
        'best-practices',
        'baseline',
        'restricted',

        // internal: real surfaces here that no consumer ever receives
        'policy-tests',
        'github-actions',
        'repo-tooling',
        'internal-dependencies',

        // release-please's own release pull request
        'release'
      ]
    ],

    // don't validate case of body
    'body-case': [0, 'always']
  }
}
