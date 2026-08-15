# Quick Chat design QA

Status: Source-matched implementation; local manual acceptance pending
Date: 2026-08-10

## Approved source

- Lab draft: `http://localhost:6264/draft/478238bd-ce02-48cd-a3ca-cb4d8d5aa380`
- Captured expanded state: `quick-chat-approved-expanded.png`

## Implemented comparison

The implementation retains the real Scient/T3-derived sidebar rather than
replacing it with a prototype layout. The new section is mounted between the
existing search/new-thread row and the existing project filter, matching the
approved information hierarchy. Existing thread rows, selection, menus,
settlement, snooze, pinning, search, keyboard navigation, and environment
labels are reused rather than visually re-created.

The section is intentionally compact: one existing-size navigation row, a
message icon, optional item count, and one chevron. Expanded chat rows use the
existing slim thread variant and an internally bounded scroll region so the
project navigation cannot be pushed out of reach. The open-chat header uses
the existing breadcrumb typography and one icon-only menu control.

## States to verify manually

1. Empty Quick chats section with projects present.
2. One and several quick chats, expanded and collapsed.
3. Search results containing both general and project conversations.
4. New unsent quick-chat draft, sent chat, active response, stopped chat,
   snoozed chat, settled chat, and pinned chat.
5. Plain `+` creation with one environment and the picker fallback with several.
6. Move action in the chat header, plus the second action in an open inline
   panel and responsive sheet; test no projects, one project, and several.
7. Browser, files, PDFs, agents, bottom terminal, and panel terminal work;
   Diff, PR, Git, checkpoint, revert, script, and worktree controls do not.
8. Moving with an open terminal is refused with a clear close-terminal message.
9. Successful relocation: the row disappears from Quick chats and appears
   under the selected project without changing the open conversation.
10. Narrow and expanded sidebar widths, light and dark appearance, and keyboard
    focus visibility.

No final visual-acceptance claim is made until the isolated Electron candidate
has been inspected in these states.
