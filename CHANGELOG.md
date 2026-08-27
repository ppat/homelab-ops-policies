# Changelog

## [1.0.0](https://github.com/ppat/homelab-ops-policies/compare/v0.0.1...v1.0.0) (2026-08-27)


### ⚠ BREAKING CHANGES

* the three policies are no longer `kyverno.io/v1 ClusterPolicy`. A consumer `Kustomization` patch selecting `kind: ClusterPolicy` no longer matches them and silently no-ops. Mutate policies carry no enforcement-mode field either way, so no mode override is lost, but a dead selector should be retired in the same coordinated cutover as the validate policies.
* both policies change apiVersion and kind, and `cleanup-bare-pods` changes `metadata.name` from `clean-bare-pods`. Consumer Kustomization patches targeting `kind: ClusterCleanupPolicy` now match nothing and silently no-op rather than failing, and PolicyReport entries keyed on the old name disappear in favour of the new one.
* a consumer patch selecting these policies by `kind: ClusterPolicy` now matches nothing, and enforcement mode is spelled `validationActions` (Audit/Deny) rather than `validationFailureAction` (Audit/Enforce). Two are renamed to equal their filenames -- `disallow-container-sock-mounts` to `disallow-cri-sock-mount`, `require-pod-probes` to `require-probes` -- so PolicyReport entries keyed on the old names disappear. `require-probes` no longer reports on bare Pods, ReplicaSets, ReplicationControllers, Jobs or CronJobs; workloads owned by the three matched controllers are unaffected. `disallow-cri-sock-mount` and `disallow-latest-tag` no longer generate a separate Deployment/DaemonSet-level PolicyReport entry for a non-compliant controller template; the Pod that controller creates is still evaluated and still reported on.
* a consumer patch selecting any of these policies by `kind: ClusterPolicy` now matches nothing, and enforcement mode is spelled `validationActions` (Audit/Deny) rather than `validationFailureAction` (Audit/Enforce). `disallow-capabilities-strict` no longer covers the drop-ALL requirement; select `require-drop-all` for that.
* a consumer patch selecting any of these policies by `kind: ClusterPolicy` now matches nothing, and enforcement mode is spelled `validationActions` (Audit/Deny) rather than `validationFailureAction` (Audit/Enforce). `disallow-host-namespaces` no longer exists as a policy name; select `disallow-host-network`, `disallow-host-pid` or `disallow-host-ipc` instead.
* a consumer patch selecting any of these six policies by kind: ClusterPolicy now matches nothing, and enforcement mode is spelled validationActions (Audit/Deny) rather than validationFailureAction (Audit/Enforce). Autogen stays off on every PSS mirror, because with it on Kyverno rewrites object. to object.spec.template. inside matchConditions as well, and metadata-scoped exemptions then stop matching controller-created Pods; the cost under Deny is that a non-compliant Deployment is admitted and only its Pods rejected.
* best-practices/restrict-node-port.yaml and pod-security-standard/restricted/restrict-volume-types.yaml are now `policies.kyverno.io/v1 ValidatingPolicy` rather than `kyverno.io/v1 ClusterPolicy`, and `restrict-nodeport` is renamed to `restrict-node-port`. A consumer patch targeting `kind: ClusterPolicy` silently matches nothing for these two, and their PolicyReport entries change name. Kyverno 1.17 or later is required.

### 🧹 Miscellaneous

