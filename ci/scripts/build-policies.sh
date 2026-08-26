#!/usr/bin/env bash
# Builds every profile directory through kustomize and splits the resulting multi-document
# stream into one file per resource under ci/policy-tests/.build/<profile>/<name>.yaml
# (gitignored -- see .gitignore).
#
# Why this exists: what a consumer of this repo actually applies is the *built* output of a
# profile directory -- pure policy files plus, once they exist, the exemptions/ kustomize
# patches -- never a raw policy file in isolation and never a raw patch file on its own (a
# patch alone isn't valid Kyverno YAML). Both test tiers (`kyverno test`/`kyverno apply` in
# structural-smoke-check, Chainsaw's `apply: file:`) need to exercise that same built output, so
# this script is the one place that logic lives rather than being duplicated inline in two CI
# jobs and by hand for local runs.
#
# Output files are named after each resource's `metadata.name`, not its source file's basename:
# `kustomize build` hands back only the built stream, never which source file a given resource
# came from. `metadata.name` is the one identifier that survives the build and is guaranteed
# stable and unique within a profile -- kustomize itself would refuse to build a profile with two
# resources sharing a name+kind -- so it's what test files should reference. Every policy in this
# repo currently keeps its name equal to its basename (best-practices/restrict-node-port.yaml
# states that as a house convention), so the two agree; this script never assumes they will.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
build_root="${repo_root}/ci/policy-tests/.build"

# profile name -> directory holding that profile's kustomization.yaml, relative to repo_root.
# restricted's kustomization.yaml lists ../baseline as a resource (README.md: "applying
# restricted also applies everything in baseline"), so restricted's built stream -- and
# therefore its split output -- naturally includes baseline's policies too. That's intentional:
# it's exactly what a consumer of restricted gets.
declare -A profile_dirs=(
  [baseline]="pod-security-standard/baseline"
  [restricted]="pod-security-standard/restricted"
  [best-practices]="best-practices"
)

rm -rf "${build_root}"

for profile in baseline restricted best-practices; do
  profile_dir="${repo_root}/${profile_dirs[${profile}]}"
  out_dir="${build_root}/${profile}"
  mkdir -p "${out_dir}"

  echo "::group::build-policies: ${profile} (${profile_dirs[${profile}]})"
  # -s/--split-exp writes one file per document in the stream, named by evaluating the given
  # expression against that document -- here, "<out_dir>/<metadata.name>.yaml". yq's default
  # split extension is .yml (not .yaml), so the extension is spelled out explicitly in the
  # expression rather than relying on a flag for it.
  kustomize build "${profile_dir}" \
    | yq --split-exp "\"${out_dir}/\" + .metadata.name + \".yaml\"" -
  echo "::endgroup::"
done

echo "Built policy output:"
find "${build_root}" -type f -name '*.yaml' | sort
