import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  makeOmpSessionCursor,
  ompBinaryFingerprint,
  ompMajorCompatible,
  ompStateScopeFingerprint,
  parseOmpSessionCursor,
  sessionFileInsideRoot,
} from "./OmpSessionCursor.ts";

describe("Oh My Pi session cursor", () => {
  it("keeps a session file inside its directory and rejects escapes", () => {
    expect(sessionFileInsideRoot("/state/omp/thread", "/state/omp/thread/session.jsonl")).toBe(
      "session.jsonl",
    );
    expect(sessionFileInsideRoot("/state/omp/thread", "/state/omp/other/session.jsonl")).toBe(
      undefined,
    );
    expect(sessionFileInsideRoot("/state/omp/thread", "/state/omp/thread/../secret")).toBe(
      undefined,
    );
  });

  it.effect("round-trips only a cursor for the same instance and directory", () =>
    Effect.gen(function* () {
      const cursor = makeOmpSessionCursor({
        providerInstanceId: "omp",
        sessionRoot: "/state/omp/thread",
        sessionFile: "/state/omp/thread/session.jsonl",
        sessionId: "session-1",
        ompVersion: "18.2.8",
        rpcProtocolVersion: 2,
      });
      expect(cursor?.stateScopeFingerprint).toBe(
        ompStateScopeFingerprint("omp", "/state/omp/thread"),
      );
      expect(
        yield* parseOmpSessionCursor(cursor, {
          providerInstanceId: "omp",
          sessionRoot: "/state/omp/thread",
        }),
      ).toMatchObject({ sessionId: "session-1" });
      expect(
        yield* parseOmpSessionCursor(cursor, {
          providerInstanceId: "omp-other",
          sessionRoot: "/state/omp/thread",
        }).pipe(Effect.flip),
      ).toContain("different provider instance");
    }),
  );

  it.effect("refuses a different major version and a different executable fingerprint", () =>
    Effect.gen(function* () {
      expect(ompMajorCompatible("18.2.8", "18.9.0")).toBe(true);
      expect(ompMajorCompatible("18.2.8", "19.0.0")).toBe(false);
      const cursor = makeOmpSessionCursor({
        providerInstanceId: "omp",
        sessionRoot: "/state/omp/thread",
        sessionFile: "/state/omp/thread/session.jsonl",
        ompVersion: "18.2.8",
        rpcProtocolVersion: 2,
        binaryPathFingerprint: ompBinaryFingerprint("/usr/local/bin/omp"),
      });
      expect(
        yield* parseOmpSessionCursor(cursor, {
          providerInstanceId: "omp",
          sessionRoot: "/state/omp/thread",
          expectedBinaryFingerprint: ompBinaryFingerprint("/other/omp"),
        }).pipe(Effect.flip),
      ).toContain("different executable");
    }),
  );

  it.effect("records a request id and still reads a cursor that has none", () =>
    Effect.gen(function* () {
      const cursor = makeOmpSessionCursor({
        providerInstanceId: "omp",
        sessionRoot: "/state/omp/thread",
        sessionFile: "/state/omp/thread/session.jsonl",
        ompVersion: "18.2.8",
        rpcProtocolVersion: 2,
        lastRequestId: "41",
      });
      expect(
        yield* parseOmpSessionCursor(cursor, {
          providerInstanceId: "omp",
          sessionRoot: "/state/omp/thread",
        }),
      ).toMatchObject({ lastRequestId: "41" });
      expect(cursor).toBeDefined();
      const older = { ...cursor };
      delete older.lastRequestId;
      expect(
        yield* parseOmpSessionCursor(older, {
          providerInstanceId: "omp",
          sessionRoot: "/state/omp/thread",
        }),
      ).not.toHaveProperty("lastRequestId");
    }),
  );
});
