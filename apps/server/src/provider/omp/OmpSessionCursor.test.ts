import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  makeOmpSessionCursor,
  ompBinaryFingerprint,
  ompHomeProfileFingerprint,
  ompLaunchPolicyFingerprint,
  ompMajorCompatible,
  ompStateScopeFingerprint,
  ompWorkspaceFingerprint,
  parseOmpSessionCursor,
  sessionFileInsideRoot,
  type OmpResumeIdentity,
} from "./OmpSessionCursor.ts";

const identity = (overrides: Partial<OmpResumeIdentity> = {}): OmpResumeIdentity => ({
  providerInstanceId: "omp",
  sessionRoot: "/state/omp/thread",
  workspace: "/workspace/project",
  binaryPathFingerprint: ompBinaryFingerprint("/usr/local/bin/omp", "/usr/bin"),
  homeIdentity: "/home/test/.omp/agent",
  profileIdentity: "default",
  ...overrides,
});

describe("Oh My Pi session cursor", () => {
  it("keeps a Scient-managed binary identity across qualified versions", () => {
    const current = ompBinaryFingerprint(
      "/Library/Scient/provider-runtimes/omp/versions/18.2.8/darwin-arm64/omp",
    );
    const next = ompBinaryFingerprint(
      "/Library/Scient/provider-runtimes/omp/versions/18.3.0/darwin-arm64/omp",
    );
    expect(current).toBe(next);
    expect(ompBinaryFingerprint("/usr/local/bin/omp")).not.toBe(current);
  });

  it("keeps a session file inside its directory and rejects lexical escapes", () => {
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

  it.effect("round-trips a cursor only for the complete resume identity", () =>
    Effect.gen(function* () {
      const current = identity();
      const cursor = makeOmpSessionCursor({
        identity: current,
        sessionFile: "/state/omp/thread/session.jsonl",
        sessionId: "session-1",
        ompVersion: "18.2.8",
        rpcProtocolVersion: 2,
      });
      expect(cursor?.stateScopeFingerprint).toBe(ompStateScopeFingerprint(current));
      expect(cursor?.workspaceFingerprint).toBe(ompWorkspaceFingerprint(current.workspace));
      expect(cursor?.homeProfileFingerprint).toBe(
        ompHomeProfileFingerprint(current.homeIdentity, current.profileIdentity),
      );
      expect(cursor?.launchPolicyFingerprint).toBe(ompLaunchPolicyFingerprint());
      expect(
        yield* parseOmpSessionCursor(cursor, {
          identity: current,
          ompVersion: "18.2.8",
          rpcProtocolVersion: 2,
        }),
      ).toMatchObject({ sessionId: "session-1" });
      expect(
        yield* parseOmpSessionCursor(cursor, {
          identity: identity({ providerInstanceId: "omp-other" }),
          ompVersion: "18.2.8",
          rpcProtocolVersion: 2,
        }).pipe(Effect.flip),
      ).toContain("different provider instance");
    }),
  );

  it.effect("refuses changed workspace, home/profile, binary, protocol, and major version", () =>
    Effect.gen(function* () {
      const current = identity();
      const cursor = makeOmpSessionCursor({
        identity: current,
        sessionFile: "/state/omp/thread/session.jsonl",
        ompVersion: "18.2.8",
        rpcProtocolVersion: 2,
      });
      const reject = (changed: OmpResumeIdentity, protocolVersion = 2, version = "18.2.8") =>
        parseOmpSessionCursor(cursor, {
          identity: changed,
          ompVersion: version,
          rpcProtocolVersion: protocolVersion,
        }).pipe(Effect.flip);

      expect(ompMajorCompatible("18.2.8", "18.9.0")).toBe(true);
      expect(ompMajorCompatible("18.2.8", "19.0.0")).toBe(false);
      expect(yield* reject(identity({ workspace: "/workspace/other" }))).toContain("workspace");
      expect(yield* reject(identity({ homeIdentity: "/home/test/.omp/other" }))).toContain(
        "home or profile",
      );
      expect(
        yield* reject(identity({ binaryPathFingerprint: ompBinaryFingerprint("/other/omp") })),
      ).toContain("executable");
      expect(yield* reject(current, 1)).toContain("protocol");
      expect(yield* reject(current, 2, "19.0.0")).toContain("major");
    }),
  );

  it.effect("can defer executable identity until the process resolves it", () =>
    Effect.gen(function* () {
      const current = identity();
      const cursor = makeOmpSessionCursor({
        identity: current,
        sessionFile: "/state/omp/thread/session.jsonl",
        ompVersion: "18.2.8",
        rpcProtocolVersion: 2,
      });
      const unresolved = { ...current, binaryPathFingerprint: "unresolved-command" };
      expect(
        yield* parseOmpSessionCursor(cursor, {
          identity: unresolved,
          rpcProtocolVersion: 2,
          deferBinaryIdentity: true,
        }),
      ).toBeDefined();
      expect(
        yield* parseOmpSessionCursor(cursor, {
          identity: unresolved,
          rpcProtocolVersion: 2,
        }).pipe(Effect.flip),
      ).toContain("executable");
    }),
  );

  it.effect("records a request id without treating it as replay suppression", () =>
    Effect.gen(function* () {
      const current = identity();
      const cursor = makeOmpSessionCursor({
        identity: current,
        sessionFile: "/state/omp/thread/session.jsonl",
        ompVersion: "18.2.8",
        rpcProtocolVersion: 2,
        lastRequestId: "41",
      });
      expect(cursor?.lastRequestId).toBe("41");
      expect(
        yield* parseOmpSessionCursor(cursor, {
          identity: current,
          ompVersion: "18.2.8",
          rpcProtocolVersion: 2,
        }),
      ).toMatchObject({ lastRequestId: "41" });
    }),
  );
});
