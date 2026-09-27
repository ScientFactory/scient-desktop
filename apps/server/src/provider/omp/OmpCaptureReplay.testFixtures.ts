// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import type * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import type { OmpRpcIo } from "effect-omp-rpc/client";

/**
 * Replays a recorded Oh My Pi RPC capture as the stdio of a fake process, so
 * tests drive the real `makeOmpRpcClient` with frames OMP actually wrote.
 */

const CAPTURE_DIRECTORY = NodePath.resolve(
  NodeURL.fileURLToPath(
    new URL("../../../../../packages/effect-omp-rpc/test/fixtures/v18.3.1", import.meta.url),
  ),
);

const Frame = Schema.Record(Schema.String, Schema.Unknown);
type Frame = typeof Frame.Type;
const decodeCaptureLine = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ dir: Schema.Literals(["in", "out"]), frame: Frame })),
);
const decodeFrame = Schema.decodeUnknownSync(Schema.fromJsonString(Frame));
const encodeJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export type OmpCaptureName =
  | "auth-401"
  | "length-stop"
  | "provider-model-not-found"
  | "retry-exhausted"
  | "retry-recovered"
  | "retry-recovered-session"
  | "stream-error-after-partial"
  | "stream-error-event"
  | "success-reasoning"
  | "success-text"
  | "tool-call"
  | "user-abort";

interface RecordedCommand {
  readonly type: string;
  readonly id: string;
  /** Frames OMP wrote after this command and before the next one. */
  readonly output: ReadonlyArray<Frame>;
  consumed: boolean;
}

const text = (value: unknown) => (typeof value === "string" ? value : "");

const readCapture = (name: string) => {
  const preamble: Array<Frame> = [];
  const commands: Array<RecordedCommand> = [];
  const lines = NodeFS.readFileSync(NodePath.join(CAPTURE_DIRECTORY, `${name}.jsonl`), "utf8")
    .split("\n")
    .filter((line) => line.length > 0);
  for (const line of lines) {
    const { dir, frame } = decodeCaptureLine(line);
    const current = commands.at(-1);
    if (dir === "in") {
      commands.push({ type: text(frame.type), id: text(frame.id), output: [], consumed: false });
    } else if (current) {
      (current.output as Array<Frame>).push(frame);
    } else {
      preamble.push(frame);
    }
  }
  return { preamble, commands };
};

/**
 * Answers for commands the capture driver never sent (Scient's own startup
 * and drain commands). Return `undefined` to use the default success answer,
 * or `"silent"` to never answer.
 */
export type OmpReplayResponder = (command: Frame) => Frame | "silent" | undefined;

const defaultData = (command: Frame): unknown => {
  switch (command.type) {
    case "get_state":
      return {
        model: { provider: "scient-stub", id: "stub-model" },
        isStreaming: false,
        isCompacting: false,
        sessionId: "replay-session",
      };
    case "get_available_models":
      return { models: [{ provider: "scient-stub", id: "stub-model", input: ["text"] }] };
    case "get_available_commands":
      return { commands: [] };
    case "set_event_filter":
      return { events: command.events ?? null };
    default:
      return undefined;
  }
};

const readyFrame: Frame = {
  type: "ready",
  protocolVersion: 1,
  supportedProtocolVersions: [1, 2],
  maxFrameBytes: 1_048_576,
  maxReassembledFrameBytes: 67_108_864,
};

export interface OmpScriptedWire {
  readonly io: OmpRpcIo;
  readonly written: ReadonlyArray<Frame>;
  /** Write frames to the client's stdout, as OMP would. */
  readonly send: (...frames: ReadonlyArray<Frame>) => Effect.Effect<void>;
}

/**
 * A hand-scripted OMP stdout for sequences no capture covers. It sends
 * `ready`, negotiates v2, and answers every command like
 * `makeOmpCaptureReplay` answers the commands its capture lacks.
 */
