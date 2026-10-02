import { expect, it } from "vite-plus/test";
import { countUnreadBelow, updateUnreadMessages } from "./unreadTimelineMessages";
const message = (id: string, role = "assistant", createdAt = "2026-09-29T12:00:00Z") => ({
  id,
  role,
  createdAt,
});
it("counts each new assistant message once, never existing history, chunks, or user messages", () => {
  const initial = [message("old")];
  const state = updateUnreadMessages(undefined, initial);
  expect(state.unread.size).toBe(0);
  for (let chunk = 0; chunk < 100; chunk++)
    updateUnreadMessages(state, [
      ...initial,
      message("prompt", "user"),
      message("answer"),
      message("reasoning", "reasoning"),
    ]);
  expect([...state.unread]).toEqual(["answer"]);
  updateUnreadMessages(state, [message("older", "assistant", "2026-09-28T12:00:00Z"), ...initial]);
  expect([...state.unread]).toEqual(["answer"]);
});
it("clears messages as reached without recounting them after scrolling up or streaming again", () => {
  const state = updateUnreadMessages(undefined, [message("old")]);
  updateUnreadMessages(state, [message("old"), message("one"), message("two")]);
  const bounds = [
    { id: "one", top: 600, bottom: 1200 },
    { id: "two", top: 1200, bottom: 1500 },
  ];
  expect(countUnreadBelow(state, bounds, 0, 500)).toBe(2);
  expect(countUnreadBelow(state, bounds, 400, 900)).toBe(1);
  expect(countUnreadBelow(state, bounds, 0, 500)).toBe(1);
  updateUnreadMessages(state, [message("one"), message("two")]);
  expect(countUnreadBelow(state, bounds, 1000, 1500)).toBe(0);
  expect(state.unread.size).toBe(0);
});
it("counts a response once: progress notes stop counting when a later message supersedes them", () => {
  const state = updateUnreadMessages(undefined, [message("old")]);
  const turn = [message("old"), message("prompt", "user")];
  // Each note is the response's latest message when it arrives.
  updateUnreadMessages(state, [...turn, message("note-1")], new Set(["note-1"]));
  expect([...state.unread]).toEqual(["note-1"]);
  updateUnreadMessages(
    state,
    [...turn, message("note-1"), message("note-2"), message("answer")],
    new Set(["answer"]),
  );
  expect([...state.unread]).toEqual(["answer"]);
  const bounds = [
    { id: "note-1", top: 600, bottom: 700 },
    { id: "note-2", top: 700, bottom: 800 },
    { id: "answer", top: 800, bottom: 1200 },
  ];
  expect(countUnreadBelow(state, bounds, 0, 500)).toBe(1);
});
