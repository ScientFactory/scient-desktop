// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import type { OmpRpcClient, OmpRpcNotification } from "effect-omp-rpc/client";
import type { OmpRpcResponse } from "effect-omp-rpc/schema";

import { makeOmpAdapter } from "./OmpAdapter.ts";
import type { OmpRpcProcessOptions } from "../omp/OmpRpcProcess.ts";

const success = (command: string, data: unknown = {}): OmpRpcResponse => ({
  id: "req",
  type: "response",
  command,
  success: true,
  data,
});

interface Launch {
  readonly binaryPath: string;
  readonly version: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly homePath?: string;
  readonly profile?: string;
}

/**
 * Start a conversation with the first launch, stop it, then resume it with
 * the second launch in the same state directory and workspace.
 */
const resumeAcross = (first: Launch, second: Launch) =>
  Effect.gen(function* () {
    const stateDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "scient-omp-resume-"));
    const switched: string[] = [];
    const makeProcess = (version: string) => (options: OmpRpcProcessOptions) =>
      Effect.gen(function* () {
        const events = yield* Queue.unbounded<OmpRpcNotification>();
        const sessionFile = `${options.sessionDir ?? ""}/session.jsonl`;
        return {
          version,
          ready: Effect.succeed({
            type: "ready" as const,
            protocolVersion: 1,
            supportedProtocolVersions: [1, 2],
            maxFrameBytes: 1_048_576,
            maxReassembledFrameBytes: 67_108_864,
          }),
          events: Stream.fromQueue(events),
          flushEvents: () => Queue.offer(events, { _tag: "Drain" }).pipe(Effect.asVoid),
          command: () => Effect.succeed(success("command")),
          prompt: () => Effect.succeed(success("prompt", { agentInvoked: true })),
          steer: () => Effect.succeed(success("steer")),
          followUp: () => Effect.succeed(success("follow_up")),
          abort: () => Effect.succeed(success("abort")),
          getState: () =>
            Effect.sync(() => {
              NodeFS.mkdirSync(options.sessionDir ?? ".", { recursive: true });
              if (!NodeFS.existsSync(sessionFile)) NodeFS.writeFileSync(sessionFile, "{}\n");
              return {
                sessionFile,
                sessionId: "session-1",
                isStreaming: false,
                isCompacting: false,
              };
            }),
          getModels: () => Effect.succeed({ models: [] }),
          getCommands: () => Effect.succeed({ commands: [] }),
          setModel: () => Effect.succeed(success("set_model")),
          setThinkingLevel: () => Effect.succeed(success("set_thinking_level")),
          compact: () => Effect.succeed(success("compact")),
          switchSession: (sessionPath: string) =>
            Effect.sync(() => {
              switched.push(sessionPath);
              return { cancelled: false };
            }),
          setSubagentSubscription: () => Effect.succeed(success("set_subagent_subscription")),
          setEventFilter: (events) =>
            Effect.succeed({ events: events === null ? null : [...events] }),
          limits: Effect.succeed({
            maxFrameBytes: 1_048_576,
            maxReassembledFrameBytes: 67_108_864,
          }),
          setHostTools: () => Effect.succeed(success("set_host_tools")),
          setHostUriSchemes: () => Effect.succeed(success("set_host_uri_schemes")),
          extensionUiResponse: () => Effect.void,
          hostToolUpdate: () => Effect.void,
          hostToolResult: () => Effect.void,
          hostUriResult: () => Effect.void,
          close: () => Effect.void,
        } satisfies OmpRpcClient & { readonly version: string };
      });
    const adapterFor = (launch: Launch) =>
      makeOmpAdapter({
        binaryPath: launch.binaryPath,
        providerInstanceId: ProviderInstanceId.make("omp"),
        stateDir,
        attachmentsDir: stateDir,
        environment: launch.environment ?? { PATH: "/usr/bin", HOME: "/home/test" },
        homePath: launch.homePath,
        profile: launch.profile,
        makeProcess: makeProcess(launch.version),
      });
    const threadId = ThreadId.make("thread-resume");
    const cwd = NodeOS.tmpdir();
    try {
      const firstAdapter = yield* adapterFor(first);
      const started = yield* firstAdapter.startSession({
        threadId,
        cwd,
        runtimeMode: "full-access",
      });
      yield* firstAdapter.stopAll();
      expect(started.resumeCursor).toBeDefined();
      const secondAdapter = yield* adapterFor(second);
      const resumed = yield* secondAdapter
        .startSession({
          threadId,
          cwd,
          runtimeMode: "full-access",
          resumeCursor: started.resumeCursor,
        })
        .pipe(Effect.exit);
      yield* secondAdapter.stopAll();
      return { resumed, switched };
    } finally {
      NodeFS.rmSync(stateDir, { recursive: true, force: true });
    }
  });