* **internal-workflows:** close the commit type and scope enums and gate release-operative claims ([#28](https://github.com/ppat/homelab-ops-policies/issues/28)) ([b078b7b](https://github.com/ppat/homelab-ops-policies/commit/b078b7b2ae5025d7e997d7896af64b7bd64d50c7))
* **internal-workflows:** pin the commitlint toolchain locally rather than resolving it from another repo's default branch ([#30](https://github.com/ppat/homelab-ops-policies/issues/30)) ([cadaf4c](https://github.com/ppat/homelab-ops-policies/commit/cadaf4cc3f5a2f42097602e814491874ccad9575))
* **internal:** update .gitattributes to pin point repository content types ([#31](https://github.com/ppat/homelab-ops-policies/issues/31)) ([44864ed](https://github.com/ppat/homelab-ops-policies/commit/44864ed2dd9f9503e21e972509baba5122f85d81))
* **renovate:** claim a commit scope for updates that carry no package name ([#32](https://github.com/ppat/homelab-ops-policies/issues/32)) ([c83e67c](https://github.com/ppat/homelab-ops-policies/commit/c83e67c381100257c8302e5144214137336ef551))
* **renovate:** stop dependency updates claiming shipped behaviour and the empty scope ([#27](https://github.com/ppat/homelab-ops-policies/issues/27)) ([fe6f960](https://github.com/ppat/homelab-ops-policies/commit/fe6f96054253fbac9cd0fbb158f23b78d76c7541))


### 🛠 Improvements

* add namespace-boundary fixtures for three estate exemptions ([#23](https://github.com/ppat/homelab-ops-policies/issues/23)) ([b10add7](https://github.com/ppat/homelab-ops-policies/commit/b10add73c57aa0bcf62685292ac82dc10da29dee)), refs [#18](https://github.com/ppat/homelab-ops-policies/issues/18)
* **agents:** record that the pull request title is gated too ([#36](https://github.com/ppat/homelab-ops-policies/issues/36)) ([abb6d01](https://github.com/ppat/homelab-ops-policies/commit/abb6d01acc8d1f5c0fcedd1ec4bf11edc7c01db1))
* document the repo's final shape and close an exemption coverage gap ([#21](https://github.com/ppat/homelab-ops-policies/issues/21)) ([f90ba7c](https://github.com/ppat/homelab-ops-policies/commit/f90ba7cc422e1d3075e9fc7c41b3ddbed01e7554))
* extend the upstream PSS snapshot with the privileged profile and label modes, drop a closed delta, and link it from CLAUDE.md ([#42](https://github.com/ppat/homelab-ops-policies/issues/42)) ([fb405d4](https://github.com/ppat/homelab-ops-policies/commit/fb405d4b05e071442b577efa054f9a82e2232631))
* fix dangling relative paths in cross-reference comments ([#25](https://github.com/ppat/homelab-ops-policies/issues/25)) ([3ebb67a](https://github.com/ppat/homelab-ops-policies/commit/3ebb67ada0001a2bef94fd66efc9ad8d970d0dc9)), refs [#20](https://github.com/ppat/homelab-ops-policies/issues/20)
* **internal:** link the repo overview and design record to the upstream PSS snapshot ([#41](https://github.com/ppat/homelab-ops-policies/issues/41)) ([bb011d0](https://github.com/ppat/homelab-ops-policies/commit/bb011d0aadb4f6e69cd1ec69cce9d9fb476855c5))
* **policies-pod-security-standard:** record the upstream pod-security-admission snapshot the PSS mirrors are aligned to ([#40](https://github.com/ppat/homelab-ops-policies/issues/40)) ([5474a4f](https://github.com/ppat/homelab-ops-policies/commit/5474a4f7aa34128f24f3b757a97c81a95155afad))


### ✨ Features

* port restrict-node-port and restrict-volume-types to ValidatingPolicy ([#6](https://github.com/ppat/homelab-ops-policies/issues/6)) ([964452c](https://github.com/ppat/homelab-ops-policies/commit/964452c5454cac20b99af9440e97e162d402c84e))
* port six Pod Security Standards baseline policies to ValidatingPolicy ([#7](https://github.com/ppat/homelab-ops-policies/issues/7)) ([cb8ea75](https://github.com/ppat/homelab-ops-policies/commit/cb8ea75be3b1f4eee6f0a93de19a33c7f5f8d3a5))
* port the best-practices validate policies to ValidatingPolicy ([#8](https://github.com/ppat/homelab-ops-policies/issues/8)) ([7b65aa1](https://github.com/ppat/homelab-ops-policies/commit/7b65aa130fc9a78a5473dd4eb055b5f0fd949d86))
* port the cleanup policies to DeletingPolicy ([#10](https://github.com/ppat/homelab-ops-policies/issues/10)) ([e699110](https://github.com/ppat/homelab-ops-policies/commit/e6991104d4700ddfe03935e24fe483394e500235))
* port the mutate policies to MutatingPolicy ([#12](https://github.com/ppat/homelab-ops-policies/issues/12)) ([bfca88b](https://github.com/ppat/homelab-ops-policies/commit/bfca88bb403203067d20173e3d3b52bf42c66796))
* port the Pod Security Standards restricted profile to ValidatingPolicy ([#11](https://github.com/ppat/homelab-ops-policies/issues/11)) ([1d7ba89](https://github.com/ppat/homelab-ops-policies/commit/1d7ba8962cef3f263e4de13813567e6a8035a0f0))
* port the remaining Pod Security Standards baseline policies to ValidatingPolicy ([#9](https://github.com/ppat/homelab-ops-policies/issues/9)) ([2da31c7](https://github.com/ppat/homelab-ops-policies/commit/2da31c7d3ae44d3ade93fd78dad267824e41793b))


### 🚀 Enhancements + Bug Fixes

* deny pod-level hostProcess in disallow-host-process ([#22](https://github.com/ppat/homelab-ops-policies/issues/22)) ([d522d83](https://github.com/ppat/homelab-ops-policies/commit/d522d834d8001d48e131b435a5912edf2078def7)), refs [#17](https://github.com/ppat/homelab-ops-policies/issues/17)
* exempt Windows pods from require-drop-all, matching real PSS behavior ([#24](https://github.com/ppat/homelab-ops-policies/issues/24)) ([71a9295](https://github.com/ppat/homelab-ops-policies/commit/71a92954ad4fc97de7b3f2a64dcc16bec5098b9c))

## 0.0.1 (2026-08-24)


### 🧹 Miscellaneous

* initial commit ([b6ce633](https://github.com/ppat/homelab-ops-policies/commit/b6ce63324e10cf27ddf5d6ba45a9e7cc8ae8d0a3))


### ✨ Features

* establish v0.0.1 baseline policies repo split from homelab-ops-kubernetes-clusters ([#2](https://github.com/ppat/homelab-ops-policies/issues/2)) ([00429de](https://github.com/ppat/homelab-ops-policies/commit/00429ded503bee780f509a59017ce9dc582c36e4))


### 🚀 Enhancements + Bug Fixes

* **github-actions:** restore paths filter to release workflow with correct scope ([#3](https://github.com/ppat/homelab-ops-policies/issues/3)) ([b284703](https://github.com/ppat/homelab-ops-policies/commit/b284703d83c20322a7b7c3ec11d64821f59b8057))
