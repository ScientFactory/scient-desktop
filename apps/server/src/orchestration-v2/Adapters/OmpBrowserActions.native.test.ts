// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type { OmpRpcFrameTrace } from "effect-omp-rpc/client";
import { ompTarget } from "../../provider/omp/OmpTarget.ts";
import { nativeOmpSession } from "../../provider/testUtils/nativeOmpSession.ts";
import { scriptedOmpRpc } from "../../provider/testUtils/scriptedOmpRpc.ts";
import type { ProviderAdapterV2Event } from "@t3tools/provider-core/server/ProviderAdapter";

const encodeJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
it.live(
  "scrubs browser URLs in native instructions and diagnostic logs without changing authored text",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = NodeFS.mkdtempSync(
          NodePath.join(NodeOS.tmpdir(), "scient-omp-browser-native-"),
        );
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true })),
        );
        const instanceId = ProviderInstanceId.make("native-browser-instance");
        const peer = scriptedOmpRpc({ models: [], initial: { provider: "test", id: "selected" } });
        const logs: unknown[] = [];
        let frameTrace: ((trace: OmpRpcFrameTrace) => Effect.Effect<void>) | undefined;
        const session = yield* nativeOmpSession({
          root,
          stateDir: NodePath.join(root, "state"),
          attachmentsDir: NodePath.join(root, "attachments"),
          target: ompTarget,
          instanceId,
          threadId: ThreadId.make("native-browser-thread"),
          binaryPath: "synthetic-omp",
          environment: { HOME: root },
          modelSelection: { instanceId, model: "test/selected" },
          makeProcess: (options) => {
            frameTrace = options.onFrame;
            return peer.makeProcess(options);
          },
          nativeEventLogger: {
            filePath: "synthetic-browser-log",
            write: (value) =>
              Effect.sync(() => {
                logs.push(value);
              }),
            close: () => Effect.void,
          },
        });
        const events: ProviderAdapterV2Event[] = [];
        const queue = yield* Queue.unbounded<ProviderAdapterV2Event>();
        yield* session.events.pipe(
          Stream.runForEach((event) =>
            Effect.sync(() => events.push(event)).pipe(Effect.andThen(Queue.offer(queue, event))),
          ),
          Effect.forkScoped,
        );
        const take = (predicate: (event: ProviderAdapterV2Event) => boolean) =>
          Effect.gen(function* () {
            while (true) {
              const event = yield* Queue.take(queue);
              if (predicate(event)) return event;
            }
          }).pipe(Effect.timeout("3 seconds"));
        // The RPC decoder currently traces only response/ready frames. Exercise the
        // configured raw-frame callback explicitly, then send the same browser frame
        // through JSONL to qualify the interpreted notification and canonical item.
        const browser = (frame: OmpRpcFrameTrace["frame"]) =>
          Effect.suspend(() => {
            if (!frameTrace) return Effect.die("Native frame logger is not configured");
            return frameTrace({ direction: "inbound", frame }).pipe(
              Effect.andThen(peer.emit([frame])),
            );
          });
        yield* session.start({ text: "Open the browser" });
        yield* peer.promptDelivered();
        yield* peer.emit([{ type: "agent_start" }]);
        yield* browser({
          type: "extension_ui_request",
          method: "open_url",
          url: "https://user:password@example.com/authorize?state=oauth-state#fragment",
          launchUrl: "http://127.0.0.1:43199/launch?code=launch-code#private",
          instructions:
            "Open https://user:password@example.com/authorize?code=instruction-code#instruction-fragment then wait for browser approval.",
        });
        const receipt = yield* take(
          (event) =>
            event.type === "turn_item.updated" &&
            event.turnItem.type === "dynamic_tool" &&
            event.turnItem.title === "Oh My Pi requests a URL",
        );
        if (receipt.type !== "turn_item.updated" || receipt.turnItem.type !== "dynamic_tool")
          return yield* Effect.die("Missing browser receipt");
        expect(receipt.turnItem.input).toEqual({
          kind: "open-url",
          url: "https://example.com/authorize",
          launchUrl: "http://127.0.0.1:43199/launch",
        });
        expect(receipt.turnItem.output).toBe(
          "Open https://example.com/authorize then wait for browser approval.",
        );
        expect(logs.some((record) => encodeJson(record).includes("extension_ui_request"))).toBe(
          true,
        );
        const persisted = encodeJson({ events, logs });
        for (const secret of [
          "user:password",
          "oauth-state",
          "#fragment",
          "launch-code",
          "#private",
          "instruction-code",
          "instruction-fragment",
        ])
          expect(persisted.includes(secret), secret).toBe(false);
        const punctuated =
          "https://example.com/authorize?state=left(right)&code=browser-code-canary#browser-fragment-canary";
        yield* browser({
          type: "extension_ui_request",
          method: "open_url",
          url: punctuated,
          launchUrl: punctuated,
          instructions: `Open ${punctuated} then wait. פתיחה ☃`,
        });
        const punctuationReceipt = yield* take(
          (event) =>
            event.type === "turn_item.updated" &&
            event.turnItem.type === "dynamic_tool" &&
            event.turnItem.id !== receipt.turnItem.id &&
            event.turnItem.title === "Oh My Pi requests a URL",
        );
        if (
          punctuationReceipt.type !== "turn_item.updated" ||
          punctuationReceipt.turnItem.type !== "dynamic_tool"
        )
          return yield* Effect.die("Missing punctuation browser receipt");
        expect(punctuationReceipt.turnItem.input).toEqual({
          kind: "open-url",
          url: "https://example.com/authorize",
          launchUrl: "https://example.com/authorize",
        });
        expect(punctuationReceipt.turnItem.output).toBe(
          "Open https://example.com/authorize then wait. פתיחה ☃",
        );
        const publicUrl = "https://example.com/authorize(public)";
        yield* browser({
          type: "extension_ui_request",
          method: "open_url",
          url: publicUrl,
          launchUrl: publicUrl,
          instructions: `Open ${publicUrl} then wait. פתיחה ☃`,
        });
        const publicReceipt = yield* take(
          (event) =>
            event.type === "turn_item.updated" &&
            event.turnItem.type === "dynamic_tool" &&
            event.turnItem.id !== receipt.turnItem.id &&
            event.turnItem.id !== punctuationReceipt.turnItem.id &&
            event.turnItem.title === "Oh My Pi requests a URL",
        );
        if (
          publicReceipt.type !== "turn_item.updated" ||
          publicReceipt.turnItem.type !== "dynamic_tool"
        )
          return yield* Effect.die("Missing public browser receipt");
        expect(publicReceipt.turnItem.input).toEqual({
          kind: "open-url",
          url: publicUrl,
          launchUrl: publicUrl,
        });
        expect(publicReceipt.turnItem.output).toBe(`Open ${publicUrl} then wait. פתיחה ☃`);
        for (const secret of ["left(right)", "browser-code-canary", "browser-fragment-canary"])
          expect(encodeJson({ events, logs }).includes(secret), secret).toBe(false);
        for (const kind of ["response", "notification"]) {
          const browserLogs = logs.filter((record) => {
            if (typeof record !== "object" || record === null || !("event" in record)) return false;
            const event = record.event;
            return (
              typeof event === "object" &&
              event !== null &&
              "kind" in event &&
              event.kind === kind &&
              "method" in event &&
              event.method === "extension_ui_request"
            );
          });
          expect(browserLogs, kind).toHaveLength(3);
          expect(encodeJson(browserLogs)).toContain(publicUrl);
          expect(encodeJson(browserLogs)).toContain("פתיחה ☃");
          for (const secret of ["left(right)", "browser-code-canary", "browser-fragment-canary"])
            expect(encodeJson(browserLogs).includes(secret), `${kind}: ${secret}`).toBe(false);
        }
        expect(peer.state.frames.some((frame) => frame.type === "extension_ui_response")).toBe(
          false,
        );
        const authored =
          "A source link https://example.com/paper?version=2#figure belongs to the answer.";
        yield* peer.emit([
          {
            type: "message_end",
            message: { role: "assistant", content: [{ type: "text", text: authored }] },
          },
        ]);
        const answer = yield* take(
          (event) =>
            event.type === "message.updated" &&
            event.message.role === "assistant" &&
            event.message.text === authored,
        );
        expect(answer.type).toBe("message.updated");
        yield* peer.finish();
        expect(yield* take((event) => event.type === "turn.terminal")).toMatchObject({
          status: "completed",
        });
        yield* session.close;
      }),
    ).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, McpProviderSessions.layer))),
);
