# Scientific Compute Toolkits and Managed Python Foundation

Status: Local implementation candidate; owner review pending
Owner: Yaacov
Created: 2026-08-30
Purpose: Records the smallest shared foundation for reviewed scientific Toolkits and a later Scient-managed Python environment without prematurely selecting a distribution, package resolver, onboarding flow, or agent authority model.
Doc type: Implementation note subordinate to `scient-compute-session-foundation.md`

## Product goal

Scient should make scientific capabilities easy to use for people who do not
want to manage Python packages themselves, while continuing to respect users
who already have a working environment. The product direction is:

- existing system, configured, and project-local runtimes remain supported;
- a Scient-managed environment becomes an optional assisted path, never a
  silent mutation of a user-owned Python;
- users and, later, authorized agents can request reviewed capability bundles
  through the same server-owned lifecycle;
- onboarding may briefly explain where setup lives, but should not become a
  package questionnaire or block first use; and
- each additional language or proprietary runtime keeps its own acquisition
  and licensing decisions instead of inheriting Python's mechanism.

This note describes a foundation, not a claim that managed Python installation
is ready for users. The implementation and this document must be refined when
qualification evidence disproves a proposed mechanism.

## Why Toolkits are the product unit

Most users want to work with data, create figures, fit a model, or prepare a
lesson. They should not need to choose a collection of low-level package names
before they can express that intent. A **Toolkit** is a reviewed, bounded
capability bundle such as **Data analysis and figures**.

The Toolkit descriptor says what capability Scient can assess. It does not
grant installation authority and does not itself define how packages are
downloaded. Those are separate boundaries:

1. The descriptor names the capability and its minimum compatibility
   requirements.
2. Runtime inspection assesses those requirements against one exact verified
   interpreter.
3. A separately reviewed managed-environment lock will eventually select exact
   artifacts, versions, hashes, and supported platforms.
4. A server-owned operation will perform an explicitly authorized setup and
   return progress and a durable receipt.

Keeping those boundaries separate allows the same Toolkit concept to describe
an existing `.venv` without pretending Scient installed or owns it.

## Candidate implemented in this worktree

### Bounded runtime observations

Python verification now observes only the reviewed packages needed by current
compute readiness and the first Toolkit candidate:

- `ipykernel`;
- `jupyter_client`;
- `matplotlib`;
- `numpy`;
- `pandas`; and
- `scipy`.

The probe reads package metadata without importing scientific packages and
runs through the existing isolated interpreter probe. It does not enumerate
the full environment or run `pip freeze`. The observations are transient
inspection data; durable execution identity remains the bounded environment
fingerprint.

### First Toolkit candidate

The first descriptor is **Data analysis and figures**, requiring NumPy,
pandas, SciPy, and Matplotlib. Its current compatibility assessment requires
presence only. Exact minimums should be added only when supported workflows or
the managed lock provide evidence for them.

Toolkit readiness is projected for each exact runtime candidate:

- `ready` means that runtime is compute-ready and has every Toolkit
  requirement;
- `missing-requirement` names scientific requirements absent from that exact
  runtime; and
- `runtime-unavailable` means the interpreter itself cannot run the compute
  bridge, so package presence cannot make the Toolkit usable.

The assessment never combines bridge readiness from one Python with packages
found in another. Older clients and retained test payloads remain decodable
because the new bounded fields default to empty during decoding.

### Transactional managed-environment boundary

The candidate adds a Python-specific manager for app-owned environment
generations under:

```text
<computeDir>/environments/python/<sha256(projectId)>/
```

The project identifier is hashed so it does not become a filesystem name. A
fresh setup provisions directly into a new final generation directory. This is
intentional: Python virtual environments may embed absolute paths and should
not be built in a temporary location and renamed afterward.

Activation follows this sequence:

1. Serialize managed-environment mutations in the server process.
2. Create one fresh, app-owned generation directory.
3. Ask a future provisioner to populate that exact final path.
4. Resolve and contain the returned executable canonically, rejecting lexical
   traversal and symlink escapes.
5. Verify the exact executable and requested Toolkit set.
6. Atomically replace the small active-state record.
7. Retain one previous generation and clean only older app-owned generations.

Nothing discovers the candidate before step 6. Provision, verification,
cancellation, or activation failure removes only the unpublished candidate and
leaves the previous state untouched. Removal first atomically renames the exact
app-owned project environment to a sibling tombstone; deletion failure renames
it back. A tampered state record cannot redirect inspection or cleanup outside
the managed root.

`repair` deliberately uses the same fresh-generation transaction as install.
It never modifies the active environment in place.

## What this candidate intentionally does not do

The following would create product or supply-chain commitments that are not
yet qualified, so they are not hidden inside this foundation:

- select or download a Python distribution;
- select `uv`, `venv`, Conda, or another resolver/environment mechanism;
- define an exact cross-platform package lock or artifact checksum manifest;
- install into a system Python, Homebrew Python, project `.venv`, or any other
  user-owned environment;
