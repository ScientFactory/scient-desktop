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

- `apps/web/src/scient/sections/` — catalog, grouping and drop rules
  (`logic.ts`), the Sections view, menus, settings-driven cleanup, and
  `useSidebarSections`, which gives `Sidebar.tsx` everything it needs.
- `apps/web/src/scient/sidebar/SidebarNewThreadRow.tsx` — the New thread row.
- `apps/server/src/persistence/Migrations/058_ProjectionThreadSections.ts` and
  `apps/server/src/orchestration/decider.threadSections.test.ts`.

Everything in upstream-owned files is a mount, listed under [Seams](#seams).

## Decisions and invariants

**Membership is thread state; the catalog is a setting.** A thread's
`sectionId` is written by the Scient `thread.section.set` command. Like T3's
`thread.active.reorder`, it emits `thread.meta-updated` with the thread's
_unchanged_ `updatedAt`, so organizing never reads as activity, reorders a list,
or changes a timestamp. The catalog (names, order, `emptySince`) is
`threadSections` in the **primary** environment's server settings, shared by
every window and client. Threads in other environments keep ids that resolve
against that one catalog.

**Sections never change lifecycle.** Filing, unfiling and dragging a thread do
not pin, unpin, settle, snooze or wake it, with two drag exceptions that mirror
the Status view: dropping on the Settled header settles, and dragging a shelved
thread into a section un-settles or wakes it. Settled and snoozed threads keep
their `sectionId` and return to their section when un-settled or woken.

**General is built in.** Threads without a known section render in General,
which is not a catalog entry. Its position is `threadSectionsGeneralIndex` (the
number of sections before it). It can be dragged but not renamed or deleted.
Removing a catalog entry leaves thread ids intact, so Undo (re-adding the
entry) brings its threads back; until then they read as General.

**The Sections view reuses T3's rendering and ordering.** Rows are T3's
`SidebarThreadRow`, shelves are T3's shelf headers, and order keys come from
T3's `planPinnedReorder` over the same `pinOrderKey`/`activeOrderKey` values, so
Status and Sections always agree on order within a lifecycle group.

**Headers sit with the threads they head.** In the Sections view every header
(sections, General, and the Settled and Snoozed shelves) sets its label 4px low
in its 32px row (`SECTION_HEADER_OFFSET_CLASS`), so a name reads as closer to its
own threads than to the group above. The row height is unchanged, so nothing
reflows. The shelves take the class from the Sections branch in `Sidebar.tsx`;
T3's shelf header component and the Status view are unchanged.

**Section drags never reflow the list.** Dragging a header freezes every
section's measured block at drag start and slides whole blocks (header plus
rows) by transform. Targets are judged against the frozen geometry, and
dnd-kit's sortable targets are bypassed for header drags. Collapsing rows or
re-measuring moving headers during a drag caused the cursor to lose the lifted
header and targets to oscillate; `SidebarSectionsView.browser.test.tsx` guards
this in Chromium.

**Empty-section cleanup is opt-in and conservative.**
`threadSectionsDeleteEmptyAfterDays` is null (off) by default and is registered
as a shared server preference like auto-settle. A section is empty when no
active, pinned, snoozed or settled thread points to it; archived threads are
not visible to the sidebar and do not count. The client stamps `emptySince`,
clears it when a thread joins, and removes a section only after the configured
days, and only once every environment has been connected for a minute, so a
section is never judged empty because some threads were not visible yet.
Removals offer Undo.

**New thread is a row, not an icon.** `SidebarNewThreadRow` takes the header's
own new-thread inputs (handler, disabled state, shortcut labels, Shift+click
hint), so both controls behave identically. Its 6px gap below search and its
smaller icon (14px) and label (13px) are set inside the row, not through shared
sidebar tokens, so they don't affect T3's other rows. The Shift+click hint is T3's text;
on current main the shared click handler does not read the modifier, so fixing
that belongs to the shared handler, not to the row. The header keeps T3's icon block
unchanged and hides it with the `hidden` attribute (Tailwind's preflight makes
`[hidden]` `display: none !important`).

**Search reads as quietly as the icons beside it.** The search icon and
"Search" placeholder rest at `--sidebar-icon-color`, like the header icons, and
strengthen only while the pointer is over the field, like every other sidebar
control. Focus alone does not strengthen them, and typed text keeps the normal
foreground color. The colors are set on the search field wrapper in
`SidebarThreadHeader.tsx`, because `SidebarInput` owns its own colors (the
`no-restyle` lint rule) and changing its shared style would affect every sidebar
input.

**Row memoization is preserved.** T3's row handlers depend on the stable
`sectionMenuFor` and `handleSectionMenuAction` callbacks, never on objects
rebuilt per render, so streaming updates do not re-render every row.

## Seams

