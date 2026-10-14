# Scient sidebar: sections and the New thread row

Scient adds two sidebar divergences on top of T3's thread list: user-defined
**sections** with a Sections view, and a labelled **New thread** row below
search. Both are layered beside T3's sidebar rather than replacing it. This
document records the decisions, the invariants to keep, and every seam in
upstream-owned files, so upstream alignments can reconcile them quickly.
User-facing behavior is described in
[Organizing threads](../user/thread-sidebar.md#group-threads-into-sections).

## Ownership

Scient-owned code lives in:

- `apps/web/src/scient/sections/`:
  - `logic.ts`: catalog edits, grouping, drop rules and cleanup sweeps;
  - `catalogWrite.ts`: conditional catalog writes;
  - the Sections view, menus and settings rows;
  - `useSidebarSections`, which gives `Sidebar.tsx` everything it needs.
- `apps/web/src/scient/sidebar/SidebarNewThreadRow.tsx`: the New thread row.
- `apps/server/src/scient/threadSections/`: the catalog write precondition.
- `apps/server/src/orchestration-v2/Orchestrator.ts` and `ProjectionStore.ts`: native membership
  command and shell/detail projection. Immutable migration
  `apps/server/src/persistence/Migrations/058_ProjectionThreadSections.ts` remains for old data;
  `LegacyV1ThreadImporter` carries that membership into V2.

Everything in upstream-owned files is a mount, listed under [Seams](#seams).

## Decisions and invariants

### Row lifetime and layout

The Status and Sections lists retain each thread's lightweight row slot and
sortable target. Expensive row controls and subscriptions mount only near the
scroll viewport. The open, renaming, dragged, focused or interacting row stays
mounted; a menu keeps its trigger alive until it closes. All rows retain their
titles for find-in-page and accessibility.

Card and slim slots use the same rem-based dimensions as their full bodies.
Search results preserve their title and optional excerpt layout rather than
assuming a fixed height. One observer per scroll viewport serves both body
visibility and live-data leases, and releases its targets when rows leave the
list. Section markers and direct row children remain available to sorting and
FLIP motion measurements. This bounds the full bodies; the sortable slots and
list-level geometry work still grow with the list size.

### Data

**Membership is thread state; the catalog is a setting.**

- **Membership:** a thread's `sectionId` is written by the Scient
  `thread.section.set` command. Like T3's `thread.active.reorder`, it emits native
  `thread.metadata-updated` with the thread's _unchanged_ `updatedAt`. So
  organizing never reads as activity, reorders a list, or changes a timestamp.
- **Catalog:** names, order, `emptySince`, `environmentIds` and
  `createdInProjects` live in `threadSections` in the server settings of the
  environment whose threads the sections hold. Each environment has its own
  catalog and General position.

**A section belongs to one environment.** A thread's `sectionId` resolves only
against the catalog of the thread's own environment, whichever client is
looking. The catalog's home is a property of the data, not of the viewer.

- **Why:** the catalog used to live on the viewing client's _primary_
  environment. The hosted app has no primary, so sections disappeared there;
  a second desktop attached to the same server resolved its threads' ids
  against its own catalog, so they fell into General. Reading each
  environment's own catalog removes both failures.
- **Identity:** section ids are unique within one catalog only, so the sidebar
  names a section by both (`sectionGroupId`: the section id and environment
  id, URI-encoded around an `@`, colon-free like the other group ids). Group
  ids, collapse state, automatic-placement groups, drag targets and Undo all
  use it. Collapse state saved as a bare section id still collapses that
  section.
- **Reading:** `sectionCatalogsAtom` lists every connected environment whose
  server advertises `threadSections`, primary first, from the configs every
  client already receives. No primary is needed, so the hosted app and a
  second desktop see the same sections as the owning machine. The Group by
  section toggle shows whenever one catalog exists.
- **Writing:** every catalog edit targets one environment's server, with one
  write queue per environment. Membership writes name the section's
  environment and are refused for a thread on another one
  (`ThreadSectionElsewhereError`); the Sections view refuses such drops before
  they start.
- **One General:** threads without a known section, from every environment,
  share one General. `combinedSectionLayoutOrder` lists each environment's
  sections before its General first (environment by environment, in catalog
  order), then General, then the rest. Reordering writes each environment its
  own part (`environmentGroupOrder`) and skips environments whose part is
  unchanged. Order _between_ environments is not stored: a section dragged
  past another environment's sections returns to its environment's block.
  Move up/down steps only over General and sections of the same environment.
- **Names:** a section header names its machine only while sections from more
  than one environment are listed. Two environments' sections with the same
  name are separate sections; they are never merged by name.
- **What was given up:** one section can no longer hold threads from two
  environments. Creating a section for threads on several environments creates
  a section of that name on each, and reports any environment where creation
  failed. Ids filed under the old model, where another environment's thread
  pointed into the primary catalog, read as General; nothing migrates them,
  and nothing rewrites them either.
- **Mixed versions:** the server contract is unchanged, so new clients work
  with any server that advertises `threadSections`. Older clients still read
  and write their primary's catalog for every environment's threads, so
  upgrade every client of a multi-environment setup together.

**Catalog writes are conditional.** Clients replace the whole catalog, so two
clients editing at once could each overwrite the other's edit.

- **The check:** every write carries `threadSectionsExpected`, the catalog it
  was based on. The server checks it inside its settings write lock
  (`applyThreadSectionsPrecondition`). If the stored catalog no longer
  matches, the server drops the section keys and applies the rest of the
  patch.
- **The retry:** the client sees its edit missing from the returned settings
  and reapplies it to the catalog the server holds, up to three times
  (`writeCatalog`).
- **Within one client**, writes to one environment also run one at a time.
- **A missing section is confirmed before it is trusted.** A write resolves
  before the settings stream delivers it, so the local copy can lack a
  section this client just created. An edit that needs a section it cannot
  find (rename, remove) first sends a write that changes nothing, conditional
  on its copy; only if the server accepts it is the section really gone.
  Otherwise the edit reruns on the server's catalog. Filing never reads the
  local copy: it needs only the section's id and environment, so New section…
  can file into a section created a moment earlier.
- **Creation projects are add-only.** The precondition leaves out
  `createdInProjects`, so clients that predate it (and drop it when reading)
  can still write. The server merges the stored refs back into every written
  catalog instead, so neither those clients nor a write from a trailing copy
  can erase them.

**General is built in.**

- **Not a catalog entry:** threads without a known section render in General.
  Its position is `threadSectionsGeneralIndex`, the number of sections before
  it.
- **Movable, not editable:** it can be dragged, but not renamed or deleted.
- **Removal is reversible:** removing a catalog entry leaves thread ids intact.
  Until Undo re-adds the entry, those threads read as General; then they come
  back.

**Names follow one capitalization rule.** `capitalizeSectionName` capitalizes
the first letter unless the first word already mixes case ("iOS", "mRNA").

- **While typing:** every name field applies it (`readTypedSectionName`),
  keeping the caret in place and skipping IME composition.
- **On save:** `normalizeSectionName` also collapses whitespace.
- **On read:** `readThreadSections` normalizes names saved before the rule
  existed.

Because it's one rule, the field never shows a name that saves differently.

### Behavior

**New section… files its threads.** Creating a section from a thread menu
(or the chat header) creates it on those threads' environment, already
recording their projects there, then files them; threads on several
environments get a section of that name on each. A section started empty from
the New section row goes to the environment of the sidebar's selected project,
else the first catalog's (the primary's when it has one); the form shows a
machine picker when more than one environment stores sections. The compact creation popover shows a section-name input and small action buttons; its accessible title identifies the threads it is for. It opens beside
the initiating button or native-menu origin in both sidebar modes and the chat
header, without a backdrop or modal focus trap. The sidebar's New section row
opens the same form instead of becoming a bottom-of-list input.

**A fork stays in its origin's section.** V2 `ConversationForkService` and
`ThreadForkService` retain the origin's `sectionId` in the destination `thread.created`
fact, so the fork is never briefly unsectioned. A removed section's id reads as
General, as for the origin.

**Sections follow the sidebar's project scope.** Under All projects every
section is listed. With a project selected (`sectionGroupIdsInProjectScope`):

- **Where it has threads:** a section is listed when any unarchived thread of
  the project is in it, on any shelf. A section with threads in two projects
  is listed under both, with only that project's threads.
- **Empty sections:** a section with no threads anywhere is listed only in
  the projects in its `createdInProjects`: the project selected when it was
  created (published by the sidebar for creation elsewhere,
  `sidebarScope.ts`) and the projects of the threads filed on creation. One
  without that record, such as a section created before this, lists only
  under All projects. "No threads anywhere" is concluded only while this
  client holds the live thread list of the section's environment.
- **Order is per catalog:** reordering in a scope keeps hidden sections in
  their slots (`mergeListedGroupOrder`, applied inside each write attempt).
- **Filing crosses projects, not environments:** the Section submenu lists
  every section of the threads' environment, so a thread can join a section of
  another project there. A selection spanning environments offers only
  General and New section….

**Sections never change lifecycle.** Filing, unfiling and dragging a thread do
not pin, unpin, settle, snooze or wake it. There are two drag exceptions, both
mirroring the Status view:

- dropping on the Settled header settles the thread;
- dragging a shelved thread into a section un-settles or wakes it.

Settled and snoozed threads keep their `sectionId`, and return to their
section when un-settled or woken.

**The Sections view reuses T3's rendering and ordering.**

- **Rendering:** rows are T3's `SidebarThreadRow`, and shelves are T3's shelf
  headers.
- **Ordering:** order keys come from T3's `planPinnedReorder`, over the same
  `pinOrderKey`/`activeOrderKey` values. Status uses this canonical manual order. Sections may apply the local
  automatic-placement presentation described below.
- **Lone drops keep their key:** a thread dropped alone into an empty or
  collapsed section keeps its order key. With no neighbours, a new key would
  only move it in the Status view.

**Automatic placement is a local presentation, not a new server order.**

- **Preference:** `scient:sidebar:automatic-placement` defaults on. General →
  Organization exposes **Keep active threads near the top**; Status view is unaffected.
- **Membership:** unpinned, unshelved threads use the existing status, unread-answer,
  and unread-Woke predicates. Working, Monitoring, Done, Approval, Input, Failed,
  and Woke have equal placement priority. No execution or read semantics change.
- **State:** `automaticPlacement.ts` reconciles complete synchronized section membership,
  independently of project filtering and collapse. Scoped environment/thread keys
  prevent collisions. An arrival appends below existing upper members; transitions
  that remain eligible keep their place. Departures prepend to inactive rows, with
  simultaneous departures preserving their visible order.
- **Reading:** an open thread that loses eligibility retains placement. Leaving starts
  one three-second deadline; reopening or renewed eligibility cancels it. Timers pause
  during drags, acknowledged drop writes, native menus, and unsynchronized snapshots.
  Resume revalidates current state rather than replaying stale decisions.
- **Manual moves:** the existing lifecycle and membership-first drop transaction stays
  intact. The planner projects only the dragged row onto canonical manual neighbours,
  without writing automatically promoted positions of other rows. After successful
  writes, local presentation records the exact drop slot and bridges the old shell values
  until membership and order echoes arrive. A newer external value releases that bridge.
  An explicit inactive-above-active
  exception is allowed and survives until that row's own next eligibility transition.
  Remotely acknowledged order-key changes are deliberate placement too.
- **Persistence:** positions live under `scient:sidebar:placement-order:sections`, keyed
  by section group ids, so they no longer depend on which environment is primary.
  Storage contains scoped IDs, eligibility and order keys only. Read defensively;
  unavailable storage still permits in-memory operation. Restart discards deadlines,
  then reconciles current synchronized membership. Turning placement off cancels timers
  and reveals canonical manual order. The settings action also clears saved presentation
  while the sidebar is unmounted; re-enabling seeds from current manual order.
- **Preserved:** section catalog, General position, project registration/scoping,
  collapse, renaming, cleanup, pins, shelves, read markers, and server contracts.
  Automatic transitions never issue server reorder commands or change `updatedAt`.

`automaticPlacement.test.ts` covers ordering and eligibility transitions, including a
10,000-row stability case. `useAutomaticPlacement.test.tsx` covers controlled timers,
pause/reload/setting and cross-section acknowledgement. Chromium tests verify the
settings control and pointer drops against promoted presentation.

**Drops land where the list shows them.**

- **Headers have two insertion sides:** the lower half places a conversation
  at the top of the named section, including empty or collapsed sections. Crossing
  the midpoint upward selects the end of the preceding section, and the header
  slides down immediately to show that slot. Hidden rows remain before an end
  drop. The first header stays at the top; either half targets its own section.
  Preview and committed placement use the same slot and preserve pin boundaries.
- **Rows have two insertion sides:** the pointer above a row's midpoint inserts
  before it, and below inserts after it, independent of the source's position.
  The lower half of the last row appends to that section. Collision geometry
  excludes preview transforms, so a stationary pointer keeps its slot while
  rows slide. Preview, held layout and order-key planning use the same placement.
- **Conversation drags follow the pointer:** the grabbed point stays under the
  pointer as the list scrolls. Only section headers mount a drag overlay; an
  empty overlay would make sortable rows follow landing slots instead. Vertical
  movement and scroll-viewport boundaries still constrain the dragged card.
- **Membership precedes order:** a cross-section drop waits for the section move
  to succeed before writing order keys. A failed move releases the held preview
  without changing the conversation’s order in its original section. Same-section
  reordering does not perform a membership write.
- **Pins stay on top:** the slot keeps the row on its own side of the pinned
  rows, since a drop never changes a pin.
- **Whole sections:** a drop is planned against every row of the target
  section, including those a collapsed section hides
  (`expandSectionDropOrder`).
- **Only real drops highlight:** a section or shelf highlights only when the
  drop would change something. Order keys are written all or nothing, only
  when every affected row's server accepts them; a reorder that can't be
  written is no drop, while a move into another section still files the
  thread without new keys.

**Section drags never reflow the list.** Dragging a header freezes every
section's measured block at drag start, then slides whole blocks (header plus
rows) by transform.