- change runtime discovery order or silently prefer Scient-managed Python;
- expose install, repair, update, remove, or progress RPCs;
- add Settings, onboarding, or first-run installation UI;
- grant an agent the authority to install software;
- treat a Skill as installation authority; or
- generalize Python's acquisition lifecycle into a mandatory mechanism for R,
  Julia, MATLAB, or proprietary tools.

Consequently there is no new user-facing installation claim in this candidate.
Existing compute behavior remains bring-your-own-runtime until the concrete
provisioner and product flow pass their own gates.

## Decisions required before the first installable slice

### Distribution and environment mechanism

Select the smallest supported Python base and environment mechanism using
evidence from macOS, Windows, Linux, packaged-app behavior, update behavior,
license terms, artifact size, and failure recovery. The decision must answer:

- where the base interpreter comes from;
- whether each project receives its own environment or a reviewed immutable
  environment can be shared safely;
- how architecture and operating-system targets map to artifacts;
- how exact package versions and transitive dependencies are locked;
- how downloads and artifacts are authenticated;
- how setup resumes or cleans up after process or machine interruption; and
- how a managed environment is updated without invalidating a running session.

Do not implement a network downloader before this decision. Download success
is not compatibility or supply-chain qualification.

### Ownership scope

The current activation manager is project-keyed because compute sessions and
their provenance are project-centered. Before wiring it to product behavior,
measure whether independent project environments are worth their disk and
setup cost. A globally shared immutable generation may be simpler for the
default Toolkit, while project-specific environments may be necessary for
reproducibility or conflicting packages. If the evidence favors a different
ownership scope, change the manager before exposing it rather than preserving
the current shape for its own sake.

In every design, Scient may delete only app-owned generations. Removing a
Toolkit or managed environment must never remove a system runtime or project
`.venv`.

### Updates and compatibility

Managed Python update state is separate from package readiness and from the
currently selected execution runtime. An update must:

- provision and qualify a new immutable generation;
- leave running sessions on the generation they started with;
- activate the new generation only after exact smoke and Toolkit verification;
- keep a bounded rollback generation; and
- expose a truthful pending, ready, failed, or rollback state without blocking
  existing system runtimes.

Provider-runtime update infrastructure can inform this lifecycle, but should
not be reused mechanically: Python environments embed paths and have package
resolution semantics that provider CLI archives do not.

### User and agent authority

The same setup operation may later be requested from Settings, first use, or
an agent. Request sources do not change ownership:

- the server resolves the Toolkit and platform lock;
- the server owns download, progress, cancellation, verification, activation,
  rollback, and the receipt;
- the user can see and stop the operation;
- an agent receives only an explicit, scoped capability and cannot choose an
  arbitrary package name, index, URL, command, or target environment; and
- a Skill may explain when to request a Toolkit, but cannot grant authority or
  bypass server policy.

Arbitrary package installation requested by an agent is a different and much
broader product capability. It should not be smuggled into the reviewed
Toolkit path.

## Suggested implementation sequence

1. Review this foundation's contract names, first Toolkit contents, and
   project-versus-shared ownership assumption.
2. Qualify and document the distribution, resolver, exact lock, artifact
   checksums, licenses, platform matrix, and packaged-app behavior.
3. Implement a concrete provisioner behind the existing final-path interface,
   including progress, cancellation, bounded resource use, exact verification,
   crash reconciliation, and fixture cleanup.
4. Add lifecycle RPCs and preserve separate status for system discovery,
   managed setup, Toolkit readiness, active sessions, and updates.
5. Add a compact Settings surface that shows existing runtimes first and
   offers the Scient-managed path only when useful. Keep install and first use
   to the minimum explicit clicks; never require onboarding setup.
6. Select the managed runtime through the existing exact-executable compute
   boundary, then run the current real-kernel and provenance suite unchanged.
7. Add first-use assistance and a short onboarding pointer only after Settings
   is accepted.
8. Add agent requests only after the operation-envelope authority and receipt
   model is accepted.

The notebook contract proof, notebook authoring, additional renderers, and a
second-language adapter can continue as independent compute tracks according
to the accepted ADR gates. Managed Python should improve first-use reliability;
it must not become a prerequisite that blocks those tracks or replaces users'
existing runtimes.

## Qualification required for promotion

The current candidate requires:

- schema compatibility tests for older inspection payloads;
- exact-runtime Toolkit assessment tests;
- tests proving package metadata is observed without imports or unbounded
  enumeration;
- activation tests for success, repair, previous-generation retention, and
  serialized mutation;
- failure tests for provision, verification, cancellation, state commit, and
  removal rollback;
- containment tests for traversal, canonical path aliases, executable symlink
  escape, tampered state, and cleanup scope;
- compute, contract, server, and web typechecks and focused suites; and
- final diff, formatting, seam, and dependency-boundary review.

A later installable slice additionally requires real package resolution,
offline/interrupted setup, cross-platform, update, rollback, packaged-app,
manual UX, and full current-main CI evidence. This local candidate alone does
not satisfy those release gates.
