// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  makeOmpSessionCursor,
  ompHomeProfileFingerprint,
  ompLaunchPolicyFingerprint,
  ompMajorCompatible,
  ompStateScopeFingerprint,
  ompWorkspaceFingerprint,
  parseOmpSessionCursor,
  sessionFileInsideRoot,
  type OmpResumeIdentity,
} from "./OmpSessionCursor.ts";
import { ompTarget } from "./OmpTarget.ts";

const identity = (overrides: Partial<OmpResumeIdentity> = {}): OmpResumeIdentity => ({
  providerInstanceId: "omp",
  sessionRoot: "/state/omp/thread",
  workspace: "/workspace/project",
  homeIdentity: "/home/test/.omp/agent",
  profileIdentity: "default",
  ...overrides,
});

describe("Oh My Pi session cursor", () => {
  it("keeps no executable identity in the cursor", () => {
    const cursor = makeOmpSessionCursor({
      target: ompTarget,
      identity: identity(),
      sessionFile: "/state/omp/thread/session.jsonl",
      ompVersion: "18.2.8",
      rpcProtocolVersion: 2,
    });
    expect(cursor?.schemaVersion).toBe(4);
    expect(cursor).not.toHaveProperty("binaryPathFingerprint");
  });

  it.effect("rejects unverifiable legacy cursor identity", () =>
    Effect.gen(function* () {
      const cursor = makeOmpSessionCursor({
        target: ompTarget,
        identity: identity(),
        sessionFile: "/state/omp/thread/session.jsonl",
        ompVersion: "18.2.8",
        rpcProtocolVersion: 2,
      });
      if (!cursor) throw new Error("Expected a cursor fixture.");
      const legacy = { ...cursor, schemaVersion: 2 as const, binaryPathFingerprint: "path-hash" };
      expect(
        yield* parseOmpSessionCursor(legacy, {
          target: ompTarget,
          identity: identity(),
          ompVersion: "18.2.8",
          rpcProtocolVersion: 2,
        }).pipe(Effect.flip),
      ).toContain("older identity format");
    }),
  );

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
        target: ompTarget,
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
          target: ompTarget,
          identity: current,
          ompVersion: "18.2.8",
          rpcProtocolVersion: 2,
        }),
      ).toMatchObject({ sessionId: "session-1" });
      expect(
        yield* parseOmpSessionCursor(cursor, {
          target: ompTarget,
          identity: identity({ providerInstanceId: "omp-other" }),
          ompVersion: "18.2.8",
          rpcProtocolVersion: 2,
        }).pipe(Effect.flip),
      ).toContain("different provider instance");
    }),
  );

  it.effect("refuses changed workspace, home/profile, protocol, and major version", () =>
    Effect.gen(function* () {
      const current = identity();
      const cursor = makeOmpSessionCursor({
        target: ompTarget,
        identity: current,
        sessionFile: "/state/omp/thread/session.jsonl",
        ompVersion: "18.2.8",
        rpcProtocolVersion: 2,
      });
      const reject = (changed: OmpResumeIdentity, protocolVersion = 2, version = "18.2.8") =>
        parseOmpSessionCursor(cursor, {
          target: ompTarget,
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
      expect(yield* reject(identity({ profileIdentity: "work" }))).toContain("home or profile");
      expect(yield* reject(current, 1)).toContain("protocol");
      expect(yield* reject(current, 2, "19.0.0")).toContain("major");
    }),
  );

  it.effect(
    "migrates a v3 cursor whose recorded scope still matches, and refuses one that does not",
    () =>
      Effect.gen(function* () {
        const current = identity();
        const v4 = makeOmpSessionCursor({
          target: ompTarget,
          identity: current,
          sessionFile: "/state/omp/thread/session.jsonl",
          sessionId: "session-1",
          ompVersion: "18.2.8",
          rpcProtocolVersion: 2,
        });
        if (!v4) throw new Error("Expected a cursor fixture.");
        // v3 folded its recorded executable fingerprint into the scope hash.
        const executable = "managed-omp-path-hash";
        const v3Scope = (scope: OmpResumeIdentity) =>
          NodeCrypto.createHash("sha256")
            .update(
              [
                scope.providerInstanceId,
                NodePath.resolve(scope.sessionRoot),
                NodePath.resolve(scope.workspace),
                executable,
                scope.homeIdentity,
                scope.profileIdentity,
                "rpc-v2;approval-mode=yolo;session-dir=explicit",
              ].join("\0"),
            )
            .digest("hex");
        const v3 = {
          ...v4,
          schemaVersion: 3 as const,
          binaryPathFingerprint: executable,
          stateScopeFingerprint: v3Scope(current),
        };
        const migrated = yield* parseOmpSessionCursor(v3, {
          target: ompTarget,
          identity: current,
          rpcProtocolVersion: 2,
        });
        expect(migrated).toEqual(v4);

        // A v3 record for another session directory cannot be verified.
        const foreign = {
          ...v3,
          stateScopeFingerprint: v3Scope({ ...current, sessionRoot: "/state/omp/other" }),
        };
        expect(
          yield* parseOmpSessionCursor(foreign, {
            target: ompTarget,
            identity: current,
            rpcProtocolVersion: 2,
          }).pipe(Effect.flip),
        ).toContain("older identity format");
      }),
  );

  it.effect("records a request id without treating it as replay suppression", () =>
    Effect.gen(function* () {
      const current = identity();
      const cursor = makeOmpSessionCursor({
        target: ompTarget,
        identity: current,
        sessionFile: "/state/omp/thread/session.jsonl",
        ompVersion: "18.2.8",
        rpcProtocolVersion: 2,
        lastRequestId: "41",
      });
      expect(cursor?.lastRequestId).toBe("41");
      expect(
        yield* parseOmpSessionCursor(cursor, {
          target: ompTarget,
          identity: current,
          ompVersion: "18.2.8",
          rpcProtocolVersion: 2,
        }),
      ).toMatchObject({ lastRequestId: "41" });
    }),
  );
});
