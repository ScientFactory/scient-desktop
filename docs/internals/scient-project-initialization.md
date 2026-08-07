# Scient project initialization

Status: implemented migration M1 foundation; user visual acceptance remains a
separate gate.

## Ownership boundary

The T3-derived project system continues to own project registration,
environments, source providers, cloning, thread creation, and navigation.
Scient initialization is a bounded service invoked from that existing entry
flow; it does not replace or fork the host project model.

The Scient-owned boundary is split into four narrow seams:

1. `@scientfactory/project-init` owns filesystem inspection and initialization.
2. `@t3tools/contracts` owns the typed environment HTTP request and response
   schemas.
3. The server exposes authenticated inspect and initialize endpoints for the
   selected environment.
4. The web command palette adds the user decision, desktop drag/drop, and
   retry feedback while preserving the existing provider and picker flows.

This shape keeps scientific project meaning out of host internals, works
through the existing local, remote, relay, and future cloud connection model,
and minimizes the T3-owned surface that future upstream merges can touch.

## File contract and ordering

Initialization creates only missing files:

- `PROJECT.md` — broad project context intended to be refined by the user;
- `AGENTS.md` — broad agent guidance intended to be refined with the project;
- `.scient/project.json` — versioned durable local identity; and
- `.scient/project-init.json` — a temporary recovery record removed on
  success.

Existing project and agent documents are preserved byte for byte. The identity
is written after those documents, then the temporary transaction record is
removed as the final operation. Setup is complete only when a valid identity
exists without a pending transaction. The transaction includes hashes of files
that setup intended to create. Recovery continues only when those files are
absent or still exactly match the recorded contents.

The durable identity retains the compatible format already written by the
previous Scient app. Its older skills lock, when present, remains untouched and
does not activate or install anything. An unfinished transaction owned by the
previous app blocks new writes until it is recovered or rolled back with that
implementation; the two transaction formats are never guessed across.

## State model

- `ordinary`: no Scient identity or pending setup; setup may be offered.
- `initialized`: a valid identity exists; missing optional documents are not
  treated as damage because users may remove them deliberately.
- `recoverable`: a valid unfinished transaction exists and its pending files
  are unchanged.
- `conflicting`: an identity or transaction is invalid, pending content was
  changed, or the two records disagree. Automatic writes are blocked.

Inspection reads only these known paths. It does not crawl the project, parse
scientific content, or decide whether an ordinary folder is healthy.

## Failure and concurrency behavior

Project registration and navigation do not wait for selected initialization to
finish. If Scient inspection or initialization fails, the project remains
usable. Initialization is idempotent and concurrent requests for the same
resolved root are coalesced within the server process. Exclusive file creation
prevents replacement during a race, known files are read with size bounds, and
symlinked setup paths are rejected. A retry resumes only the recorded safe
work.

## Deliberate exclusions

This slice does not add project skills, a skills lock, old-app data migration,
PDF or source ingestion, provider changes, annotations, scientific operations,
or cloud/mobile UI. Those remain separate product slices. The environment API
keeps the project foundation usable by remote and selected-cloud clients later;
mobile presentation should be designed when its product flow is scheduled.

## Verification boundary

The package regressions cover ordinary setup, exact preservation,
idempotency, invalid or mismatched identity, interrupted recovery before and
after identity creation, modified pending content, and concurrent requests.
Contract and project-entry helpers are also tested.
Visual and interactive acceptance is performed by Yaacov in the managed
Scient (Dev) app; automated browser, screenshot, geometry, and visual-regression
checks are intentionally outside this slice.