- **Frozen targets:** targets are judged against that frozen geometry, and
  dnd-kit's sortable targets are bypassed for header drags.
- **Why:** collapsing rows or re-measuring moving headers made the cursor lose
  the lifted header and made targets oscillate.
  `SidebarSectionsView.browser.test.tsx` guards this in Chromium.
- **After a drop:** a held layout keeps the new order until the catalog write
  arrives. It stops applying as soon as the live order matches.

**New thread in a section survives only its own draft.**

- **Remembering:** the section and its environment are remembered for the
  draft's thread id, and filed once that thread exists. The draft starts in a
  project on the section's environment (the current project when it is there,
  else one of the section's threads' or creation projects). The entry is
  dropped only after the write succeeds, so a failed write is retried on a
  later update. Its own optimistic membership does not acknowledge the write.
- **Moved drafts:** if the thread appears on another environment (the composer
  retargeted the draft), the entry is dropped unfiled. Entries saved before
  environments were recorded file into that id on the thread's environment.
- **Forgetting:** T3 reuses an empty draft for any New thread request. So
  reusing one forgets its remembered section; the only seam for this is in
  `useHandleNewThread.ts`. "New thread in section" then remembers the section
  again.

**Empty-section cleanup is opt-in, per environment, and conservative.**

- **Setting:** `threadSectionsDeleteEmptyAfterDays` is null (off) by default.
  Each environment stores its own, beside its catalog; the settings row is
  server-scoped and follows the environment the settings page has selected.
