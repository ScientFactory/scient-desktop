import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  makeOmpSessionCursor,
  parseOmpSessionCursor,
  type OmpResumeIdentity,
} from "../omp/OmpSessionCursor.ts";
import { ompTarget, type OmpTarget } from "../omp/OmpTarget.ts";
import { scientAgentTarget } from "./ScientAgentTarget.ts";

/**
 * The same identity for both products: instance, session folder, workspace
 * and home. Only the product differs, which is the case a shared session
 * format cannot tell apart on its own.
 */
const identity: OmpResumeIdentity = {
  providerInstanceId: "agent",
  sessionRoot: "/state/sessions/thread",
  workspace: "/workspace/project",
  homeIdentity: "/home/test/agent",
  profileIdentity: "",
};

const cursorFrom = (target: OmpTarget) => {
  const cursor = makeOmpSessionCursor({
    target,
    identity,
    sessionFile: "/state/sessions/thread/session.jsonl",
    ompVersion: "18.4.8",
    rpcProtocolVersion: 2,
  });
  if (!cursor) throw new Error("Expected a cursor fixture.");
  return cursor;
};

const parseFor = (target: OmpTarget, cursor: unknown) =>
  parseOmpSessionCursor(cursor, { target, identity, ompVersion: "18.4.8", rpcProtocolVersion: 2 });

describe("resume cursors across products", () => {
  it("records the product on a Scient Agent cursor and leaves Oh My Pi's shape unchanged", () => {
    expect(cursorFrom(scientAgentTarget).driverKind).toBe("scient");
    expect(cursorFrom(ompTarget)).not.toHaveProperty("driverKind");
  });

  it.effect("each product resumes its own cursor", () =>
    Effect.gen(function* () {
      const scientAgent = cursorFrom(scientAgentTarget);
      expect(yield* parseFor(scientAgentTarget, scientAgent)).toEqual(scientAgent);
      const omp = cursorFrom(ompTarget);
      expect(yield* parseFor(ompTarget, omp)).toEqual(omp);
    }),
  );

  it.effect("Oh My Pi refuses a Scient Agent cursor with an otherwise identical identity", () =>
    Effect.gen(function* () {
      expect(yield* parseFor(ompTarget, cursorFrom(scientAgentTarget)).pipe(Effect.flip)).toBe(
        "Oh My Pi resume cursor was written by a different agent.",
      );
    }),
  );

  it.effect("Scient Agent refuses an Oh My Pi cursor with an otherwise identical identity", () =>
    Effect.gen(function* () {
      expect(yield* parseFor(scientAgentTarget, cursorFrom(ompTarget)).pipe(Effect.flip)).toBe(
        "Scient Agent resume cursor was written by a different agent.",
      );
    }),
  );
});
