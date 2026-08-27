# homelab-ops-policies

Cluster-agnostic [Kyverno](https://kyverno.io/) policy definitions and their
tests. No Flux wiring, no cluster-specific configuration, no awareness of what
consumes it — this repo is released on its own and referenced by tag from
wherever it is applied, the same way
[`homelab-ops-kubernetes-apps`](https://github.com/ppat/homelab-ops-kubernetes-apps)
modules are referenced from the cluster-wiring repo.

Every policy here is one of the CEL-based `policies.kyverno.io/v1` kinds:
`ValidatingPolicy`, `MutatingPolicy` or `DeletingPolicy`. Kyverno's
`ClusterPolicy` and `ClusterCleanupPolicy` do not appear in this tree. That
matters to a consumer in exactly one place: a `Kustomization` patch selects its
target by kind, and a patch naming a kind nothing uses matches nothing *and
still builds green*.

## Groups

| Group | Path | Contents |
| --- | --- | --- |
| Pod Security Standards — Baseline | [`pod-security-standard/baseline`](./pod-security-standard/baseline) | 14 `ValidatingPolicy` |
| Pod Security Standards — Restricted | [`pod-security-standard/restricted`](./pod-security-standard/restricted) | 8 `ValidatingPolicy`, plus all of Baseline |
| Best Practices | [`best-practices`](./best-practices) | 4 `ValidatingPolicy`, 3 `MutatingPolicy`, 2 `DeletingPolicy` |

A consumer picks a profile by pointing at one directory. Restricted's
`kustomization.yaml` lists `../baseline` as a resource, so it composes Baseline
by inclusion — a Baseline fix reaches both profiles without being duplicated.
Both profiles ship because the estate subscribes to both; see
[DESIGN.md](./DESIGN.md) for why that is not just an unfinished migration to
Restricted.

## Pod Security Standards

These files mirror the Kubernetes
[Pod Security Standards](https://kubernetes.io/docs/concepts/security/pod-security-standards/)
as implemented in `pod-security-admission` — not as re-implemented by
`kyverno/policies`, which this repo repeatedly found to lag. Each file's
`PSS-SNAPSHOT` header line names the Kubernetes minor and PSS policy version it
is synced to, so a resync has a fixed diff point.
[`pod-security-standard/UPSTREAM-SNAPSHOT.md`](./pod-security-standard/UPSTREAM-SNAPSHOT.md)
is the dated record behind those lines — what upstream defined at that snapshot,
with the source for each claim — so a resync starts from what was last known
rather than from scratch.

A mirror file contains no estate content whatsoever. This estate's own
exemptions live beside it under `exemptions/` and are attached by kustomize; see
[Exemptions](#exemptions).

**Baseline:**

| Policy | Disallows |
| --- | --- |
| `disallow-capabilities` | Capabilities beyond the Baseline allow-list |
| `disallow-host-ipc` | `hostIPC` |
| `disallow-host-network` | `hostNetwork` |
| `disallow-host-path` | `hostPath` volumes |
| `disallow-host-pid` | `hostPID` |
| `disallow-host-ports` | `hostPort` |
| `disallow-host-probes-and-lifecycle` | A `host` field on any probe or lifecycle hook |
| `disallow-host-process` | Windows HostProcess containers |
| `disallow-privileged-containers` | `privileged: true` |
| `disallow-proc-mount` | Non-default `procMount` (relaxed for user-namespaced Pods) |
| `disallow-selinux` | `seLinuxOptions` outside the allowed set |
| `restrict-apparmor-profiles` | Non-default AppArmor profiles, on both the field and the deprecated annotation |
| `restrict-seccomp` | `seccompProfile.type: Unconfined` |
| `restrict-sysctls` | Sysctls outside PSS's safe list |

PSS's single `hostNamespaces` check is three files here, one per field, because
the three fields carry different exemption sets and `matchConditions` is
policy-wide.

**Restricted** adds, on top of all of the above:

| Policy | Disallows / requires |
| --- | --- |
| `disallow-capabilities-strict` | Adding any capability except `NET_BIND_SERVICE` |
| `disallow-privilege-escalation` | `allowPrivilegeEscalation: true` |
| `disallow-proc-mount-strict` | Non-default `procMount`, re-tightened for user-namespaced Pods |
| `require-drop-all` | `capabilities.drop` must contain `ALL` |
| `require-run-as-non-root-user` | `runAsUser: 0` |
| `require-run-as-nonroot` | `runAsNonRoot` unset or false |
| `restrict-seccomp-strict` | Any seccomp profile other than `RuntimeDefault`/`Localhost`, including none |
| `restrict-volume-types` | Volume types outside the Restricted allow-list |

PSS's `capabilities_restricted` check is split into `require-drop-all` and
`disallow-capabilities-strict` for the same policy-wide-`matchConditions`
reason: only the drop-`ALL` half carries an exemption.

## Best Practices

House rules, mirroring no external standard.

| Policy | Kind | What it does |
| --- | --- | --- |
| `disallow-cri-sock-mount` | Validate | Blocks mounting the container runtime socket |
| `disallow-latest-tag` | Validate | Requires an explicit, non-`latest` image tag on all three container lists |
| `require-probes` | Validate | Requires a liveness, readiness or startup probe on every container of a Deployment, DaemonSet or StatefulSet |
| `restrict-node-port` | Validate | Blocks `Service` type `NodePort` |
| `add-default-resources` | Mutate | Adds default CPU/memory requests to containers declaring no resources at all |
| `add-emptydir-sizelimit` | Mutate | Adds a `sizeLimit` to `emptyDir` volumes that have none |
| `add-ndots` | Mutate | Sets DNS `ndots: 1`, leaving a workload's own `ndots` alone |
| `cleanup-bare-pods` | Delete | Deletes controller-less Pods, daily |
| `cleanup-empty-replicasets` | Delete | Deletes empty ReplicaSets older than 24h, hourly |

`cleanup-empty-replicasets` deletes nothing unless the consuming cluster's
Kyverno values override the chart's default `resourceFilters`, which exclude
ReplicaSets from every Kyverno engine. The policy file carries the detail.

## Exemptions

Any policy with estate-specific exemptions is shipped as two files: the policy
itself, carrying none, and `exemptions/<policy>.yaml` beside it — a JSON6902
patch appending to `spec.matchConditions`, attached by a `patches:` entry in
that directory's `kustomization.yaml`. Both PSS groups and `best-practices` use
this shape.

```text
pod-security-standard/baseline/
├── disallow-host-path.yaml          # the rule, no estate content
├── exemptions/
│   └── disallow-host-path.yaml      # this estate's carve-outs, with rationale
└── kustomization.yaml               # resources: + patches:
```

Consequences for anyone reading or consuming this repo:

- **Apply the `kustomize build` output of a group directory, never a single
  file.** A file under `exemptions/` is a patch document, not a manifest; on its
  own it is not valid Kyverno YAML, and a policy file on its own is missing this
  estate's exemptions.
- **A policy file with no `exemptions/` sibling has no estate exemptions.** The
  one exclusion baked directly into a policy is
  `cleanup-empty-replicasets`' `kube-system` `namespaceSelector`, which every
  consumer needs and which its kind gives no append seam for.
- **Each exemption carries its own rationale** in the patch file: what the
  workload does, why no manifest change makes it compliant, what the exemption
  costs, and what would make it wrong. Read those rather than any summary.
- **Relocating an exemption to the consumer side is a file move.** The same
  patch content works verbatim from a consumer's own
  `Kustomization.spec.patches`.

## Consuming this repo

This repo produces no running system by itself. A consumer pins a released tag
and points at one of the group directories:

```yaml
apiVersion: source.toolkit.fluxcd.io/v1
kind: GitRepository
metadata:
  name: policy-best-practices
  namespace: flux-system
spec:
  interval: 1h
  ref:
    tag: v1.0.0 # x-release-please-version
  url: https://github.com/ppat/homelab-ops-policies.git
---
apiVersion: kustomize.toolkit.fluxcd.io/v1
kind: Kustomization
metadata:
  name: policy-best-practices
  namespace: flux-system
spec:
  interval: 1h
  path: ./best-practices
  prune: true
  sourceRef:
    kind: GitRepository
    name: policy-best-practices
    namespace: flux-system
```

Every `ValidatingPolicy` here ships `validationActions: [Audit]`. This repo does
not know whether a given consumer wants findings reported or admission blocked,
so a consumer wanting `[Deny]` patches the field from its own `Kustomization`
rather than this repo forking policy content per mode. `MutatingPolicy` and
`DeletingPolicy` have no such field: a mutation always applies and a deletion
always deletes.

## Versioning and releases

Releases are cut with
[release-please](https://github.com/googleapis/release-please) from
[Conventional Commits](https://www.conventionalcommits.org/), enforced on every
PR by commitlint — `commitlint.config.js` is the source of truth for allowed
types and scopes. Merging to `main` accumulates a release PR; merging that PR
tags a version for consumers to pin. The tag in the example above is rewritten
by release-please via its `# x-release-please-version` marker, so it always
names the latest release.