- **Empty means:** no active, pinned, snoozed or settled thread of the
  section's environment points to it. Archived threads aren't visible to the
  sidebar and don't count. Threads of other environments can't be in it.
- **Seeing occupied is trusted; seeing empty is not.**
  - **Recording:** whenever membership changes, a client records the
    environment on each occupied section (`environmentIds`) and clears any
    `emptySince` stamp. This runs whether or not cleanup is on, so turning it
    on later is safe.
  - **Judging:** a client stamps a section `emptySince`, or removes it once
    stamped for the configured days, only after it has held that
    environment's live, synchronized shell snapshot for a minute. A connected
    transport alone is insufficient. Losing synchronization cancels timers and
    invalidates queued sweeps. `environmentIds` that older clients recorded
    for other environments no longer hold a section back.
- **Undo:** removals offer Undo, restored on the same environment.

### Presentation

**Headers sit with the threads they head.** In the Sections view, every header
(sections, General, and the Settled and Snoozed shelves) sets its label 4px low
in its 32px row (`SECTION_HEADER_OFFSET_CLASS`). A name then reads as closer to
its own threads than to the group above.

- **No reflow:** the row height is unchanged.
- **Shelves:** they take the class from the Sections branch in `Sidebar.tsx`.
  T3's shelf header component and the Status view are unchanged.