const failureMessage = (exit: Exit.Exit<unknown, { readonly message: string }>) =>
  Exit.isFailure(exit) && exit.cause.reasons[0]?._tag === "Fail"
    ? exit.cause.reasons[0].error.message
    : "";

describe("Oh My Pi resume identity", () => {
  it.effect("resumes after a switch from the system to the Scient-managed executable", () =>
    Effect.gen(function* () {
      const { resumed, switched } = yield* resumeAcross(
        { binaryPath: "/usr/local/bin/omp", version: "18.2.8" },
        {
          binaryPath:
            "/Users/test/.scient-next/provider-runtimes/omp/versions/18.3.1/darwin-arm64/omp",
          version: "18.3.1",
        },
      );
      expect(Exit.isSuccess(resumed)).toBe(true);
      expect(switched).toHaveLength(1);
      expect(switched[0]).toMatch(/session\.jsonl$/u);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("resumes across a Homebrew upgrade that changes the versioned keg path", () =>
    Effect.gen(function* () {
      const { resumed } = yield* resumeAcross(
        { binaryPath: "/opt/homebrew/Cellar/omp/18.2.8/bin/omp", version: "18.2.8" },
        { binaryPath: "/opt/homebrew/Cellar/omp/18.3.1/bin/omp", version: "18.3.1" },
      );
      expect(Exit.isSuccess(resumed)).toBe(true);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("does not conflate custom /opt installs: identity is home, profile and workspace", () =>
    Effect.gen(function* () {
      // Session files live in Scient's own per-conversation directory, so two
      // custom installs under /opt share a conversation only when everything
      // that locates OMP's state matches.
      const same = yield* resumeAcross(
        { binaryPath: "/opt/company/production/omp", version: "18.2.8" },
        { binaryPath: "/opt/company/testing/omp", version: "18.2.8" },
      );
      expect(Exit.isSuccess(same.resumed)).toBe(true);
      const otherHome = yield* resumeAcross(
        { binaryPath: "/opt/company/production/omp", version: "18.2.8" },
        { binaryPath: "/opt/company/testing/omp", version: "18.2.8", homePath: "/srv/omp-testing" },
      );
      expect(failureMessage(otherHome.resumed)).toContain("different home or profile");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("R2-F6 treats a ~ home and its absolute path as the same home", () =>
    Effect.gen(function* () {
      const tilde = "~/.omp-scient-resume-home";
      const absolute = NodePath.join(NodeOS.homedir(), ".omp-scient-resume-home");
      const forward = yield* resumeAcross(
        { binaryPath: "omp", version: "18.2.8", homePath: tilde },
        { binaryPath: "omp", version: "18.2.8", homePath: absolute },
      );
      expect(Exit.isSuccess(forward.resumed)).toBe(true);
      const backward = yield* resumeAcross(
        { binaryPath: "omp", version: "18.2.8", homePath: absolute },
        { binaryPath: "omp", version: "18.2.8", homePath: tilde },
      );
      expect(Exit.isSuccess(backward.resumed)).toBe(true);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("refuses a different home or profile", () =>
    Effect.gen(function* () {
      const home = yield* resumeAcross(
        { binaryPath: "omp", version: "18.2.8", homePath: "/home/test/.omp-a" },
        { binaryPath: "omp", version: "18.2.8", homePath: "/home/test/.omp-b" },
      );
      expect(failureMessage(home.resumed)).toContain("different home or profile");
      const profile = yield* resumeAcross(
        { binaryPath: "omp", version: "18.2.8", profile: "work" },
        { binaryPath: "omp", version: "18.2.8", profile: "personal" },
      );
      expect(failureMessage(profile.resumed)).toContain("different home or profile");
      expect(profile.switched).toEqual([]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("refuses a different Oh My Pi major version", () =>
    Effect.gen(function* () {
      const { resumed, switched } = yield* resumeAcross(
        { binaryPath: "omp", version: "18.2.8" },
        { binaryPath: "omp", version: "19.0.0" },
      );
      expect(failureMessage(resumed)).toContain("different major version");
      expect(switched).toEqual([]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
