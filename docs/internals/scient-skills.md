# Scient skills core

Status: phase-one foundation implemented; no product skill or add-on ships in
this slice.

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
- `scient.skill.json`, carrying Scient's stable ID, exact SemVer, activation
  scope, and origin; and
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

The manifest declares whether a release may be activated at `user` or
`project` scope:

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

At session start, the server resolves user activation and the current
project/worktree lock into an exact release-key set. If the set is empty, no
skill capability or MCP credential is added merely for this feature.

For supported adapters the existing authenticated Scient MCP session receives:

- the `skills:read` capability;
- the exact allowed release keys; and
- `scient_skills_list`, `scient_skill_load`, and
  `scient_skill_read_resource`.

The bearer-token record owns a defensive copy of that scope, and every handler
checks both the capability and exact release allowlist. Loading returns
instructions and resource metadata. Resources remain separate and are read on
demand, preserving progressive disclosure.

Antigravity currently has no MCP transport and is reported as unsupported for
Scient skill delivery. The foundation does not emulate delivery with a large
prompt injection. Other current adapters consume Scient's MCP session. Adapters
with a private awareness seam append a short skills block only when
`skills:read` was actually granted; Cursor discovers the same tools through MCP
without extra prompt injection.

## Deliberate phase-one exclusions

- no built-in product skill;
- no Librarian port;
- no add-on catalog, installer, permission system, runtime, or marketplace;
- no arbitrary third-party JavaScript or executable loading;
- no script execution from a skill resource;
- no settings or project-management UI; and
- no organization sync or automatic project writes.

The empty built-in registration list is deliberate. A first real skill should
be a separate, reviewable product slice that proves authoring, management UI,
provider conformance, and manual UX without widening this core.

## Verification invariants

Automated coverage must continue to prove:

1. exact release validation, deterministic digesting, private byte snapshots,
   size limits, and symlink rejection;
2. zero-write project inspection and atomic explicit lock writes;
3. exact-lock trust invalidation after any lock-byte change;
4. no discovery of provider-native skill directories;
5. truthful unsupported delivery for Antigravity;
6. exact credential-scope copying and handler authorization; and
7. no skill awareness or MCP capability when no effective release exists.

The fork-owned roots and inherited integration points are recorded in
`scient-skills-seams.json` and checked by `pnpm skills:seams:check`.