**Headers show state quietly.**

- **Chevron:** it points where the section is: right when collapsed, down when
  open. While open it appears only on hover or focus; while collapsed it stays
  visible, so a collapsed section shows how to open it. The hidden chevron
  keeps its space, so hovering never moves the name.
- **Actions:** the ⋯ and pen buttons are always shown.
- **Rule:** the line after the name needs at least 24px. The header's button
  wraps, and a rule without room drops to a clipped second line rather than
  showing as a stub. This is pure layout, so it can't flicker while the
  sidebar is resized.
- **Keyboard:** header drags are pointer-only, so headers don't advertise
  keyboard pick-up.

**The toggle's on state sits inside the hover.**

- **At rest:** while grouping is on, a gray mark (a 6% tint of
  `sidebar-foreground`, so it adapts to every palette) sits inset inside the
  toggle.
- **On hover:** the header's usual full-size white fill appears around it, and
  the mark stays on top.
- **Label:** it's fixed ("Group by section"); `aria-pressed` carries the state.

**New thread is a row, not an icon.**

- **Same inputs:** `SidebarNewThreadRow` takes the header's own new-thread
  inputs (handler, shortcut labels, Shift+click hint), plus the Shift+click
  handling described below.
- **Always a picker:** New thread opens the "New thread in…" picker whatever
  the number of projects (`shouldOpenNewThreadTargetPicker`, used by the row,
  the header and ⌘N). The current project is listed first. **Add project**
  sits above **No project**, both fixed below the scrolling projects. Add project
  runs the palette's usual flow, ending in a new thread in the added project.
  With no projects, the picker waits until project snapshots have loaded.
