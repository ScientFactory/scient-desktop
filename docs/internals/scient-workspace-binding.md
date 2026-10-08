# Scient workspace authority and agent capabilities

Status: Current implementation; release and runtime qualification are separate.
Owner: Yaacov
Last updated: 2026-10-06
Doc type: Current implementation

This document owns the shared capability admission and workspace-authority
boundary. It does not accept the wider proposed agent/plugin architecture.
Keep it aligned with the operation catalog, provider delivery, workspace
resolver, and document publication behavior.

## Scope

The foundation reuses existing Browser, Sources, Skills, and Documents tools.
It adds shared discovery/admission, provider-independent invocation context,
bounded Skill orientation, explicit Skill-selection metadata, and verified
workspace receipts for project operations. Existing domain services still
perform the work.

The shared boundary is wired to merged orchestration V2 and the existing domain services.
Compute's MCP tool exposes read-only runtime inventory through its existing gateway; a listed
runtime path is not authority to install, execute or attach to a runtime or project session.
This wiring does not migrate scientific history or qualify Compute execution/session behavior.
Earlier combined experiments remain separate Git/state recovery material, not supported inputs.

## Ownership

| Boundary                                                        | Owner                                                                    |
| --------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Pure operation metadata and workspace receipt schemas           | `packages/scient-operations`                                             |
| Existing tool definitions and schemas                           | `apps/server/src/mcp/toolkits`                                           |
| Catalog derived from those definitions                          | `mcp/ScientOperationCatalog.ts`                                          |
| Shared dispatch and domain invocation context                   | `scient/operations`                                                      |
| MCP registration, grant projection, discovery middleware        | `mcp/McpHttpServer.ts`, `ScientMcpInvocation.ts`, `ScientMcpProtocol.ts` |
| Host projection, filesystem/VCS evidence and persisted bindings | `scient/projectScope`                                                    |
| Document staging and publication fences                         | `mcp/toolkits/documents`                                                 |

Paths in the table that omit an application prefix are under
`apps/server/src`. The shared package contains no transport, provider SDK,
server service, credential store, or plugin runtime.

## Tools, guidance, and delivery

Tool definitions remain the source of their input/output/error schemas,
descriptions and effect hints. An annotation adds stable operation identity,
family, scope, required grants and a documentation owner. Catalog composition
rejects duplicate identities and unknown/replacement tool definitions.

The host composes handlers once. A caller supplies the registered tool name
and input; it cannot replace the handler per request. Admission checks the
current invocation grants and required scope before the existing handler runs.
Skills are instructions, not authority or a way to manufacture missing tools.

MCP projects its authenticated context into `AgentInvocationContext`.
The projection explicitly recognizes Scient grants; adding a host capability
does not silently authorize a Scient operation. First-party callers can use
the same dispatcher with a host-issued native session identity, without
inventing external-provider credentials. A fixture proves that path with a
real registered Skill handler; it is not a native-agent runtime.

One request-local `tools/list` middleware filters Scient tools using the same
admission rules as calls. A previously returned list is not a grant. Device and
Pull Request tools remain explicitly declared host-owned tools with their own
handlers and policy. Unknown ownership is a composition error, not an implicit
grant. Browser snapshot registration preserves the existing image-plus-metadata
response rather than turning images into JSON text.

Effect continues to own the dated MCP wire schemas, transport, parameter
validation and result encoding. The discovery adapter must be checked whenever
Effect or the host tool composition changes. There is no second protocol engine.

Provider adapters retain their supported delivery mechanisms and exact tool-name
projection. No prompt rewriting, provider-native skill-file copying, or persistent
configuration workaround is added for unsupported providers. See
[Skills](./scient-skills.md) for the delivery matrix and turn-local release
allowlist. Adapter capability declares whether the exact configured runtime can
receive the host-issued session MCP; externally managed OpenCode servers fail
closed instead of receiving Skill guidance for tools Scient did not attach.

Automatic Skill entry lines are bounded to 2,800 UTF-8 bytes. Omitted entries
remain discoverable through paginated/searchable `scient_skills_list`; selected
entries are not truncated. Full instructions load on demand. Tool schemas
themselves are still eagerly advertised: this is not lazy discovery of hundreds
of tools, and the synthetic Skill-scale fixture does not prove model task quality.

