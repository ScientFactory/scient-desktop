import { describe, expect, it, vi } from "@effect/vitest";

import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { NodeServices } from "@effect/platform-node";
import { makeOmpExecutableGate, OmpExecutableGate } from "../../provider/omp/OmpExecutableGate.ts";
import * as Commands from "./ProviderPluginCommand.ts";

import { chatGptAppRows, readScientAgentChatGptApps } from "./ScientAgentChatGptApps.ts";

describe("chatGptAppRows", () => {
  it("reports each connected app with its ChatGPT page", () => {
    const output = JSON.stringify({
      apps: [
        {
          id: "connector_2128aebfecb84f64a069897515042a44",
          name: "Gmail",
          description: "Gmail tools",
          tools: 21,
          readOnlyTools: 10,
        },
        { id: "connector_947e0d954944416db111db556030eea6", name: "Google Calendar", tools: 15 },
      ],
    });
    expect(chatGptAppRows(`starting\n${output}\n`)).toEqual([
      {
        name: "Gmail",
        scope: "chatgpt",
        status: "connected",
        toolCount: 21,
        connectUrl: "https://chatgpt.com/apps/gmail/connector_2128aebfecb84f64a069897515042a44",
        signedIn: true,
      },
      {
        name: "Google Calendar",
        scope: "chatgpt",
        status: "connected",
        toolCount: 15,
        connectUrl:
          "https://chatgpt.com/apps/google-calendar/connector_947e0d954944416db111db556030eea6",
        signedIn: true,
      },
    ]);
  });

  it("distinguishes signed out and empty apps from unreadable output", () => {
    expect(chatGptAppRows(JSON.stringify({ error: { kind: "signed-out" } }))).toEqual([]);
    expect(
      chatGptAppRows(JSON.stringify({ apps: [{ id: "bad id", name: "X", tools: 1 }] })),
    ).toBeUndefined();
    expect(chatGptAppRows("")).toBeUndefined();
    expect(chatGptAppRows(JSON.stringify({ apps: [] }))).toEqual([]);
    expect(chatGptAppRows(JSON.stringify({ error: { kind: "unavailable" } }))).toBeUndefined();
  });
});

describe("ChatGPT app links", () => {
  it.each([
    ["Research & Papers", "research---papers"],
    ["★ Gmail", "gmail"],
    ["!&★", "app"],
  ])("builds the app page for %s", (name, slug) => {
    expect(
      chatGptAppRows(JSON.stringify({ apps: [{ id: "app_id", name, tools: 1 }] }))?.[0]?.connectUrl,
    ).toBe(`https://chatgpt.com/apps/${slug}/app_id`);
  });
});

const runtimeInfo = JSON.stringify({
  product: "scient-agent",
  version: "0.1.10",
  upstream: { name: "oh-my-pi", version: "18.3.1" },
  rpcProtocolVersions: [2],
  hostCommands: ["apps"],
});

describe("readScientAgentChatGptApps", () => {
  it.effect(
    "returns empty apps only for an empty or signed-out answer, and fails on read errors",
    () =>
      Effect.gen(function* () {
        const gate = yield* makeOmpExecutableGate();
        for (const output of [
          '{"apps":[]}',
          '{"error":{"kind":"signed-out"}}',
          '{"error":{"kind":"unavailable"}}',
          "invalid",
        ]) {
          using _command = vi
            .spyOn(Commands, "runProviderPluginCommand")
            .mockImplementation((_exe, _env, _cwd, args, options) => {
              if (args[0] === "--runtime-info") return Effect.succeed(runtimeInfo);
              expect(options?.acceptNonZeroExit).toBe(true);
              return Effect.succeed(output);
            });
          const result = yield* readScientAgentChatGptApps(process.execPath, {}, "/tmp").pipe(
            Effect.provideService(OmpExecutableGate, gate),
            Effect.result,
          );
          expect(result._tag).toBe(
            output.includes('"apps"') || output.includes('"signed-out"') ? "Success" : "Failure",
          );
          if (result._tag === "Success") expect(result.success).toEqual([]);
        }
        using _command = vi
          .spyOn(Commands, "runProviderPluginCommand")
          .mockImplementation((_exe, _env, _cwd, args) =>
            args[0] === "--runtime-info"
              ? Effect.succeed(runtimeInfo)
              : Effect.fail({ message: "unreachable" }),
          );
        expect(
          (yield* readScientAgentChatGptApps(process.execPath, {}, "/tmp").pipe(
            Effect.provideService(OmpExecutableGate, gate),
            Effect.result,
          ))._tag,
        ).toBe("Failure");
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("times out without replacing a known app publication", () =>
    Effect.gen(function* () {
      const gate = yield* makeOmpExecutableGate();
      const started = yield* Deferred.make<void>();
      using _command = vi
        .spyOn(Commands, "runProviderPluginCommand")
        .mockImplementation((_exe, _env, _cwd, args) =>
          args[0] === "--runtime-info"
            ? Effect.succeed(runtimeInfo)
            : Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
        );
      let published: ReadonlyArray<import("@t3tools/contracts").ServerProviderMcpServer> = [
        { name: "Gmail", status: "connected" },
      ];
      const read = yield* readScientAgentChatGptApps(process.execPath, {}, "/tmp").pipe(
        Effect.provideService(OmpExecutableGate, gate),
        Effect.tap((apps) =>
          Effect.sync(() => {
            published = [...apps];
          }),
        ),
        Effect.result,
        Effect.forkChild,
      );
      yield* Deferred.await(started);
      yield* TestClock.adjust("90 seconds");
      expect((yield* Fiber.join(read))._tag).toBe("Failure");
      expect(published).toEqual([{ name: "Gmail", status: "connected" }]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
