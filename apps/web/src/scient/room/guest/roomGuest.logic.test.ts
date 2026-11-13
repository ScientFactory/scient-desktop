import { RoomStreamEvent } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { makeThreadProjectionFixture } from "~/test-fixtures";
import {
  applyRoomStreamEvent,
  formatRoomExpiry,
  initialRoomStreamState,
  parseRoomStreamEvent,
  readRoomEntry,
  roomAttachmentUrl,
} from "./roomGuest.logic";

describe("room guest protocol", () => {
  it("keeps invite credentials separate from participant and attachment HTTP parameters", () => {
    expect(readRoomEntry("?room", "#test%2Binvite.signature")).toEqual({
      credential: "test+invite.signature",
      participantId: null,
    });
    expect(readRoomEntry("?room=participant", "")).toEqual({
      credential: null,
      participantId: "participant",
    });
    expect(readRoomEntry("?room", "#%invalid").credential).toBeNull();
    const url = new URL(roomAttachmentUrl("p & 1", "item/1", "file+1"), "https://example.test");
    expect(url.pathname).toBe("/api/room/attachment");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      p: "p & 1",
      item: "item/1",
      id: "file+1",
    });
  });
  it("uses the JSON codec and rejects malformed stream frames", () => {
    const event: RoomStreamEvent = { type: "ended", reason: "expired" };
    const encode = Schema.encodeSync(Schema.fromJsonString(Schema.toCodecJson(RoomStreamEvent)));
    expect(parseRoomStreamEvent(encode(event))).toEqual(event);
    expect(parseRoomStreamEvent('{"type":"ended","reason":"invalid"}')).toBeNull();
    expect(parseRoomStreamEvent("not json")).toBeNull();
  });
  it("replaces reconnect snapshots, ignores stale history, and never revives ended rooms", () => {
    const projection = makeThreadProjectionFixture();
    const opening: RoomStreamEvent = {
      type: "thread",
      item: {
        kind: "snapshot",
        snapshotSequence: 5,
        projection,
        hasMoreHistory: true,
        historyCursor: "first",
      },
    };
    const state = applyRoomStreamEvent(initialRoomStreamState, opening);
    expect(state.thread.historyCursor).toBe("first");
    const reconnected = applyRoomStreamEvent(state, {
      type: "thread",
      item: { kind: "snapshot", snapshotSequence: 8, projection },
    });
    expect(reconnected.thread.historyCursor).toBeNull();
    const stale = applyRoomStreamEvent(reconnected, {
      type: "history-page",
      cursor: "first",
      page: { snapshotSequence: 5, items: [], hasMoreHistory: false, nextCursor: null },
    });
    expect(stale.thread).toBe(reconnected.thread);
    const ended = applyRoomStreamEvent(stale, { type: "ended", reason: "removed" });
    expect(applyRoomStreamEvent(ended, opening)).toBe(ended);
    expect(ended.ended).toBe("removed");
  });
  it("reports remaining access down to its expiry boundary", () => {
    const now = Date.parse("2026-11-13T12:00:00Z");
    const expiry = (minutes: number) => new Date(now + minutes * 60000).toISOString();
    expect(formatRoomExpiry(expiry(6 * 1440 + 60), now)).toBe("6d left");
    expect(formatRoomExpiry(expiry(61), now)).toBe("1h left");
    expect(formatRoomExpiry(expiry(59), now)).toBe("59m left");
    expect(formatRoomExpiry(expiry(0), now)).toBe("Expired");
  });
});