- **Direct scratch entry:** a separate dashed chat button on the left, separated
  by a subtle vertical divider, uses the shared `useScratchProject` flow. It appears
  only when the current environment offers scratch. Both buttons are briefly
  disabled while that request is pending, and repeated clicks cannot duplicate it.
- **Straight into the current project:** Shift+click on the row, as its
  tooltip says, and `chat.newLocal` (⇧⌘N) skip the picker. T3's shared click
  handler ignores the modifier, so the row handles Shift itself
  (`handleNewThreadRowClick`).
- **Local styling:** its 6px gap below search, 14px icon and 13px label are
  set inside the row, not through shared sidebar tokens.
- **The old icon:** the header keeps T3's icon block and hides it with an
  added `hidden` attribute. Tailwind's preflight makes `[hidden]`
  `display: none !important`.

**Search reads as quietly as the icons beside it.**

- **Colors:** the search icon and "Search" placeholder rest at
  `--sidebar-icon-color`, and strengthen only while the pointer is over the
  field. Focus alone doesn't strengthen them, and typed text keeps the normal
  foreground color.
- **Where:** the colors are set on the search field wrapper, because
  `SidebarInput` owns its own colors (the `no-restyle` lint rule).

**Row memoization is preserved.** T3's row handlers depend on the stable
`sectionMenuFor` and `handleSectionMenuAction` callbacks, never on objects
rebuilt per render. So streaming updates don't re-render every row.

## Seams

Upstream-owned files touched. JavaScript mounts are additive and carry
`SCIENT-FORK` markers unless listed as in place; SQL column lists are unmarked.

