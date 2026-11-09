import * as NodeEvents from "node:events";

import type { SessionCookie } from "@t3tools/contracts";
import { afterEach, expect, it, vi } from "vite-plus/test";

import { markOwnWrites, pendingOwnWrites } from "./mainInserts.ts";

const cookie = (name: string): SessionCookie => ({
  name,
  value: "synthetic",
  domain: ".example.test",
  hostOnly: false,
  path: "/",
  secure: true,
  httpOnly: true,
  sameSite: "lax",
});

afterEach(() => {
  vi.useRealTimers();
});

it("drops the marks of writes Chromium never inserted once they expire", () => {
  vi.useFakeTimers();
  const session = { cookies: new NodeEvents.EventEmitter() } as never;
  // Refused writes: their inserts never come, so nothing consumes the marks.
  markOwnWrites(
    session,
    Array.from({ length: 500 }, (_, index) => cookie(`refused-${index}`)),
  );
  expect(pendingOwnWrites(session)).toBe(500);
  vi.advanceTimersByTime(61_000);
  markOwnWrites(session, [cookie("fresh")]);
  expect(pendingOwnWrites(session)).toBe(1);
});
