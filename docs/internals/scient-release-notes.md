# Scient release notes

- Status: Active
- Owner: Yaacov
- Created: 2026-08-09
- Last updated: 2026-08-29
- Purpose: Define the reusable in-app release-note system and its release boundary.
- Document type: Current implementation

## Outcome

Scient has a local, reusable **What’s New** system for approved Scient releases.
It can show a persistent sidebar card, the current release detail, and a
newest-first history of earlier Scient releases. Catalog entries are approved
product communication; their presence does not publish a release or enable the
release workflow.

The system does not fetch release copy, infer it from commits, or inherit T3
release notes. Its presentation and state are local to the web client and do
not change the updater, application version, release feed, or release authority.

## Ownership and upstream boundary

Scient owns the release-note model, catalog, lifecycle, presentation, and
tests under `apps/web/src/scient/releaseNotes/`. The only inherited T3 surface
changed by this feature is one mount in `SidebarChromeFooter`. Normal and
legacy sidebars both use that shared footer, so no second integration is
required.

Future T3 updates should preserve that narrow mount. Do not move release-note
state or orchestration into inherited sidebar, updater, or application-version
code. If the inherited footer changes substantially, remount the Scient-owned
component at the nearest equivalent footer seam.

## Content contract

Each release-note entry contains:

- the exact semantic application version that owns the note;
- an ISO calendar publication date;
- a short kicker, headline, and summary; and
- one to five stable, uniquely identified user-facing highlights.

The current installed version must match a catalog entry exactly before that
entry can appear. The catalog validator rejects invalid versions and dates,
duplicate versions, empty copy, excessive highlights, and duplicate highlight
identifiers.

## Lifecycle

1. On first use of this system, Scient silently records the installed version.
   It does not present old notes as if they were a new upgrade.
2. After an upgrade, Scient shows a note only when the catalog contains an
   approved entry for that exact installed version.
3. An upgrade without approved copy advances silently. Missing copy never
   blocks application startup or publication by itself.
4. The sidebar card remains available across restarts until the user dismisses
   it or closes its dialog.
5. The dialog includes all catalog entries at or below the installed version,
   sorted newest first. Selecting a history row opens that release’s full
   detail.
6. A handled release is not shown again, and downgrading does not move the
   handled-version marker backward.

State is stored under `scient:release-notes:v1`. It contains only the last
handled application version; no account data, release content, or scientific
project data is persisted.

## Adding a future release note

Add approved copy to `apps/web/src/scient/releaseNotes/catalog.ts` only after
the exact release candidate and its user-facing communication are approved:

```ts
{
  version: "<exact application version>",
  publishedAt: "<YYYY-MM-DD>",
  kicker: "<short release theme>",
  headline: "<plain-language user outcome>",
  summary: "<one concise explanation>",
  highlights: [
    {
      id: "<stable-id>",
      title: "<benefit>",
      description: "<what changed for the user>",
    },
  ],
}
```

Keep the copy product-centered and concise. Do not paste commit messages,
implementation details, internal project names, or unverified claims into the
catalog.

## Relationship to the release flow

This feature owns the in-app catalog, validation primitives, seen-state
lifecycle, and presentation. The separate release-flow work owns candidate
versioning, packaging, signing, publication, rollback, and the decision to
ship.

Release preflight reuses `validateScientReleaseNotesCatalog` and this catalog
rather than defining a second schema or source of truth. The exact stable
version normally requires an approved entry. A deliberately note-free release
remains possible only through an explicit release decision.

## Verification boundary

Pure selection, sorting, formatting, and catalog validation are covered by
unit tests. Typecheck, lint, formatting, the web test suite, build, desktop
smoke, brand checks, and `git diff --check` protect integration.

An entry renders as the current release card only when the installed
application version matches it exactly and the user is upgrading from an
earlier handled version. Every new entry requires a separate manual visual
review of the sidebar card, current-release dialog, history navigation, compact
sidebar behavior, dark mode, keyboard focus, and small-window scrolling before
publication.