Explicit selections travel as `selectedScientSkillNames` from raw composer
intent through commands/events, queue delivery, and provider preparation.
Captured text, context labels, attachments and assistant plans are not selection
authority. The final input bound may omit automatic index entries, but rejects
oversized requests rather than silently dropping selected context. See
[queue draft/context ownership](./scient-thread-queue.md#composer-draft-compatibility-and-recovery).

## Workspace authority

Three identities have distinct roles:

- The host project/thread projection selects a workspace in one environment.
- `.scient/project.json` provides portable logical lineage, not access authority.
- A `WorkspaceBinding` identifies an exact server-observed physical root.

[`WorkspaceAuthorityProjection`](../../apps/server/src/scient/projectScope/WorkspaceAuthorityProjection.ts)
reads the native V2 thread/project projection and its committed, authority-specific revision.
Unstamped pre-cutover rows fail closed. The resolver canonicalizes the selected root and observes
optional filesystem identity, Scient identity, normalized repository identity and VCS worktree
evidence. This inspection does not create or edit project files. Plain folders are supported;
Git probe failures are not silently interpreted as proof of a non-repository.

An alternate worktree must prove shared repository metadata with the owning
project. A copied UUID, matching remote, or arbitrary existing path is not that
proof. A project registered at a repository subdirectory does not grant the
entire alternate checkout. Registered-root helpers also distinguish canonical
aliases from conflicting project claims; they are not model-facing cwd tools.

The binding store tracks verification, revocation, replacement and monotonically
increasing authority generation. Renaming a remote without changing its normalized
target does not replace the binding. Physical-root replacement does. Re-adding a
root can reassociate it only after the former host registration becomes inactive.
Filesystem evidence is a boundary check, not an atomic OS snapshot.

A protected operation captures binding ID, authority generation and projection
scope revision. Later checks re-resolve that same authority; they do not silently
switch to the thread's new workspace. The narrow projection revision excludes
unrelated title/model updates but detects an A-to-B-to-A root change.

The existing environment Files RPC has a different contract: it contains paths
inside a supplied root but does not prove the root belongs to the active thread.
Do not expose its model-supplied cwd as agent workspace authority.

### Scratch conversations

The upstream alignment through `5cc99e1c23` enables **No project** after owner approval.
These conversations still have a real owning project: the server's internal scratch
project at `<baseDir>/scratch` in production. The dev runner selects a separate
persistent scratch root outside the checkout; advertisement and authority use the
same configured location. Each thread records its own plain subfolder in
`worktreePath`; this does not reintroduce historical null-project Quick Chat threads.

The shared resolver admits only a host-registered direct canonical child of this
server's scratch root, with verified plain-folder evidence for both roots. It rejects
the shared parent as a thread scope, nested descendants, Git-inherited directories,
and symlinks escaping the canonical data directory or scratch root. Ordinary projects
retain the existing Git worktree lineage checks. Binding IDs, filesystem identities,
authority generations, and projection revisions remain the publication fences for
Sources, Documents, and Compute; consumers need no scratch-specific adapters.

## Domain effects and persistence

Sources and Documents consume the captured workspace instead of repeatedly
choosing a root inside handlers. Sources keeps its existing revision/CAS rules;
in-flight work remains pinned to the admitted root. Documents revalidate before
queued work/publication and preserve project-relative output containment,
staging, atomic replacement and truthful partial-publication outcomes.
The dispatcher is not a universal transaction, approval or filesystem framework.

Scient migration 11 remains the main thread-queue migration. Migration 12 adds
app-private workspace bindings; migration 13 adds optional filesystem identity.
Current migration 14 is `context-transfers`, not the earlier experimental Analysis migration.
The migration ledger rejects unknown or mismatched entries rather than interpreting a foreign
experimental database as a supported downgrade. Use fresh isolated state for qualification;
do not reuse the earlier combined candidate's database containing that Analysis migration 14.
The original candidate and its state remain separate recovery material.

## Compatibility and further integration

The implementation uses merged orchestration V2, not a second event-sourced host.
Workspace authority follows native projections and committed workspace revisions.
[`registerScientToolkit`](../../apps/server/src/mcp/McpHttpServer.ts) projects
authenticated MCP invocation context into shared admission before invoking the registered domain
handler; provider preparation and MCP mounting retain their existing owners. Domain services
stay independently owned.

When another tool family lands, deliberately register its ownership, availability and provider
naming, and test discovery together with existing host tools. The existing
[`Compute inventory toolkit`](../../apps/server/src/mcp/toolkits/compute/tools.ts) is discovery-only:
it reports configured settings, managed-runtime status and candidates, not execution readiness.
It cannot install a runtime, execute code, or attach to a user's session. Compute execution/history
changes require their own ownership and compatibility review.

Deferred work includes a capability Settings page, installable add-ons/plugins,
lazy tool-schema delivery, and Compute agent execution. None is needed to use the current
shared admission boundary. Scient Agent's existing driver is described in
[Provider architecture](./providers.md); it is not a future workspace-admission requirement.

## Verification boundaries

Regression fixtures cover concurrent per-request discovery, denied calls before
handler execution, explicit/native Skill access, changed workspace evidence,
publication fences, migration-ledger compatibility, queued context recovery,
and bounded Skill orientation. Synthetic provider tests do not establish live
provider compatibility, visual quality, or future plugin-scale performance.