Upstream-owned files touched, all additive unless noted. JavaScript mounts carry
`SCIENT-FORK` markers; SQL column lists do not.

| File                                                                                                                                                      | Mount                                                                                                                                                                                                                                                                                    |
| --------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/contracts/src/baseSchemas.ts`                                                                                                                   | `ThreadSectionId`                                                                                                                                                                                                                                                                        |
| `packages/contracts/src/orchestration.ts`                                                                                                                 | `sectionId` on thread, shell and `thread.meta-updated`; `thread.section.set` in both client command unions                                                                                                                                                                               |
| `packages/contracts/src/environment.ts`                                                                                                                   | `threadSections` capability                                                                                                                                                                                                                                                              |
| `packages/contracts/src/settings.ts`                                                                                                                      | `ThreadSection`, `threadSections`, `threadSectionsGeneralIndex`, `threadSectionsDeleteEmptyAfterDays` (settings and patch)                                                                                                                                                               |
| `packages/client-runtime/src/operations/commands.ts`, `state/threadCommands.ts`                                                                           | `setThreadSection` command and its optimistic patch                                                                                                                                                                                                                                      |
| `packages/client-runtime/src/state/sharedSettings.ts`                                                                                                     | the cleanup setting as a shared preference                                                                                                                                                                                                                                               |
| `apps/server/src/orchestration/decider.ts`                                                                                                                | `thread.section.set` case                                                                                                                                                                                                                                                                |
| `apps/server/src/orchestration/projector.ts`, `Layers/ProjectionPipeline.ts`                                                                              | project `sectionId`                                                                                                                                                                                                                                                                      |
| `apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts`, `persistence/Layers/ProjectionThreads.ts`, `persistence/Services/ProjectionThreads.ts` | read and write `projection_threads.section_id` (SQL column lists unmarked)                                                                                                                                                                                                               |
| `apps/server/src/persistence/Migrations.ts`                                                                                                               | migration 058                                                                                                                                                                                                                                                                            |
| `apps/server/src/environment/ServerEnvironment.ts`                                                                                                        | advertises `threadSections`                                                                                                                                                                                                                                                              |
| `apps/web/src/components/Sidebar.tsx`                                                                                                                     | `useSidebarSections`; section menu calls in both context-menu handlers; the Sections view branch and its row renderer; New thread row. Two lines change in place: T3's `orderedThreads` memo is renamed `statusOrderedThreads`, and the Status list's condition gains `&& !sectionsView` |
| `apps/web/src/components/sidebar/SidebarThreadHeader.tsx`                                                                                                 | `groupingToggle` slot and `hideNewThreadButton` (the icon block itself is unchanged). In place: the search field's class list, so its icon and placeholder rest at the sidebar icon color and strengthen on hover                                                                        |
| `apps/web/src/components/threadActionMenu.logic.ts`                                                                                                       | optional `sectionMenu` item before Copy                                                                                                                                                                                                                                                  |
| `apps/web/src/hooks/useThreadActionMenu.ts`, `components/chat/ChatHeader.tsx`                                                                             | Section submenu in the chat-header menu and its New section dialog                                                                                                                                                                                                                       |
| `apps/web/src/hooks/showThreadUndoNotice.ts`                                                                                                              | `"Moved"` undo action                                                                                                                                                                                                                                                                    |
| `apps/web/src/components/ui/sidebar.tsx`                                                                                                                  | `toggle` variant of `SidebarMenuButton`                                                                                                                                                                                                                                                  |
| `apps/web/src/contextMenuFallback.ts`                                                                                                                     | `list-filter` icon                                                                                                                                                                                                                                                                       |
| `apps/web/src/components/settings/SettingsPanels.tsx`, `settingsSearch.ts`, `SettingInheritance.tsx`                                                      | cleanup rows under General → Organization, search entries, and day labels                                                                                                                                                                                                                |

When aligning: if T3 adds its own thread grouping, collapsible shelves or a
section concept, reconcile against these seams instead of layering a second
grouping. If T3 changes `Sidebar.tsx`'s context-menu handlers, keep the two
Section-submenu calls. If T3 renumbers migrations, keep 058's `PRAGMA` guard,
which makes it safe to re-run.

## Verification

- `apps/web/src/scient/sections/logic.test.ts` and `menu.test.ts`: catalog
  edits, grouping, drop planning, drag order, cleanup sweeps, capitalization.
- `SidebarSectionsView.browser.test.tsx` and
  `scient/sidebar/SidebarNewThreadRow.browser.test.tsx` (Chromium, `layout`
  project): real-pointer header and thread drags, and the New thread row.
- `apps/server/src/orchestration/decider.threadSections.test.ts`, the
  thread-section case in `ProjectionPipeline.test.ts`, and the migration
  compatibility test.
- `packages/contracts/src/settings.test.ts` and
  `packages/client-runtime/src/state/sharedSettings.test.ts`.
