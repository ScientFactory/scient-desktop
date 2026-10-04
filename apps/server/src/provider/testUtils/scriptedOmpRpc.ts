// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { makeOmpRpcClient } from "effect-omp-rpc/client";
import {
  makeOmpRedaction,
  type OmpProcessExit,
  type OmpRpcProcessOptions,
} from "../omp/OmpRpcProcess.ts";
const encodeJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

interface FakeModel {
  readonly provider: string;
  readonly id: string;
  readonly reasoning?: boolean;
  readonly contextWindow?: number | null;
  readonly input?: ReadonlyArray<string>;
  readonly thinking?: {
    readonly mode?: string;
    readonly efforts?: ReadonlyArray<string>;
    readonly defaultLevel?: string;
  };
}

interface Frame {
  readonly id?: string;
  readonly type: string;
  readonly provider?: string;
  readonly modelId?: string;
  readonly level?: string;
  readonly message?: string;
  readonly events?: ReadonlyArray<string> | null;
  readonly confirmed?: boolean;
  readonly value?: string;
  readonly cancelled?: boolean;
  readonly isError?: boolean;
  readonly images?: ReadonlyArray<{ readonly data: string; readonly mimeType: string }>;
}

const cleanExit: OmpProcessExit = { code: 0, forced: false, stderrTail: "" };

/**
 * A scripted Oh My Pi behind the real RPC client. set_model re-applies the
 * model's default level, as OMP does; set_thinking_level may clamp.
 */
