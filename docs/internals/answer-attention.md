# Unread completed answers

Scient's macOS Dock badge represents the number of unarchived conversations with
an unread successful answer, across the client's connected environments. It is
a projection of current state, never an increment/decrement event counter.

## Completion and read ownership

The server derives `latestCompletedAnswer` from existing durable turn and message
projections. It selects the newest successfully completed turn whose final
assistant message still exists and is no longer streaming. Current running,
interrupted, and failed turns do not erase it. Reverting the message removes the
marker through the same query. No provider events, queue transitions, or database
schema are added. The query uses existing per-thread turn and message indexes.

Shell and detail snapshots expose the same optional contract. The shell's marker
wins when merging independently delivered detail. An omitted field supports old
servers by falling back to the latest successful turn; an explicit null means no
answer. Old servers cannot preserve an answer across subsequent queued turns.

The existing environment-scoped, persisted `threadLastVisitedAtById` owns read
acknowledgement and Mark unread. The chat acknowledges the exact completion time
only when its final assistant message is loaded and the document is visible and
focused. Selecting a background conversation does not acknowledge it. Merely
opening Settings does not acknowledge any conversation. Reading here means
viewing the conversation, without requiring scrolling to a particular message.

On the first live snapshot of each environment, a Scient-owned persisted baseline
records the latest server timestamp in that snapshot. For the Dock count only,
missing read markers fall back to this fixed adoption boundary. Existing sidebar
visit timestamps are never initialized or overwritten, preserving independent
wake indicators and explicit Mark unread. Later new conversations use the same
baseline, so their completed answers are counted. Using server time avoids client-clock skew. The baseline
survives renderer reloads; restricted storage falls back to the current session.
Client read state remains local and is not synchronized across devices.

## Desktop delivery

A Scient coordinator above routes follows shell snapshots and read state.
Replayed updates are idempotent, multiple completions in one conversation count
once, and cached remote snapshots preserve their known count during disconnection.
An unavailable environment does not block updates from other environments. Removed
environments and archived/deleted conversations are excluded. Initial missing
snapshots do not erase an existing native badge.

A narrow preload method sends the derived count through schema-validated IPC.
The main process accepts only its primary renderer's sender ID, then calls
Electron's native badge API on macOS. Zero clears the badge. Count changes are
deduplicated; returning focus reapplies the current value in case OS permissions
changed. Guest browser previews cannot set the count. Other platforms are a no-op.
OS badge permission remains authoritative; a successful API call is not proof
that macOS displayed the badge. The feature requests no banners or sounds.

The coordinator runs while a window is open, hidden, or minimized. The existing
macOS red-close behavior destroys the last renderer, so its last count remains
but new completions are incorporated only when the window reopens. Supporting
updates with all windows closed would require a main-process environment
subscription owner; this implementation does not change application lifecycle.

## Integration and verification

Scient-owned behavior lives in `scient/answerAttention` modules in server, web,
and desktop. Shared changes are limited to the optional summary contract, query
selection/mapping, detail merge, one root coordinator, read acknowledgement and
Mark unread integration, and the validated desktop bridge. Preserve these seams
when aligning upstream; do not duplicate completion events or provider logic.

Tests cover durable completion selection, streaming/reverted messages, queued and
unsuccessful turns, shell/detail propagation, background focus and delayed detail,
historical initialization, environment scoping, replay, read/archive removal, and
IPC payload/sender validation. Native appearance and macOS permission behavior
require the user's manual review in an isolated development app.
