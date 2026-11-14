# Thread rooms

A room lets invited people share a thread with the owner and its agent. Scient builds
it beside T3's single-guest links, which stay in the code unchanged and dormant: the
share commands open the room dialog instead (`apps/web/src/scient/room/RoomDialog.tsx`),
and a T3 share already open at upgrade keeps working until it ends.

## Model

- **Room state** is `thread.room` (`packages/contracts/src/scient/threadRoom.ts`): its
  id, the Connect host the invites point at, up to 16 participants (id, name once
  joined, role, expiry) and `waiting`, the guests' messages the owner has not seen.
  Changes are committed as `thread.guest-share-updated` with the whole thread, which
  publishes nothing to the relay and refreshes no pull requests.
- **Room messages** are timeline items of type `room_message` with no run, node or
  provider. They are stored and sent as a `system_notice` with a `roomMessage`
  payload, so older clients show "Name (to people): text"; current clients decode the
  item. They are not conversation messages, so no provider input, resume handoff or
  compaction includes them, and the MCP thread inspection omits their text. Exports
  (cloud copies, share links, continuing elsewhere) leave them out, because an
  imported copy's history can reach an agent; messages sent to the agent travel as
  usual.
- **Position**: the EventSink places a room message in the position range of
  `anchorRunOrdinal`, the latest run that had started when it was posted; work folding
  skips it.
- **Drawing**: a room message is a standalone timeline row
  (`scient/room/RoomMessageRow.tsx`) until it is sent or deleted: a dashed bubble in
  its writer's colour (`room-person-*` utilities, which reset the guest colour) with
  Send to agent. The timeline derivation (`session-logic.ts`) drops it once a delivery
  is `sent` (a cancelled send brings it back); the dispatched message stands in for
  it, coloured by `context.room.author`. With people in the room, the owner's
  composer posts (`scient/room/roomComposer.tsx`, a seam in `useComposerSend`) unless
  "straight to the agent" is on (`roomDirectStore`, per thread, in local storage);
  steering and direct prompts always go to the agent. The guest page has one
  composer and the same switch for the agent role. The phone app follows the same
  model.
- **Sending to the agent** is `message.dispatch` with `roomItemId`. The orchestrator
  builds the agent's words from the stored item (who wrote it, who sent it, what it
  replies to), records a delivery on the item in the same commit, and dispatches
  through the normal path. `context.room` (and `context.guest` for a guest's words) is
  set only by the server; client copies are stripped. A cancelled queued send marks the
  delivery cancelled.

Decisions live in one pure module, `apps/server/src/scient/room/threadRoomDecider.ts`.
Orchestrator mounts: `thread.room` (owner actions), `thread.room.server` (invites and
guests' actions from the room service) and `thread.room.guest-dispatch`, which runs a
guest's send as the `message.dispatch` it becomes under the same thread lock.

## Guests

`ThreadRoomService` and `scient/room/http.ts` serve `/api/room/*`. Invites and sessions
are signed claims checked against the live room on every request: the room is open,
the participant is in it and unexpired, their role allows the action, Connect still
serves the host, and guest links are on in Labs. Removing the last participant (joined or not)
closes the room, so there is no Stop sharing step. `renew` sets a participant's
`expiresAt` from now, keeping the role; sessions are checked against it live, so no new
link is needed. The thread shell carries `roomPeople` (who has joined) for the sidebar
card's faces; the header's faces open the People dialog and Share only makes links. Removing someone or
changing their role applies on their next request; their open stream ends when the room changes.
Presence is in memory: open guest streams per participant.

Roles (shown as Can chat and Can use agent): Discuss reads and posts; Agent also sends
to the agent, sends anyone's message to it, and stops the run. Watch (Can view, read
only) is no longer offered; rooms made with it keep working. The
`suggested` and `replyTo` fields remain in the contract; the clients no longer set
or show them.
Approvals, model and runtime settings and room administration stay with the owner.
A guest's send runs with the thread's own permissions: one session mixes everyone's
instructions, so a narrower mode for guests would not hold.

The guest page shares T3's `/guest` route, which runs without the app shell; the
`room` search parameter selects Scient's page (`apps/web/src/scient/room/guest/`).

## Files

Guests' files are checked like T3 guest uploads and stored as thread attachments. The
owner's files are claimed from pending uploads like a message's; their reservations
name the room message they belong to. The attachment sweep keeps any file a room
message holds. Deleting a room message hides its files; they stay on disk while the thread
lasts, because a fork or a message sent to the agent may hold them.