| File                                                                                                                                       | Mount                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/contracts/src/baseSchemas.ts`                                                                                                    | `ThreadSectionId`                                                                                                                                                                                                                                                                                                                                                                        |
| `packages/contracts/src/orchestrationV2.ts`                                                                                                | Native thread/shell `sectionId`, `thread.metadata-updated`, and `thread.section.set`; legacy schema decoding stays compatible                                                                                                                                                                                                                                                            |
| `packages/contracts/src/environment.ts`                                                                                                    | `threadSections` capability                                                                                                                                                                                                                                                                                                                                                              |
| `packages/contracts/src/settings.ts`                                                                                                       | `ThreadSection` (with `emptySince`, `environmentIds`, `createdInProjects`), `ThreadSectionProjectRef`, `ThreadSectionsPrecondition`, `threadSectionCatalogsEqual`; `threadSections`, `threadSectionsGeneralIndex`, `threadSectionsDeleteEmptyAfterDays`, `threadSectionsExpected`                                                                                                        |
| `packages/client-runtime/src/operations/commands.ts`, `state/threadCommands.ts`                                                            | `setThreadSection` command and its optimistic patch                                                                                                                                                                                                                                                                                                                                      |
| `packages/client-runtime/src/state/threadDetail.ts`, `shellReducer.ts`                                                                     | Native event reduction and shell–detail merge preserve membership                                                                                                                                                                                                                                                                                                                        |
| `apps/server/src/serverSettings.ts`                                                                                                        | `applyThreadSectionsPrecondition` inside `updateSettings`'s write lock                                                                                                                                                                                                                                                                                                                   |
| `apps/server/src/orchestration-v2/Orchestrator.ts`                                                                                         | Native `thread.section.set` admission and `thread.metadata-updated` without activity timestamp changes                                                                                                                                                                                                                                                                                   |
| `apps/server/src/orchestration-v2/ProjectionStore.ts`, `WireProjection.ts`                                                                 | Persist and expose `sectionId` in native shell/detail views                                                                                                                                                                                                                                                                                                                              |
| `apps/server/src/orchestration-v2/legacy/LegacyV1ThreadImporter.ts`                                                                        | Preserve legacy `projection_threads.section_id` in native imported thread facts                                                                                                                                                                                                                                                                                                          |
| `apps/server/src/persistence/Migrations.ts`                                                                                                | migration 058                                                                                                                                                                                                                                                                                                                                                                            |
| `apps/server/src/environment/ServerEnvironment.ts`                                                                                         | advertises `threadSections`                                                                                                                                                                                                                                                                                                                                                              |
| `orchestration-v2/runtimeLayer.test.ts`, `scient-fork/ConversationForkService.test.ts`, `ConversationForkNativeAnswer.integration.test.ts` | Native membership, unchanged activity timestamp, shell/detail and fork retention                                                                                                                                                                                                                                                                                                         |
| `apps/web/src/components/Sidebar.tsx`                                                                                                      | `useSidebarSections` (with the selected project's refs); the Section submenu in both context-menu handlers, right after Snooze in the multi-select menu; the Sections view branch and its row renderer; the New thread row and its Shift+click handler. In place: T3's `orderedThreads` memo is renamed `statusOrderedThreads`, and the Status list's condition gains `&& !sectionsView` |
| `apps/web/src/components/sidebar/SidebarThreadHeader.tsx`                                                                                  | `groupingToggle` slot and `hideNewThreadButton`. In place: the search field's class list, and a `hidden` attribute on T3's New thread icon                                                                                                                                                                                                                                               |
| `apps/web/src/hooks/useHandleNewThread.ts`                                                                                                 | reusing an empty draft forgets its remembered section                                                                                                                                                                                                                                                                                                                                    |
| `apps/web/src/components/threadActionMenu.logic.ts`                                                                                        | Section menu ids in `ThreadActionMenuId`; optional `sectionMenu` item right after Snooze, in the placement group                                                                                                                                                                                                                                                                         |
| `apps/web/src/hooks/useThreadActionMenu.ts`, `components/chat/ChatHeader.tsx`                                                              | Section submenu in the chat-header menu and its anchored New section popover                                                                                                                                                                                                                                                                                                             |
| `apps/web/src/hooks/showThreadUndoNotice.ts`                                                                                               | In place: `"Moved"` in the undo action union                                                                                                                                                                                                                                                                                                                                             |
| `apps/web/src/components/ui/sidebar.tsx`                                                                                                   | `toggle` variant of `SidebarMenuButton`                                                                                                                                                                                                                                                                                                                                                  |
| `apps/web/src/contextMenuFallback.ts`                                                                                                      | `list-filter` icon                                                                                                                                                                                                                                                                                                                                                                       |
| `apps/web/src/components/settings/SettingsPanels.tsx`, `settingsSearch.ts`                                                                 | `AutomaticThreadPlacementSettings` and `EmptySectionCleanupSettings` under General → Organization, and their search entries                                                                                                                                                                                                                                                              |
| `apps/web/src/components/CommandPalette.tsx`, `CommandPalette.logic.ts`                                                                    | "Add project" at the end of the "New thread in…" picker, which also opens with no projects. In place: `shouldOpenNewThreadTargetPicker` is true whatever the number of projects, and the picker's early return and its two project lists (the pushed picker and the palette's "New thread in…" submenu)                                                                                  |

**When aligning:**

- **Grouping:** if T3 adds its own thread grouping, collapsible shelves or a
  section concept, reconcile against these seams instead of layering a second
  grouping.
- **Context menus:** if T3 changes `Sidebar.tsx`'s context-menu handlers, keep
  the two Section-submenu calls.
- **Settings writes:** if T3 restructures `updateSettings`, keep the
  precondition inside its write lock.
- **Migrations:** if T3 renumbers migrations, keep 058's `PRAGMA` guard, which
  makes it safe to re-run.

## Verification

- **Web unit tests** (`apps/web/src/scient/sections/`):
  - `logic.test.ts`: catalog edits, section group ids, combining and
    splitting environments' layouts, grouping that resolves membership only in
    the thread's own catalog, project-scope visibility, drop planning (header
    drops, pinned rows, collapsed sections, order-key support), drag order,
    cleanup sweeps, and capitalization;
  - `catalog.test.tsx`: catalogs listed without a primary, writes and queues
    per environment, ids never resolved in another catalog, queued cleanup;
  - `catalogWrite.test.ts`: concurrent edits from two clients both survive,
    and a missing section is confirmed before it is trusted;
  - `newSectionFiling.test.tsx`: the real catalogs and actions file into a
    section created a moment earlier, on each thread's own environment;
  - `useNewSectionForThreads.test.tsx`: New section… creates and files, per
    environment, and the machine choice for an empty section;
  - `pendingNewThreadSections.test.ts`: optimistic rollback, filing retries,
    draft reuse, moved drafts and entries saved before environments;
  - `actions.test.tsx`: membership on the thread's environment only;
  - `useThreadSectionMenu.test.tsx`, `menu.test.ts`: the submenu per environment;
  - `useSidebarSections.test.tsx`: the toggle without a primary, reordering per
    environment, machine labels and legacy collapse state;
  - `useEmptySectionCleanup.test.tsx`: per-environment settings, synchronization
    gating and cancellation.
- **Browser tests** (Chromium, `layout` project): `SidebarSectionsView`,
  `NewSectionPopover`, `SidebarSectionsToggle` and
  `scient/sidebar/SidebarNewThreadRow` cover real-pointer header and thread
  drags, refused drops into another environment's section, machine labels, the
  creation form and its machine picker, header layout, the toggle and the New
  thread row. On a cold Windows cache the browser can take over a minute to
  connect; pass `--browser.connectTimeout=600000` rather than reading that as
  a failure.
- **Server tests:**
  - `apps/server/src/scient/threadSections/`: catalog preconditions through `updateSettings`;
  - `apps/server/src/orchestration-v2/runtimeLayer.test.ts`: native filing/clear, unchanged activity
    timestamp, and shell/detail membership;
  - `scient-fork/ConversationForkService.test.ts` and `ConversationForkNativeAnswer.integration.test.ts`:
    native fork section retention;
  - legacy import tests cover hydrated facts separately. The V2-directory tests named
    `decider.threadSections` and `Layers/ProjectionSnapshotQuery.threadSections` still exercise
    the superseded V1 pipeline and must not count as native proof;
  - immutable migration compatibility tests remain separate from live execution evidence.
- **Contracts and client runtime:** `packages/contracts/src/settings.test.ts`,
  and native thread-detail/shell
  reducers in `packages/client-runtime/src/state/`; inherited V1 reducer tests do not establish
  live section rendering.