export const scriptedOmpRpc = (input: {
  readonly models: ReadonlyArray<FakeModel>;
  readonly initial: { readonly provider: string; readonly id: string; readonly level?: string };
  /** Registered only when the bridge's refreshModels runs. */
  readonly lateModels?: ReadonlyArray<FakeModel>;
  readonly maxFrameBytes?: number;
  readonly version?: string;
  readonly environment?: Readonly<Record<string, string>>;
  readonly eventFilterError?: string;
  readonly commandError?: (frame: Frame) => string | undefined;
  readonly readyDelay?: Effect.Effect<void>;
  readonly supportedProtocolVersions?: ReadonlyArray<number>;
  readonly switchCancelled?: boolean;
  readonly promptError?: string;
  readonly modelsError?: string;
  readonly modelsResponse?: unknown;
  readonly reportThinkingLevel?: () => boolean;
  /** What OMP really applies per `provider/id`, when it differs from the advertised efforts. */
  readonly clamp?: Readonly<Record<string, Readonly<Record<string, string>>>>;
  readonly setModelError?: (provider: string, modelId: string) => string | undefined;
  readonly setThinkingLevelError?: (level: string) => string | undefined;
  /** Frames OMP writes before answering a command, such as a racing wake-up. */
  readonly beforeReply?: (frame: Frame) => ReadonlyArray<Record<string, unknown>>;
  /** Holds a command's answer until the returned effect completes. */
  readonly holdReply?: (frame: Frame) => Effect.Effect<void>;
  readonly silentReply?: (frame: Frame) => boolean;
  /** OMP selects another model than the one requested (a fallback). */
  readonly substitute?: Readonly<
    Record<string, { readonly provider: string; readonly id: string }>
  >;
}) => {
  let finish: Effect.Effect<void> = Effect.void;
  let promptDelivered: Effect.Effect<void> = Effect.void;
  let emit: (frames: ReadonlyArray<unknown>) => Effect.Effect<void> = () => Effect.void;
  let close: Effect.Effect<void> = Effect.void;
  let raw: (text: string) => Effect.Effect<void> = () => Effect.void;
  let lastPromptId: string | undefined;
  const state = {
    models: [...input.models],
    modelsError: input.modelsError,
    modelsResponse: input.modelsResponse,
    model: { provider: input.initial.provider, id: input.initial.id },
    thinkingLevel: input.initial.level ?? "off",
    log: [] as Array<string>,
    prompts: [] as Array<{ readonly frame: Frame; readonly bytes: number }>,
    pendingAsyncWork: false,
    sessionOrdinal: 0,
    frames: [] as Array<Frame>,
    shutdowns: 0,
    sessionFile: undefined as string | undefined,
  };
  const find = (provider: string, id: string) =>
    state.models.find((model) => model.provider === provider && model.id === id);
  const makeProcess = (options: OmpRpcProcessOptions) =>
    Effect.gen(function* () {
      const sessionDir = options.sessionDir ?? NodeOS.tmpdir();
      const stdout = yield* Queue.unbounded<Uint8Array, Cause.Done>();
      const delivered = yield* Queue.unbounded<void>();
      promptDelivered = Queue.peek(delivered);
      const encoder = new TextEncoder();
      const decoder = new TextDecoder();
      const line = (value: unknown) => encoder.encode(`${encodeJson(value)}\n`);
      raw = (text) => Queue.offer(stdout, encoder.encode(text)).pipe(Effect.asVoid);
      emit = (frames) =>
        Effect.forEach(frames, (frame) => Queue.offer(stdout, line(frame)), { discard: true });
      close = Queue.end(stdout).pipe(Effect.asVoid);
      const respond = (frame: Frame, data?: unknown, error?: string) =>
        line({
          id: frame.id,
          type: "response",
          command: frame.type,
          success: error === undefined,
          ...(data === undefined ? {} : { data }),
          ...(error === undefined ? {} : { error }),
        });
      // The run of the latest prompt ends, and OMP 18.3.1 reports its result.
      finish = Queue.take(delivered).pipe(
        Effect.andThen(
          Effect.suspend(() =>
            Effect.forEach(
              [
                { type: "agent_start" },
                { type: "agent_end", messages: [], isTerminal: true },
                ...(lastPromptId === undefined
                  ? []
                  : [
                      {
                        type: "prompt_result",
                        id: lastPromptId,
                        agentInvoked: true,
                        status: "completed",
                      },
                    ]),
              ],
              (frame) => Queue.offer(stdout, line(frame)),
              { discard: true },
            ),
          ),
        ),
      );
      const reply = (frame: Frame, bytes: number): Uint8Array => {
        state.frames.push(frame);
        const refused = input.commandError?.(frame);
        if (refused) return respond(frame, undefined, refused);
        if (
          frame.type !== "get_state" &&
          frame.type !== "negotiate_protocol" &&
          frame.type !== "set_subagent_subscription" &&
          frame.type !== "set_event_filter" &&
          frame.type !== "get_available_commands"
        ) {
          state.log.push(
            frame.type === "set_model"
              ? `set_model ${frame.provider}/${frame.modelId}`
              : frame.type === "set_thinking_level"
                ? `set_thinking_level ${frame.level}`
                : frame.type,
          );
        }
        switch (frame.type) {
          case "negotiate_protocol":
            return respond(frame, { protocolVersion: 2 });
          case "set_event_filter":
            return respond(frame, { events: frame.events ?? null }, input.eventFilterError);
          case "new_session":
            state.sessionOrdinal++;
            state.sessionFile = undefined;
            return respond(frame, {});
          case "get_state": {
            NodeFS.mkdirSync(sessionDir, { recursive: true });
            const sessionFile =
              state.sessionFile ??
              NodePath.join(sessionDir, `models-session-${state.sessionOrdinal}.jsonl`);
            if (!NodeFS.existsSync(sessionFile)) NodeFS.writeFileSync(sessionFile, "{}\n");
            return respond(frame, {
              model: state.model,
              ...(input.reportThinkingLevel?.() === false
                ? {}
                : { thinkingLevel: state.thinkingLevel }),
              sessionFile,
              sessionId: `models-session-${state.sessionOrdinal}`,
              isStreaming: false,
              hasPendingAsyncWork: state.pendingAsyncWork,
              isSettled: !state.pendingAsyncWork,
            });
          }
          case "switch_session":
            if (input.switchCancelled) return respond(frame, { cancelled: true });
            state.sessionFile = (frame as Frame & { readonly sessionPath?: string }).sessionPath;
            return respond(frame, { cancelled: false });
          case "get_available_models":
            return respond(
              frame,
              state.modelsResponse ?? { models: state.models },
              state.modelsError,
            );
          case "get_available_commands":
            return respond(frame, {
              commands: [
                { name: "help", source: "builtin" },
                { name: "review", source: "builtin" },
                { name: "compact", source: "builtin" },
              ],
            });
          case "set_model": {
            const provider = frame.provider ?? "";
            const modelId = frame.modelId ?? "";
            const refused = input.setModelError?.(provider, modelId);
            if (refused) return respond(frame, undefined, refused);
            if (!find(provider, modelId)) {
              return respond(frame, undefined, `Model not found: ${provider}/${modelId}`);
            }
            const selected = input.substitute?.[`${provider}/${modelId}`] ?? {
              provider,
              id: modelId,
            };
            const model = find(selected.provider, selected.id);
            if (!model) return respond(frame, undefined, `Model not found: ${provider}/${modelId}`);
            state.model = { provider: selected.provider, id: selected.id };
            state.thinkingLevel = model.reasoning
              ? (model.thinking?.defaultLevel ?? "medium")
              : "off";
            return respond(frame, { provider, id: modelId });
          }
          case "set_thinking_level": {
            const level = frame.level ?? "off";
            const refused = input.setThinkingLevelError?.(level);
            if (refused) return respond(frame, undefined, refused);
            state.thinkingLevel =
              input.clamp?.[`${state.model.provider}/${state.model.id}`]?.[level] ?? level;
            return respond(frame);
          }
          case "prompt":
          case "steer":
            state.prompts.push({ frame, bytes });
            if (frame.type === "prompt") lastPromptId = String(frame.id);
            return respond(frame, undefined, input.promptError);
          default:
            return respond(frame, {});
        }
      };
      const client = yield* makeOmpRpcClient({
        ...(options.onFrame ? { onFrame: options.onFrame } : {}),
        stdout: Stream.fromQueue(stdout),
        write: (bytes) =>
          Effect.forEach(
            decoder
              .decode(bytes)
              .split("\n")
              .filter((text) => text.trim().length > 0),
            (text) => {
              const frame = decodeJson(text) as Frame;
              const answer = reply(frame, Buffer.byteLength(text) + 1);
              return Effect.forEach(
                (input.beforeReply?.(frame) ?? []).map(line),
                (bytes) => Queue.offer(stdout, bytes),
                { discard: true },
              ).pipe(
                Effect.andThen(input.holdReply?.(frame) ?? Effect.void),
                Effect.andThen(
                  input.silentReply?.(frame) ? Effect.void : Queue.offer(stdout, answer),
                ),
                Effect.andThen(
                  frame.type === "prompt" ? Queue.offer(delivered, undefined) : Effect.void,
                ),
              );
            },
            { discard: true },
          ),
      });
      yield* (input.readyDelay ?? Effect.void).pipe(
        Effect.andThen(
          Queue.offer(
            stdout,
            line({
              type: "ready",
              protocolVersion: 1,
              supportedProtocolVersions: input.supportedProtocolVersions ?? [1, 2],
              maxFrameBytes: input.maxFrameBytes ?? 1_048_576,
              maxReassembledFrameBytes: 67_108_864,
            }),
          ),
        ),
        Effect.forkScoped,
      );
      return {
        ...client,
        redaction: makeOmpRedaction(input.environment ?? {}, []),
        version: input.version ?? "18.3.1",
        runtimeVersion: input.version ?? "18.3.1",
        shutdown: Effect.sync(() => {
          state.shutdowns++;
        }).pipe(Effect.andThen(Queue.end(stdout)), Effect.as(cleanExit)),
        // The custom-model bridge's barrier: registers late models.
        refreshModels: () =>
          Effect.sync(() => {
            state.log.push("refresh");
            for (const model of input.lateModels ?? []) {
              if (!find(model.provider, model.id)) state.models.push(model);
            }
          }),
      };
    });
  return {
    state,
    makeProcess,
    finish: () => finish,
    promptDelivered: () => promptDelivered,
    emit: (frames: ReadonlyArray<unknown>) => emit(frames),
    close: () => close,
    raw: (text: string) => raw(text),
  };
};