export const makeOmpScriptedWire = (
  respond: OmpReplayResponder = () => undefined,
  /** Frames OMP writes after answering a command (for example a prompt's turn). */
  after: (command: Frame) => ReadonlyArray<Frame> = () => [],
) =>
  Effect.gen(function* () {
    const stdout = yield* Queue.unbounded<Uint8Array, Cause.Done>();
    const written: Array<Frame> = [];
    const send = (...frames: ReadonlyArray<Frame>) =>
      Effect.forEach(
        frames,
        (frame) => Queue.offer(stdout, encoder.encode(`${encodeJson(frame)}\n`)),
        { discard: true },
      );
    yield* send(readyFrame);
    const io: OmpRpcIo = {
      stdout: Stream.fromQueue(stdout),
      write: (bytes) =>
        Effect.suspend(() => {
          const command = decodeFrame(decoder.decode(bytes).trimEnd());
          written.push(command);
          const id = text(command.id);
          const type = text(command.type);
          if (id.length === 0) return Effect.void;
          const custom = type === "negotiate_protocol" ? undefined : respond(command);
          if (custom === "silent") return Effect.void;
          const data =
            type === "negotiate_protocol" ? { protocolVersion: 2 } : defaultData(command);
          return send(
            custom ?? {
              type: "response",
              id,
              command: type,
              success: true,
              ...(data === undefined ? {} : { data }),
            },
            ...after(command),
          );
        }),
      close: Queue.end(stdout).pipe(Effect.asVoid),
    };
    return { io, written, send } satisfies OmpScriptedWire;
  });

export interface OmpCaptureReplay {
  readonly io: OmpRpcIo;
  /** Every frame the client wrote, in order. */
  readonly written: ReadonlyArray<Frame>;
  /**
   * Frames OMP wrote after a `session_settled` are held back until this runs,
   * so a test can settle the turn first and then prove the late frames
   * (a recovered retry's `auto_retry_end`, widget updates) are harmless.
   */
  readonly releaseLateFrames: Effect.Effect<void>;
}

export const makeOmpCaptureReplay = (
  name: OmpCaptureName,
  respond: OmpReplayResponder = () => undefined,
) =>
  Effect.gen(function* () {
    const capture = readCapture(name);
    const stdout = yield* Queue.unbounded<Uint8Array, Cause.Done>();
    const written: Array<Frame> = [];
    const ids = new Map<string, string>();
    const late: Array<Frame> = [];
    let settled = false;

    const rewrite = (frame: Frame): Frame => {
      const recorded = text(frame.id);
      const correlated =
        (frame.type === "response" || frame.type === "prompt_result") && ids.has(recorded);
      return correlated ? { ...frame, id: ids.get(recorded) } : frame;
    };
    const emitNow = (frame: Frame) =>
      Queue.offer(stdout, encoder.encode(`${encodeJson(rewrite(frame))}\n`)).pipe(Effect.asVoid);
    const emit = (frames: ReadonlyArray<Frame>) =>
      Effect.forEach(
        frames,
        (frame) => {
          if (settled) {
            late.push(frame);
            return Effect.void;
          }
          if (frame.type === "session_settled") settled = true;
          return emitNow(frame);
        },
        { discard: true },
      );

    const answer = (command: Frame) =>
      Effect.gen(function* () {
        const id = text(command.id);
        const type = text(command.type);
        if (id.length === 0) return;
        const recorded = capture.commands.find(
          (candidate) => !candidate.consumed && candidate.type === type,
        );
        if (recorded) {
          recorded.consumed = true;
          ids.set(recorded.id, id);
          // A new prompt starts a new turn: nothing it writes is late.
          if (type === "prompt") settled = false;
          yield* emit(recorded.output);
          return;
        }
        const custom = respond(command);
        if (custom === "silent") return;
        const data = defaultData(command);
        yield* emitNow(
          custom ?? {
            type: "response",
            id,
            command: type,
            success: true,
            ...(data === undefined ? {} : { data }),
          },
        );
      });

    yield* emit(capture.preamble);
    const io: OmpRpcIo = {
      stdout: Stream.fromQueue(stdout),
      write: (bytes) =>
        Effect.suspend(() => {
          const command = decodeFrame(decoder.decode(bytes).trimEnd());
          written.push(command);
          return answer(command);
        }),
      close: Queue.end(stdout).pipe(Effect.asVoid),
    };
    return {
      io,
      written,
      releaseLateFrames: Effect.suspend(() =>
        Effect.forEach(late.splice(0), emitNow, { discard: true }),
      ),
    } satisfies OmpCaptureReplay;
  });
