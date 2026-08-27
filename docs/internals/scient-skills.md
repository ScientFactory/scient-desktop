# Scient skills core

Status: phase-one personal skill management implemented with three built-in
skills. Add-on installation remains a later phase.

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
- `scient.skill.json`, carrying Scient's stable ID, exact SemVer, presentation
  category, category description, and order, supported activation scopes,
  default invocation policy, and origin; and
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

A delivered release is selected only by the exact tuple `id`, `version`,
`origin`, and SHA-256 digest. There is no implicit latest-version resolution in
the runtime authority boundary.

Scient-owned shipping defaults live beside the built-in catalog rather than in
portable skill manifests, so an add-on cannot declare itself active. Personal
preferences store an explicit active or inactive decision plus invocation
policy. The effective policy is the user preference when one exists, otherwise
the Scient-owned shipping default. A preference follows a stable skill ID only
within the same origin, while every turn still authorizes the exact current
release. This lets a trusted Scient app update preserve user intent without
allowing an add-on update to inherit authority across origins.

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

## Provider-turn delivery

At the start of every turn, the server snapshots personal activation and the
current project/worktree lock. A policy can allow agent selection
(`automatic`) or require the user to name the skill (`explicit`). Activation
controls availability; it does not itself invoke the skill. A running turn
keeps its immutable snapshot, while activation and policy changes apply to the
next turn without restarting the provider session.

For supported adapters the existing authenticated Scient MCP session receives:

- the `skills:read` capability;
- the exact release keys visible in that turn; and
- `scient_skills_list`, `scient_skill_load`, and
  `scient_skill_read_resource`.

Supported providers keep the authenticated skill transport available with an
empty initial scope. Immediately before a turn, the server atomically replaces
that scope with active automatic skills plus active explicit skills selected
as `$name`. Unselected explicit and inactive skills are absent from both the
agent-facing list and the MCP allowlist. The agent-facing index uses the
canonical Agent Skills name and never asks the model to reconstruct internal
versions or digests. Load and resource calls resolve that name only within the
current scope, then the server loads the exact release key already bound there.
Conflicting active names are withheld rather than resolved ambiguously. Every
handler checks the capability and exact turn allowlist. Loading returns
instructions and resource metadata; resources remain separate and are read on
demand.

Codex, Claude, Droid, Grok, and OpenCode currently support the full Phase 1
delivery path. Their stable private awareness explains the routing rule; a
turn-local private index supplies only the exact automatic and selected skills
available now. A visible `$skill-name` token adds the selected exact release to
that index and allowlist without altering the message stored in the
conversation. **Only with $name** is therefore enforced by omission, not by a
secondary denial after discovery.

Antigravity has no MCP transport, and Cursor has no reviewed private awareness
seam. Both are therefore reported as unsupported instead of receiving partial
or prompt-emulated behavior. Provider-native skill discovery remains
authoritative. The composer appends active Scient skills only when the provider
supports them, and withholds a Scient entry when a native skill already owns
the same name.

## Phase-one product surface

**Settings → Skills** groups built-in releases by their manifest category and
lists them in manifest presentation order. The user can make each one available
personally. An active skill can be set to **Agent may use** or **Only with
$name**. Changes are persisted in app-private state and take effect on the next
turn. The composer exposes the same active inventory through its existing `$`
and optional `/` skill menus. Loading a skill appears as a concise work-log
event.

The initial built-in shipping policy is:

- `workspace-readiness-review`: active, with automatic selection;
- `improve-workspace-readiness`: active, with explicit `$name` selection; and
- `scient-skill-authoring`: active, with automatic selection.

Changing these catalog defaults affects only skills without an explicit user
preference. Enabling or disabling a skill always creates a durable preference,
so a later product-default change cannot override that choice.

The exact project lock and trust model is implemented in the server core, but
project activation management has no product UI in this phase.

### Provider-owned external skills

**Settings → Skills → External skills** presents the global skill inventory
reported by each connected provider instance. Providers remain the source of
truth. Codex supplies its inventory through app-server; Claude uses the Agent
SDK's skill-only reload response plus narrow filesystem discovery for scope
metadata; and Antigravity uses metadata-only discovery for its documented skill
roots.
Scient does not copy, import, rewrite, or execute those files. Personal,
provider-bundled, system, and otherwise unclassified global skills are shown;
project and repository skills stay out of this global page and out of the
global `$` and `/` menus.

Provider instances share one compact selector and only the selected provider's
inventory is expanded. Native skill controls are capability-gated: Codex
currently exposes its reviewed `skills/config/write` API, so its skills can be
activated or deactivated in Scient. Claude, Antigravity, and OpenCode remain
read-only because they do not expose an equivalent reviewed mutation API. The
server validates the exact provider instance, skill name, and provider-owned
path against the latest snapshot before dispatching a change, then refreshes
the provider inventory. The UI never predicts success.

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
6. exact turn-scope copying, unique model-facing names, and handler authorization;
7. empty initial transport plus next-turn scope replacement without provider
   restart;
8. product-owned built-in defaults plus durable active and inactive personal
   preferences; and
9. deterministic explicit `$skill` routing that hides unselected explicit
   skills without changing stored user text.

The fork-owned roots and inherited integration points are recorded in
`scient-skills-seams.json` and checked by `pnpm skills:seams:check`.
