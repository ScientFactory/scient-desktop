# Scient skills core

Status: phase-one personal skill management implemented with two inactive
built-in skills. Add-on installation remains a later phase.

## Purpose

Scient skills are reusable agent instructions and resources selected by the
user or by an initialized Scient project. A skill is data, not authority. It
cannot install software, grant a tool, reveal a credential, start a process, or
widen a provider session's permissions.

This core is intentionally independent of the future add-on system. An add-on
may eventually contribute an immutable skill release, but add-on installation,
permissions, runtimes, and removal remain separate lifecycle boundaries.

## Release contract

Every Scient-managed release is a reviewed directory containing:

- `SKILL.md`, following the current [Agent Skills
  specification](https://agentskills.io/specification);
- `scient.skill.json`, carrying Scient's stable ID, exact SemVer, supported
  activation scopes, default invocation policy, and origin; and
- optional `scripts/`, `references/`, `assets/`, or other bounded resources.

The loader rejects symlinked roots or entries, non-regular files, malformed
metadata, loose versions, oversized files, excessive file counts, and releases
whose Agent Skills name does not match the directory name. It snapshots every
byte once, computes a digest over sorted paths and contents, and serves later
resource reads only from that private snapshot. Invalid or duplicate releases
are quarantined independently and cannot prevent a healthy release or the
server from starting.

`allowed-tools` is preserved as informational Agent Skills metadata. Scient
never converts it into authority.

## Identity and activation

A release is selected only by the exact tuple `id`, `version`, `origin`, and
SHA-256 digest. There is no implicit latest-version resolution.

The manifest declares whether a release may be activated at `user`, `project`,
or both scopes. Scope is independent from release origin:

- user activation is stored in the app-private `scient-skills.json` policy;
- project activation is declared in `.scient/skills.lock.json`; and
- project activation is effective only while an app-owned trust receipt still
  matches the project identity, resolved root path, and exact lock-file digest.

Reading a folder or an absent lock is zero-write. Writing a lock and trusting
it are separate explicit actions. Editing the lock invalidates the existing
trust receipt. Provider-native locations such as `.agents/skills` are neither
scanned nor copied; Codex and Claude continue to own their native skill
systems.

## Provider-session delivery

At session start, the server snapshots personal activation and the current
project/worktree lock into an exact release-key set. A policy can allow agent
selection (`automatic`) or require the user to name the skill (`explicit`).
Activation controls availability; it does not itself invoke the skill. If the
set is empty, no skill capability or MCP credential is added merely for this
feature.

For supported adapters the existing authenticated Scient MCP session receives:

- the `skills:read` capability;
- the exact allowed release keys; and
- `scient_skills_list`, `scient_skill_load`, and
  `scient_skill_read_resource`.

The bearer-token record owns a defensive copy of that scope, and every handler
checks both the capability and exact release allowlist. Loading returns
instructions and resource metadata. Resources remain separate and are read on
demand, preserving progressive disclosure.

Codex, Claude, Droid, Grok, and OpenCode currently support the full Phase 1
delivery path. Their private awareness context tells the agent to list active
skills and to select an automatic skill only on a clear match. A visible
`$skill-name` token adds a turn-local private routing instruction for the exact
active release; it does not alter the message stored in the conversation. The
MCP loader also checks that turn-local selection before serving an `explicit`
release, so **Only with $name** is enforced rather than advisory.

Antigravity has no MCP transport, and Cursor has no reviewed private awareness
seam. Both are therefore reported as unsupported instead of receiving partial
or prompt-emulated behavior. Provider-native skill discovery remains
authoritative. The composer appends active Scient skills only when the provider
supports them, and withholds a Scient entry when a native skill already owns
the same name.

## Phase-one product surface

**Settings → Skills** lists the built-in releases and lets the user make each
one available personally. An active skill can be set to **Agent may use** or
**Only with $name**. Changes are persisted in app-private state and take effect
for new or restarted provider sessions. The composer exposes the same active
inventory through its existing `$` and optional `/` skill menus. Loading a
skill appears as a concise work-log event.

The built-in releases are deliberately inactive until the user enables them:

- `workspace-readiness-review`, defaulting to automatic selection; and
- `improve-workspace-readiness`, defaulting to explicit selection.

The exact project lock and trust model is implemented in the server core, but
project activation management has no product UI in this phase.

## Deliberate phase-one exclusions

- no Librarian port;
- no add-on catalog, installer, permission system, runtime, or marketplace;
- no arbitrary third-party JavaScript or executable loading;
- no script execution from a skill resource;
- no skill import/upload, agent-authored publication, or project-management UI;
  and
- no organization sync or automatic project writes.

## Verification invariants

Automated coverage must continue to prove:

1. exact release validation, deterministic digesting, private byte snapshots,
   size limits, and symlink rejection;
2. zero-write project inspection and atomic explicit lock writes;
3. exact-lock trust invalidation after any lock-byte change;
4. no discovery of provider-native skill directories;
5. truthful unsupported delivery for Antigravity and Cursor;
6. exact credential-scope copying and handler authorization; and
7. no skill awareness or MCP capability when no effective release exists;
8. inactive-by-default built-ins and persisted exact personal activation; and
9. deterministic explicit `$skill` routing without changing stored user text.

The fork-owned roots and inherited integration points are recorded in
`scient-skills-seams.json` and checked by `pnpm skills:seams:check`.
