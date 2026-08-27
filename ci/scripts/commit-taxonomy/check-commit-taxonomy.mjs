#!/usr/bin/env node
// Entry point for the commit-taxonomy checks. One check per invocation so the workflow can run each
// as a named step: the whole set reports a single required status context, and the step name is the
// only thing that says which one went red.
//
//   check-commit-taxonomy.mjs <check> [--offline-presets DIR]
//   check-commit-taxonomy.mjs --list
//
// --offline-presets replaces the fetch of every ppat/renovate-presets file with a read from DIR.
// It is how a preset bump is rehearsed before it is taken: the empty scope's meaning depends on a
// Renovate config a bot can bump, and this is the only way to see what a candidate version does to
// emission without merging it. The self-test uses it to inject an upstream scope rename.

import { CHECKS, repoEnv } from './checks.mjs'

const args = process.argv.slice(2)
if (args.includes('--list')) {
  console.log(Object.keys(CHECKS).join('\n'))
  process.exit(0)
}

const name = args.find((a) => !a.startsWith('--'))
const offlineFlag = args.indexOf('--offline-presets')
if (!CHECKS[name]) {
  console.error(`unknown check '${name ?? ''}'; expected one of: ${Object.keys(CHECKS).join(', ')}`)
  process.exit(2)
}

const env = repoEnv(process.cwd(), { offlinePresets: offlineFlag === -1 ? null : args[offlineFlag + 1] })
const { fail, note } = await CHECKS[name](env)

for (const n of note) console.log(`  ${n}`)
if (fail.length) {
  console.error(`\n${name} FAILED:`)
  for (const f of fail) console.error(`  - ${f}`)
  process.exit(1)
}
console.log(`\n${name}: passed`)
