import type { ProviderRuntimeEvent } from "@t3tools/contracts";
import type { OmpRpcNotification } from "effect-omp-rpc/client";
import { OmpAgentMessage } from "effect-omp-rpc/schema";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

const decodeMessages = Schema.decodeUnknownOption(Schema.Array(OmpAgentMessage));
const decodeContent = Schema.decodeUnknownOption(
  Schema.Array(Schema.Struct({ type: Schema.String, text: Schema.optional(Schema.String) })),
);

/** Subscribe before sending a prompt; a failed or closed stream must never count as success. */
export const watchRpcTextTurn = Effect.fnUntraced(function* <E>(
  events: Stream.Stream<OmpRpcNotification, E>,
) {
  const terminal = yield* Deferred.make<string, Error>();
  const fail = (message: string) => Deferred.fail(terminal, new Error(message));
  yield* events.pipe(
    Stream.runForEach((notification) => {
      if (notification._tag === "ProtocolFailure") return fail("RPC protocol failure.");
      if (
        notification._tag === "AsyncCommandFailure" ||
        notification._tag === "CommandParseFailure"
      )
        return fail("RPC command failed.");
      if (notification._tag !== "Event") return Effect.void;
      const event = notification.event;
      if (event.type === "prompt_result" && ["error", "aborted"].includes(event.status ?? "")) {
        return fail(`RPC prompt ${event.status}.`);
      }
      if (event.type !== "agent_end" || event.isTerminal === false || event.yielded === false) {
        return Effect.void;
      }
      const messages = decodeMessages(event.messages);
      const assistant = Option.isSome(messages)
        ? messages.value.findLast((message) => message.role === "assistant")
        : undefined;
      if (assistant?.stopReason !== "stop" || assistant.isError === true) {
        return fail("RPC ended without a successful assistant answer.");
      }
      const content = decodeContent(assistant.content);
      if (Option.isNone(content)) return fail("RPC answer has no readable text content.");
      return Deferred.succeed(
        terminal,
        content.value
          .filter((part) => part.type === "text")
          .map((part) => part.text ?? "")
          .join(""),
      );
    }),
    Effect.andThen(() => fail("RPC stream ended before a successful turn.")),
    Effect.catchCause(() => fail("RPC stream failed before a successful turn.")),
    Effect.forkScoped,
  );
  return Deferred.await(terminal);
});

export const watchAdapterTextTurn = Effect.fnUntraced(function* <E>(
  events: Stream.Stream<ProviderRuntimeEvent, E>,
) {
  const terminal = yield* Deferred.make<string, Error>();
  let text = "";
  yield* events.pipe(
    Stream.runForEach((event) => {
      if (event.type === "content.delta" && event.payload.streamKind === "assistant_text") {
        text += event.payload.delta;
      }
      if (event.type === "turn.completed") {
        return event.payload.state === "completed"
          ? Deferred.succeed(terminal, text)
          : Deferred.fail(terminal, new Error(`Adapter turn ${event.payload.state}.`));
      }
      if (["turn.aborted", "runtime.error", "session.exited"].includes(event.type)) {
        return Deferred.fail(terminal, new Error(`Adapter emitted ${event.type}.`));
      }
      return Effect.void;
    }),
    Effect.andThen(() =>
      Deferred.fail(terminal, new Error("Adapter stream ended before completion.")),
    ),
    Effect.catchCause(() =>
      Deferred.fail(terminal, new Error("Adapter stream failed before completion.")),
    ),
    Effect.forkScoped,
  );
  return Deferred.await(terminal);
});
