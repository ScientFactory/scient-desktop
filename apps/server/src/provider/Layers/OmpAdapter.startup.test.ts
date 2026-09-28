// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { ProviderInstanceId, ThreadId, type ProviderRuntimeEvent } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { makeOmpRpcClient } from "effect-omp-rpc/client";
import { OMP_KNOWN_EVENT_TYPES } from "effect-omp-rpc/schema";

import {
  makeOmpScriptedWire,
  type OmpReplayResponder,
} from "../omp/OmpCaptureReplay.testFixtures.ts";
import type { OmpRpcProcessOptions } from "../omp/OmpRpcProcess.ts";
import { makeOmpAdapter } from "./OmpAdapter.ts";

type Frame = Record<string, unknown>;

/**
 * An adapter whose processes are real clients over scripted stdio. Each
 * launch reports `version` and answers commands through `respond`; get_state
 * reports a session file inside Scient's session directory so a cursor is
 * written.
 */
const makeAdapter = (
  stateDir: string,
  version: string,
  respond: OmpReplayResponder = () => undefined,
) => {
  const written: Array<Frame> = [];
  return makeOmpAdapter({
    binaryPath: "omp",
    providerInstanceId: ProviderInstanceId.make("omp"),
    stateDir,
    attachmentsDir: stateDir,
    environment: {},
    makeProcess: (options: OmpRpcProcessOptions) =>
      Effect.gen(function* () {
        const sessionFile = NodePath.join(options.sessionDir ?? stateDir, "session.jsonl");
        const wire = yield* makeOmpScriptedWire((command) => {
          written.push(command);
          const custom = respond(command);
          if (custom !== undefined || command.type !== "get_state") return custom;
          NodeFS.writeFileSync(sessionFile, "{}\n");
          return {
            type: "response",
            id: command.id,
            command: "get_state",
            success: true,
            data: { sessionFile, sessionId: "startup-session", isStreaming: false },
          };
        });
        const client = yield* makeOmpRpcClient(wire.io);
        return { ...client, version };
      }),
  }).pipe(Effect.map((adapter) => ({ adapter, written })));
};

const tempStateDir = () =>
  NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "scient-omp-startup-"));

const warnings = (events: ReadonlyArray<ProviderRuntimeEvent>) =>
  events.filter((event) => event.type === "runtime.warning" || event.type === "runtime.error");

describe("Oh My Pi session startup", () => {
  it.effect("exposes native identity even before OMP creates its transcript", () =>
    Effect.gen(function* () {
      const stateDir = tempStateDir();
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => NodeFS.rmSync(stateDir, { recursive: true, force: true })),
      );
      const { adapter } = yield* makeAdapter(stateDir, "18.3.1", (command) =>
        command.type === "get_state"
          ? {
              type: "response",
              id: command.id,
              command: "get_state",
              success: true,
              data: { sessionId: "allocated-before-transcript", isStreaming: false },
            }
          : undefined,
      );
      const session = yield* adapter.startSession({
        threadId: ThreadId.make("delayed-transcript"),
        cwd: stateDir,
        runtimeMode: "full-access",
      });
      expect(session.nativeSessionId).toBe("allocated-before-transcript");
      expect(session.resumeCursor).toBeUndefined();
      expect((yield* adapter.listSessions())[0]?.nativeSessionId).toBe(session.nativeSessionId);
      yield* adapter.stopAll();
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("pins the known event set on OMP 18.3.1", () =>
    Effect.gen(function* () {
      const { adapter, written } = yield* makeAdapter(tempStateDir(), "18.3.1");
      yield* adapter.startSession({
        threadId: ThreadId.make("filter-pinned"),
        cwd: NodeOS.tmpdir(),
        runtimeMode: "full-access",
      });
      expect(written.filter((command) => command.type === "set_event_filter")).toMatchObject([
        { events: [...OMP_KNOWN_EVENT_TYPES] },
      ]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("a rejected event filter leaves the session healthy and quiet", () =>
    Effect.gen(function* () {
      const { adapter, written } = yield* makeAdapter(tempStateDir(), "18.3.1", (command) =>
        command.type === "set_event_filter"
          ? {
              type: "response",
              id: command.id,
              command: "set_event_filter",
              success: false,
              error: "Unknown command: set_event_filter",
            }
          : undefined,
      );
      const events = yield* Queue.unbounded<ProviderRuntimeEvent>();
      yield* adapter.streamEvents.pipe(
        Stream.runForEach((event) => Queue.offer(events, event)),
        Effect.forkScoped,
      );
      const threadId = ThreadId.make("filter-rejected");
      const session = yield* adapter.startSession({
        threadId,
        cwd: NodeOS.tmpdir(),
        runtimeMode: "full-access",
      });
      expect(session.status).toBe("ready");
      expect(written.some((command) => command.type === "set_event_filter")).toBe(true);
      expect(yield* adapter.hasSession(threadId)).toBe(true);
      expect(warnings(yield* Queue.clear(events))).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("never sends the event filter to a release that predates it", () =>
    Effect.gen(function* () {
      // OMP 18.2.8 answers an unknown command without a request id, which
      // the client must treat as a protocol violation.
      const { adapter, written } = yield* makeAdapter(tempStateDir(), "18.2.8", (command) =>
        command.type === "set_event_filter"
          ? {
              type: "response",
              command: "set_event_filter",
              success: false,
              error: "Unknown command: set_event_filter",
            }
          : undefined,
      );
      const threadId = ThreadId.make("filter-old");
      yield* adapter.startSession({ threadId, cwd: NodeOS.tmpdir(), runtimeMode: "full-access" });
      expect(written.some((command) => command.type === "set_event_filter")).toBe(false);
      expect(yield* adapter.hasSession(threadId)).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("a resume whose switch_session never answers fails at the startup deadline", () =>
    Effect.gen(function* () {
      const stateDir = tempStateDir();
      const threadId = ThreadId.make("stuck-resume");
      const first = yield* makeAdapter(stateDir, "18.3.1");
      const started = yield* first.adapter.startSession({
        threadId,
        cwd: NodeOS.tmpdir(),
        runtimeMode: "full-access",
      });
      yield* first.adapter.stopAll();
      expect(started.resumeCursor).toBeDefined();

      const stuck = yield* makeAdapter(stateDir, "18.3.1", (command) =>
        command.type === "switch_session" ? "silent" : undefined,
      );
      const resuming = yield* stuck.adapter
        .startSession({
          threadId,
          cwd: NodeOS.tmpdir(),
          runtimeMode: "full-access",
          resumeCursor: started.resumeCursor,
        })
        .pipe(Effect.exit, Effect.forkScoped);
      for (
        let waited = 0;
        waited < 200 && !stuck.written.some((command) => command.type === "switch_session");
        waited += 1
      ) {
        yield* Effect.sleep("10 millis").pipe(TestClock.withLive);
      }
      // Well short of the client's 10-minute switch_session deadline.
      yield* TestClock.adjust("2 minutes");
      const resumed = yield* Fiber.join(resuming);
      expect(Exit.isFailure(resumed)).toBe(true);
      expect(String(Exit.isFailure(resumed) ? resumed.cause : "")).toContain(
        "did not finish starting within 2 minutes",
      );
      expect(stuck.written.some((command) => command.type === "switch_session")).toBe(true);
      // The failed start released its lock: a fresh start succeeds.
      const retried = yield* stuck.adapter.startSession({
        threadId,
        cwd: NodeOS.tmpdir(),
        runtimeMode: "full-access",
      });
      expect(retried.status).toBe("ready");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
