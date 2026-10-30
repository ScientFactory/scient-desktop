// @effect-diagnostics nodeBuiltinImport:off -- transport hashes validated PNG bytes and owner tokens.
import * as NodeCrypto from "node:crypto";

import {
  COMPUTE_PROTOCOL_VERSION,
  ComputeRepresentationBundle,
  ComputeSessionGeneration,
  ComputeTransportError,
  ComputeTransportKind,
  computeOutputByteLength,
  encodeComputeProtocolMessage,
  decodeComputeProtocolMessage,
  makeComputeFrameDecoder,
  nextComputeSessionGeneration,
  requireSupportedProtocolVersion,
  type ComputeCapability,
  type ComputeChannel,
  type ComputeInterruptOutcome,
  type ComputeOutput,
  type ComputeRequestId,
  type ComputeRuntimeIdentity,
  type ComputeTransport,
  type ComputeTransportEvent,
  type ComputeTransportOpenRequest,
  type ComputeVariableSnapshot,
} from "@scientfactory/compute";
import {
  DuplexProcessId,
  type DuplexProcessHandle,
  type DuplexProcessPort,
} from "@scientfactory/execution";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as MutableRef from "effect/MutableRef";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import {
  decodeBridgeMessage,
  makeBridgeSequenceTracker,
  validateBridgeSequence,
  type BridgeMessage,
  type DisplayPayload,
  type KernelPortsPayload,
} from "./BridgeProtocol.ts";
import { inspectComputeStaticImage } from "./ComputeStaticImage.ts";

const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;
const DEFAULT_INTERRUPT_TIMEOUT_MS = 10_000;
const DEFAULT_VARIABLES_TIMEOUT_MS = 10_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 15_000;
const DEFAULT_FINALIZER_SHUTDOWN_MS = 5_000;
const DEFAULT_MAX_EVENT_QUEUE_BYTES = 32 * 1024 * 1024;
const MAX_LOST_REASON_LENGTH = 4096;
const MAX_STDERR_TAIL_BYTES = 64 * 1024;
const MAX_PNG_DECODED_BYTES = 8 * 1024 * 1024;
const MAX_SVG_DECODED_BYTES = 8 * 1024 * 1024;
const decodeRepresentationBundle = Schema.decodeUnknownOption(ComputeRepresentationBundle);

type RichDisplayPayload = Extract<DisplayPayload, { readonly kind: unknown }>;

/**
 * Only the language adapter resolves the bridge path in prepareLaunch. Resolving it again in
 * transport could contradict the supplied executable/argument plan.
 */
export interface ComputeBridgeTransportOptions {
  readonly startupTimeoutMs?: number;
  /**
   * Reserves the private endpoints a Jupyter kernel will bind. The lease must
   * remain protected until the entire bridge process tree is confirmed gone.
   */
  readonly prepareKernelEndpoints?: (request: ComputeTransportOpenRequest) => Effect.Effect<
    {
      readonly ports: KernelPortsPayload;
      readonly handoff: Effect.Effect<void, ComputeTransportError>;
      readonly release: Effect.Effect<void>;
    },
    ComputeTransportError
  >;
  /**
   * Bound unread event bytes and report dropped output. Lifecycle events remain deliverable even
   * above that target, so the budget plus in-flight lifecycle facts is not a strict ceiling.
   */
  readonly maxEventQueueBytes?: number;
}

interface WeightedEvent {
  readonly event: ComputeTransportEvent;
  readonly byteLength: number;
}

interface PendingResponse {
  readonly type: BridgeMessage["type"];
  readonly requestId: ComputeRequestId | null;
  readonly generation: ComputeSessionGeneration;
  readonly deferred: Deferred.Deferred<BridgeMessage, ComputeTransportError>;
}

function transportError(
  operation: ComputeTransportError["operation"],
  message: string,
  cause?: unknown,
): ComputeTransportError {
  return new ComputeTransportError({
    operation,
    message,
    ...(cause === undefined ? {} : { cause }),
  });
}

function estimateTextBytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function estimateOutputBytes(output: ComputeOutput): number {
  switch (output._tag) {
    case "stream":
      return estimateTextBytes(output.text);
    case "diagnostic":
      return (
        estimateTextBytes(output.diagnostic.errorName) +
        estimateTextBytes(output.diagnostic.message) +
        output.diagnostic.traceback.reduce((total, line) => total + estimateTextBytes(line), 0)
      );
    case "image":
      return 256;
    case "system":
      return output.detail === null ? 64 : 64 + estimateTextBytes(output.detail);
    case "display-data":
    case "execute-result":
    case "display-update":
      // Resource bytes are not carried by this bridge event yet, but counting
      // them here is a conservative bound and keeps the queue safe when the
      // transport gains neutral resource payloads.
      return computeOutputByteLength(output) + 64;
    case "clear-output":
      return 64;
  }
}

function estimateEventBytes(event: ComputeTransportEvent): number {
  switch (event._tag) {
    case "output":
      return (
        estimateOutputBytes(event.output) +
        (event.image?.bytes.byteLength ?? 0) +
        event.resources.reduce((total, resource) => total + resource.bytes.byteLength, 0) +
        64
      );
    case "runtime-error":
      return (
        estimateTextBytes(event.report.name) +
        estimateTextBytes(event.report.value) +
        event.report.traceback.reduce((total, line) => total + estimateTextBytes(line), 0) +
        64
      );
    case "lost":
      return estimateTextBytes(event.reason) + 64;
    default:
      return 256;
  }
}

/**
 * Untrusted but well-framed PNG contents can be invalid, mislabeled, or oversized. Report the lost
 * image without ending the namespace and discarding variables; only protocol-invalid frames are
 * fatal.
 */
function decodePngPayload(data: string): Uint8Array | string {
  if (data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) {
    return "An image output was dropped: its data was not readable base64.";
  }
  const bytes = new Uint8Array(Buffer.from(data, "base64"));
  if (bytes.byteLength > MAX_PNG_DECODED_BYTES) {
    return "An image output was dropped: it exceeded the decoded byte limit.";
  }
  if (inspectComputeStaticImage("image/png", bytes) === null) {
    return "An image output was dropped: its data was not a PNG.";
  }
  return bytes;
}

function decodeSvgPayload(data: string): Uint8Array | string {
  const bytes = new TextEncoder().encode(data);
  if (bytes.byteLength > MAX_SVG_DECODED_BYTES) {
    return "An image output was dropped: it exceeded the decoded byte limit.";
  }
  if (inspectComputeStaticImage("image/svg+xml", bytes) === null) {
    return "An image output was dropped: its data was not an SVG.";
  }
  return bytes;
}

function decodeBase64Payload(data: string): Uint8Array | string {
  if (data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) {
    return "A rich representation was dropped: its data was not readable base64.";
  }
  const bytes = new Uint8Array(Buffer.from(data, "base64"));
  if (bytes.byteLength > MAX_PNG_DECODED_BYTES) {
    return "A rich representation was dropped: it exceeded the decoded byte limit.";
  }
  return bytes;
}

function materializeRichDisplay(payload: Exclude<RichDisplayPayload, { kind: "clear-output" }>) {
  const representations: Array<{
    mediaType: string;
    data:
      | { _tag: "text"; text: string }
      | { _tag: "json"; json: string }
      | { _tag: "resource"; contentHash: string; byteLength: number };
  }> = [];
  const resources: Array<{
    mediaType: string;
    contentHash: string;
    bytes: Uint8Array;
  }> = [];
  let warning: string | null = null;
  const seenMediaTypes = new Set<string>();

  for (const representation of payload.bundle.representations) {
    if (seenMediaTypes.has(representation.mediaType)) {
      warning = "A duplicate rich representation was dropped.";
      continue;
    }
    seenMediaTypes.add(representation.mediaType);
    if (representation.encoding === "text" && representation.mediaType !== "image/svg+xml") {
      representations.push({
        mediaType: representation.mediaType,
        data: { _tag: "text", text: representation.data },
      });
      continue;
    }
    if (representation.encoding === "json") {
      try {
        JSON.parse(representation.data);
      } catch {
        warning = "A rich JSON representation was dropped because it was invalid.";
        continue;
      }
      representations.push({
        mediaType: representation.mediaType,
        data: { _tag: "json", json: representation.data },
      });
      continue;
    }
    const decoded =
      representation.encoding === "text"
        ? decodeSvgPayload(representation.data)
        : representation.mediaType === "image/png"
          ? decodePngPayload(representation.data)
          : decodeBase64Payload(representation.data);
    if (typeof decoded === "string") {
      warning = decoded;
      continue;
    }
    if (
      representation.mediaType === "image/svg+xml" &&
      inspectComputeStaticImage("image/svg+xml", decoded) === null
    ) {
      warning = "An image output was dropped: its data was not an SVG.";
      continue;
    }
    const contentHash = `sha256:${NodeCrypto.createHash("sha256").update(decoded).digest("hex")}`;
    representations.push({
      mediaType: representation.mediaType,
      data: { _tag: "resource", contentHash, byteLength: decoded.byteLength },
    });
    resources.push({ mediaType: representation.mediaType, contentHash, bytes: decoded });
  }

  let metadataJson = payload.bundle.metadataJson;
  if (metadataJson !== null) {
    try {
      const metadata: unknown = JSON.parse(metadataJson);
      if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) {
        metadataJson = null;
        warning = "Invalid rich representation metadata was dropped.";
      }
    } catch {
      metadataJson = null;
      warning = "Invalid rich representation metadata was dropped.";
    }
  }

  const decoded = decodeRepresentationBundle({
    representations,
    metadataJson,
  });
  return Option.isNone(decoded)
    ? "A rich representation was dropped because its bounded bundle was invalid."
    : { bundle: decoded.value, resources, warning };
}

function hasCapabilities(
  offered: ReadonlyArray<ComputeCapability>,
  required: ReadonlyArray<ComputeCapability>,
): boolean {
  const available = new Set(offered);
  return required.every((capability) => available.has(capability));
}

function pendingKey(
  type: BridgeMessage["type"],
  requestId: ComputeRequestId | null,
  generation: ComputeSessionGeneration,
): string {
  return `${type}:${requestId ?? ""}:${generation}`;
}

export function makeComputeBridgeTransport(
  processes: DuplexProcessPort,
  options: ComputeBridgeTransportOptions,
): ComputeTransport {
  const startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
  const maxEventQueueBytes = options.maxEventQueueBytes ?? DEFAULT_MAX_EVENT_QUEUE_BYTES;
  /**
   * Where dropping output stops, as opposed to where it starts.
   *
   * A single threshold would flap: one dequeued event would let one more output
   * through, drop the next, and turn a burst into an alternating stream of
   * output and truncation markers.
   */
  const resumeEventQueueBytes = Math.floor(maxEventQueueBytes / 2);

  return {
    open: Effect.fn("ComputeBridgeTransport.open")(function* (
      request: ComputeTransportOpenRequest,
    ) {
      const ownerToken = NodeCrypto.randomBytes(32).toString("hex");
      const { cleanupOwnedProcess, endpointLease, handle } = yield* Effect.uninterruptible(
        Effect.gen(function* () {
          const endpointLease = options.prepareKernelEndpoints
            ? yield* options.prepareKernelEndpoints(request)
            : null;
          const cleanupGate = yield* Semaphore.make(1);
          const cleanupComplete = MutableRef.make(false);
          const handleRef = MutableRef.make<DuplexProcessHandle | null>(null);

          const cleanupOwnedProcess = (
            operation: ComputeTransportError["operation"],
          ): Effect.Effect<void, ComputeTransportError> =>
            Effect.uninterruptible(
              cleanupGate.withPermits(1)(
                Effect.suspend(() => {
                  if (MutableRef.get(cleanupComplete)) return Effect.void;
                  const handle = MutableRef.get(handleRef);
                  const cleanup =
                    handle === null
                      ? (endpointLease?.release ?? Effect.void)
                      : handle.cancelProcessTree.pipe(
                          Effect.mapError((cause) =>
                            transportError(
                              operation,
                              "Failed to stop the compute bridge process tree.",
                              cause,
                            ),
                          ),
                          Effect.tap(() => endpointLease?.release ?? Effect.void),
                        );
                  return cleanup.pipe(
                    Effect.tap(() =>
                      Effect.sync(() => {
                        MutableRef.set(cleanupComplete, true);
                      }),
                    ),
                  );
                }),
              ),
            );

          const setup = Effect.gen(function* () {
            const handle = yield* processes
              .start({
                processId: DuplexProcessId.make(request.sessionId),
                executable: request.launch.executable,
                args: [...request.launch.args],
                cwd: request.launch.cwd,
                environment: request.launch.environment,
                extendEnv: false,
              })
              .pipe(
                Effect.mapError((cause) =>
                  transportError("open", "Failed to start the bridge process.", cause),
                ),
              );
            MutableRef.set(handleRef, handle);

            // Registered before startup becomes interruptible. If a caller
            // leaves while the protocol handshake is pending, the bridge
            // tree is still stopped before its private ports are unprotected.
            yield* Effect.addFinalizer(() =>
              cleanupOwnedProcess("shutdown").pipe(
                Effect.tapError((cause) =>
                  Effect.logWarning(
                    "compute process cleanup failed; retaining private endpoint protection",
                    { cause, sessionId: request.sessionId },
                  ),
                ),
                // Finalizers cannot expose a typed error, but cleanup failure
                // must still fail `Scope.close`; the session layer catches
                // that cause and retains its host reservation.
                Effect.orDie,
              ),
            );
            return handle;
          });
          const setupExit = yield* Effect.exit(setup);
          if (Exit.isFailure(setupExit)) {
            yield* cleanupOwnedProcess("open").pipe(
              Effect.catch((cause) =>
                Effect.logWarning(
                  "compute startup cleanup failed; retaining private endpoint protection",
                  { cause, sessionId: request.sessionId },
                ),
              ),
            );
            return yield* Effect.failCause(setupExit.cause);
          }
          return { cleanupOwnedProcess, endpointLease, handle: setupExit.value };
        }),
      );

      const decoder = makeComputeFrameDecoder();
      const inboundSequence = makeBridgeSequenceTracker("bridge-to-server");
      const outboundSequence = MutableRef.make(0);
      const generation = MutableRef.make(request.generation);
      const runtimeIdentity = MutableRef.make<ComputeRuntimeIdentity | null>(null);
      const closed = MutableRef.make(false);
      const lost = MutableRef.make(false);
      const transitioning = MutableRef.make(false);
      const activeRequestId = MutableRef.make<ComputeRequestId | null>(null);
      const inspectingVariables = MutableRef.make(false);
      /**
       * During requested shutdown, stdout close/exit are expected rather than lost-session
       * evidence. Keep that distinction armed until shutdown completion is observed.
       */
      const stopping = MutableRef.make(false);
      const eventBytes = MutableRef.make(0);
      const droppingOutput = MutableRef.make(false);
      const stderrTail = MutableRef.make("");
      const pending = new Map<string, PendingResponse>();
      const commandGate = yield* Semaphore.make(1);
      const shutdownGate = yield* Semaphore.make(1);
      const writeGate = yield* Semaphore.make(1);
      /**
       * A bounded queue would suspend the same reader fiber that delivers interrupt-result, making
       * runaway cells unstoppable. Keep the queue unbounded and shed droppable output by byte
       * budget instead.
       */
      const events = yield* Queue.unbounded<WeightedEvent, ComputeTransportError | Cause.Done>();

      const failPending = (error: ComputeTransportError) =>
        Effect.forEach(pending.values(), (entry) => Deferred.fail(entry.deferred, error), {
          discard: true,
        }).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              pending.clear();
            }),
          ),
        );

      const offer = (event: ComputeTransportEvent) => {
        const byteLength = estimateEventBytes(event);
        MutableRef.set(eventBytes, MutableRef.get(eventBytes) + byteLength);
        return Queue.offer(events, { event, byteLength }).pipe(Effect.asVoid);
      };

      /**
       * Drop output/diagnostics with a truncation marker under pressure, but always queue lifecycle
       * facts. Losing ready/accepted/completed/restarted/lost can strand consumers forever, so
       * their budget is a target rather than a hard ceiling.
       */
      const emit = (event: ComputeTransportEvent): Effect.Effect<void, ComputeTransportError> =>
        Effect.suspend(() => {
          if (MutableRef.get(closed) || MutableRef.get(lost)) return Effect.void;
          if (event._tag !== "output" && event._tag !== "runtime-error") return offer(event);
          const overBudget =
            MutableRef.get(eventBytes) + estimateEventBytes(event) > maxEventQueueBytes;
          if (!overBudget && !MutableRef.get(droppingOutput)) return offer(event);
          // One marker per episode: repeating it for every dropped chunk would
          // replace the output the user lost with noise about losing it.
          if (MutableRef.get(droppingOutput)) return Effect.void;
          MutableRef.set(droppingOutput, true);
          const sequence = event._tag === "output" ? event.output.sequence : event.sequence;
          const observedAt = event._tag === "output" ? event.output.observedAt : event.observedAt;
          return offer({
            _tag: "output",
            requestId: event.requestId,
            generation: event.generation,
            output: {
              _tag: "system",
              sequence,
              observedAt,
              event: "output-truncated",
              detail: "Output was dropped because the consumer fell behind.",
            },
            image: null,
            resources: [],
          });
        });

      /**
       * Capture exit shape and bridge stderr together before either disappears. Trim the diagnostic
       * tail rather than its newest end so the latest explanation survives.
       */
      const lostReason = (error: ComputeTransportError): string => {
        const tail = MutableRef.get(stderrTail).trim();
        if (tail === "") return error.message.slice(0, MAX_LOST_REASON_LENGTH);
        const budget = MAX_LOST_REASON_LENGTH - error.message.length - 1;
        if (budget <= 0) return error.message.slice(0, MAX_LOST_REASON_LENGTH);
        return `${error.message}\n${tail.slice(Math.max(0, tail.length - budget))}`;
      };

      const lose = (error: ComputeTransportError) =>
        Effect.suspend(() => {
          if (MutableRef.get(lost) || MutableRef.get(closed)) return Effect.void;
          if (MutableRef.get(stopping)) {
            // Suppress lost during requested shutdown, but fail pending replies immediately so
            // shutdown can settle instead of waiting a full timeout on an already-closed bridge.
            return failPending(error).pipe(Effect.ignore);
          }
          MutableRef.set(lost, true);
          const lostEvent: ComputeTransportEvent = { _tag: "lost", reason: lostReason(error) };
          const byteLength = estimateEventBytes(lostEvent);
          return failPending(error).pipe(
            Effect.andThen(Queue.offer(events, { event: lostEvent, byteLength })),
            Effect.andThen(Queue.fail(events, error)),
            Effect.andThen(cleanupOwnedProcess("shutdown").pipe(Effect.ignore)),
            Effect.asVoid,
          );
        });

      /**
       * Every failure names the command that was in flight, not the machinery
       * that noticed. A caller deciding whether to retry, restart or give up
       * reads `operation`, and "receive" would tell it only that some reply
       * never came.
       */
      const registerResponse = Effect.fn("ComputeBridgeTransport.registerResponse")(function* (
        operation: ComputeTransportError["operation"],
        type: BridgeMessage["type"],
        requestId: ComputeRequestId | null,
        expectedGeneration: ComputeSessionGeneration,
      ) {
        const key = pendingKey(type, requestId, expectedGeneration);
        if (pending.has(key)) {
          return yield* transportError(operation, `A response waiter already exists for ${type}.`);
        }
        const deferred = yield* Deferred.make<BridgeMessage, ComputeTransportError>();
        pending.set(key, { type, requestId, generation: expectedGeneration, deferred });
        return {
          await: (timeoutMs: number) =>
            Deferred.await(deferred).pipe(
              Effect.timeoutOrElse({
                duration: timeoutMs,
                orElse: () =>
                  Effect.fail(transportError(operation, `Timed out waiting for ${type}.`)),
              }),
              Effect.ensuring(
                Effect.sync(() => {
                  pending.delete(key);
                }),
              ),
            ),
          remove: Effect.sync(() => {
            pending.delete(key);
          }),
        };
      });

      const resolveResponse = (message: BridgeMessage) => {
        const key = pendingKey(message.type, message.requestId, message.generation);
        const entry = pending.get(key);
        return entry === undefined
          ? Effect.void
          : Deferred.succeed(entry.deferred, message).pipe(Effect.asVoid);
      };

      const timestamp = DateTime.now.pipe(Effect.map(DateTime.formatIso));

      const mapBridgeMessage = Effect.fn("ComputeBridgeTransport.mapBridgeMessage")(function* (
        message: BridgeMessage,
      ) {
        const responseOnly = new Set<BridgeMessage["type"]>([
          "hello-ack",
          "kernel-ready",
          "interrupt-result",
          "variables",
          "restarted",
          "shutdown-complete",
        ]);
        if (
          responseOnly.has(message.type) &&
          !pending.has(pendingKey(message.type, message.requestId, message.generation))
        ) {
          return yield* transportError("receive", `Bridge sent unsolicited ${message.type}.`);
        }
        switch (message.type) {
          case "accepted": {
            if (MutableRef.get(activeRequestId) !== message.requestId) {
              return yield* transportError("receive", "Bridge accepted an unknown execution.");
            }
            yield* emit({
              _tag: "accepted",
              requestId: message.requestId!,
              generation: message.generation,
            });
            break;
          }

          case "stream": {
            const payload = message.payload as { stream: "stdout" | "stderr"; text: string };
            yield* emit({
              _tag: "output",
              requestId: message.requestId,
              generation: message.generation,
              output: {
                _tag: "stream",
                sequence: message.sequence,
                observedAt: yield* timestamp,
                stream: payload.stream,
                text: payload.text,
              },
              image: null,
              resources: [],
            });
            break;
          }

          case "display": {
            const payload = message.payload as DisplayPayload;
            if ("kind" in payload) {
              if (payload.kind === "clear-output") {
                yield* emit({
                  _tag: "output",
                  requestId: message.requestId,
                  generation: message.generation,
                  output: {
                    _tag: "clear-output",
                    sequence: message.sequence,
                    observedAt: yield* timestamp,
                    wait: payload.wait,
                  },
                  image: null,
                  resources: [],
                });
                break;
              }
              const materialized = materializeRichDisplay(payload);
              if (typeof materialized === "string") {
                yield* emit({
                  _tag: "output",
                  requestId: message.requestId,
                  generation: message.generation,
                  output: {
                    _tag: "system",
                    sequence: message.sequence,
                    observedAt: yield* timestamp,
                    event: "output-truncated",
                    detail: materialized,
                  },
                  image: null,
                  resources: [],
                });
                break;
              }
              const common = {
                sequence: message.sequence,
                observedAt: yield* timestamp,
                bundle: materialized.bundle,
              };
              const output =
                payload.kind === "display-data"
                  ? {
                      _tag: "display-data" as const,
                      ...common,
                      displayId: payload.displayId,
                    }
                  : payload.kind === "execute-result"
                    ? {
                        _tag: "execute-result" as const,
                        ...common,
                        executionCount: payload.executionCount,
                      }
                    : {
                        _tag: "display-update" as const,
                        ...common,
                        displayId: payload.displayId,
                      };
              yield* emit({
                _tag: "output",
                requestId: message.requestId,
                generation: message.generation,
                output,
                image: null,
                resources: materialized.resources,
              });
              if (materialized.warning !== null) {
                yield* emit({
                  _tag: "output",
                  requestId: message.requestId,
                  generation: message.generation,
                  output: {
                    _tag: "system",
                    sequence: message.sequence,
                    observedAt: yield* timestamp,
                    event: "output-truncated",
                    detail: materialized.warning,
                  },
                  image: null,
                  resources: [],
                });
              }
              break;
            }
            if (payload.mediaType === "text/plain") {
              yield* emit({
                _tag: "output",
                requestId: message.requestId,
                generation: message.generation,
                output: {
                  _tag: "stream",
                  sequence: message.sequence,
                  observedAt: yield* timestamp,
                  stream: "stdout",
                  text: payload.text,
                },
                image: null,
                resources: [],
              });
              break;
            }
            const imageBytes =
              payload.mediaType === "image/png"
                ? decodePngPayload(payload.data)
                : decodeSvgPayload(payload.data);
            if (typeof imageBytes === "string") {
              yield* emit({
                _tag: "output",
                requestId: message.requestId,
                generation: message.generation,
                output: {
                  _tag: "system",
                  sequence: message.sequence,
                  observedAt: yield* timestamp,
                  event: "output-truncated",
                  detail: imageBytes,
                },
                image: null,
                resources: [],
              });
              break;
            }
            const dimensions =
              payload.mediaType === "image/png"
                ? inspectComputeStaticImage("image/png", imageBytes)
                : null;
            const hash = NodeCrypto.createHash("sha256").update(imageBytes).digest("hex");
            yield* emit({
              _tag: "output",
              requestId: message.requestId,
              generation: message.generation,
              output: {
                _tag: "image",
                sequence: message.sequence,
                observedAt: yield* timestamp,
                mediaType: payload.mediaType,
                contentHash: `sha256:${hash}`,
                byteLength: imageBytes.byteLength,
                width: dimensions?.width ?? null,
                height: dimensions?.height ?? null,
                origin: { _tag: "runtime-display" },
              },
              image: { bytes: imageBytes },
              resources: [],
            });
            break;
          }

          case "error": {
            const payload = message.payload as {
              name: string;
              value: string;
              traceback: string[];
            };
            yield* emit({
              _tag: "runtime-error",
              sequence: message.sequence,
              observedAt: yield* timestamp,
              requestId: message.requestId,
              generation: message.generation,
              report: payload,
            });
            break;
          }

          case "warning": {
            const payload = message.payload as {
              code: "output-truncated" | "input-unsupported" | "runtime-warning";
              detail: string | null;
            };
            yield* emit({
              _tag: "output",
              requestId: message.requestId,
              generation: message.generation,
              output: {
                _tag: "system",
                sequence: message.sequence,
                observedAt: yield* timestamp,
                event: payload.code,
                detail: payload.detail,
              },
              image: null,
              resources: [],
            });
            break;
          }

          case "execution-complete": {
            if (MutableRef.get(activeRequestId) !== message.requestId) {
              return yield* transportError("receive", "Bridge completed an unknown execution.");
            }
            const payload = message.payload as {
              outcome: "succeeded" | "failed" | "cancelled";
            };
            yield* emit({
              _tag: "completed",
              sequence: message.sequence,
              observedAt: yield* timestamp,
              requestId: message.requestId!,
              generation: message.generation,
              outcome: payload.outcome,
            });
            MutableRef.set(activeRequestId, null);
            break;
          }

          case "restarted": {
            // The generation comes from the envelope, which `validateInbound`
            // has already checked advances by exactly one. A copy in the
            // payload would be a second source of truth that could disagree
            // with the one the sequence and identity checks ran against.
            const payload = message.payload as { kernelPid: number | null };
            const previous = MutableRef.get(runtimeIdentity);
            if (previous === null) {
              return yield* transportError(
                "receive",
                "Restart arrived before runtime identity was established.",
              );
            }
            const runtime = { ...previous, runtimeProcessId: payload.kernelPid };
            MutableRef.set(generation, message.generation);
            MutableRef.set(runtimeIdentity, runtime);
            MutableRef.set(transitioning, false);
            yield* emit({ _tag: "restarted", generation: message.generation, runtime });
            break;
          }

          case "fatal": {
            const payload = message.payload as { reason: string };
            return yield* transportError("receive", payload.reason);
          }
        }

        yield* resolveResponse(message);
      });

      const validateInbound = Effect.fn("ComputeBridgeTransport.validateInbound")(function* (
        message: BridgeMessage,
      ) {
        if (message.sessionId !== request.sessionId) {
          return yield* transportError("receive", "Bridge session identity changed.");
        }
        const current = MutableRef.get(generation);
        const expected =
          message.type === "restarted" ? nextComputeSessionGeneration(current) : current;
        if (message.generation !== expected) {
          return yield* transportError(
            "receive",
            `Expected bridge generation ${expected}, received ${message.generation}.`,
          );
        }
        return message;
      });

      const isTransportError = Schema.is(ComputeTransportError);
      const readStdout = Stream.runForEach(handle.stdout, (chunk) =>
        Effect.gen(function* () {
          const frames = yield* decoder.push(chunk);
          for (const frame of frames) {
            const envelope = yield* decodeComputeProtocolMessage(frame);
            yield* requireSupportedProtocolVersion(envelope);
            const bridgeMessage = yield* decodeBridgeMessage(envelope, "bridge-to-server");
            yield* validateBridgeSequence(inboundSequence, bridgeMessage);
            yield* validateInbound(bridgeMessage);
            yield* mapBridgeMessage(bridgeMessage);
          }
        }).pipe(
          Effect.mapError((cause) =>
            isTransportError(cause)
              ? cause
              : transportError("receive", "Bridge protocol failed.", cause),
          ),
        ),
      ).pipe(
        Effect.mapError((cause) =>
          isTransportError(cause)
            ? cause
            : transportError("receive", "Bridge stdout failed.", cause),
        ),
        Effect.andThen(
          decoder.finish.pipe(
            Effect.mapError((cause) =>
              transportError("receive", "Bridge stdout ended with a partial frame.", cause),
            ),
          ),
        ),
        Effect.andThen(
          Effect.suspend(() =>
            MutableRef.get(closed) || MutableRef.get(stopping)
              ? Effect.void
              : Effect.fail(transportError("receive", "Bridge stdout closed unexpectedly.")),
          ),
        ),
        Effect.catch((error) => lose(error)),
      );
      yield* Effect.forkScoped(readStdout);

      yield* Stream.runForEach(handle.stderr, (chunk) =>
        Effect.sync(() => {
          const text = new TextDecoder().decode(chunk);
          const combined = MutableRef.get(stderrTail) + text;
          const bytes = Buffer.from(combined, "utf8");
          MutableRef.set(
            stderrTail,
            bytes.byteLength <= MAX_STDERR_TAIL_BYTES
              ? combined
              : bytes.subarray(bytes.byteLength - MAX_STDERR_TAIL_BYTES).toString("utf8"),
          );
        }),
      ).pipe(Effect.ignore, Effect.forkScoped);

      yield* handle.exitCode.pipe(
        Effect.flatMap((code) =>
          Effect.suspend(() =>
            MutableRef.get(closed) || MutableRef.get(stopping)
              ? Effect.void
              : lose(
                  transportError(
                    "receive",
                    `Bridge process exited unexpectedly with code ${code}.`,
                  ),
                ),
          ),
        ),
        Effect.catch((cause) =>
          Effect.suspend(() =>
            MutableRef.get(closed) || MutableRef.get(stopping)
              ? Effect.void
              : lose(transportError("receive", "Bridge process terminated.", cause)),
          ),
        ),
        Effect.forkScoped,
      );

      /**
       * Hold writeGate across sequence allocation and the full frame write so bytes and sequence
       * cannot interleave. It is separate from round-trip commandGate, allowing execute to remain
       * atomic without waiting for restart.
       */
      const sendCommand = (
        operation: ComputeTransportError["operation"],
        type: string,
        payload: unknown,
        expectedGeneration: ComputeSessionGeneration,
        requestId: ComputeRequestId | null = null,
      ) =>
        writeGate.withPermits(1)(
          Effect.gen(function* () {
            if (
              MutableRef.get(closed) ||
              MutableRef.get(lost) ||
              (type !== "shutdown" && MutableRef.get(stopping))
            ) {
              return yield* transportError(
                operation,
                "The runtime is stopping or no longer reachable.",
              );
            }
            const sequence = MutableRef.get(outboundSequence);
            MutableRef.set(outboundSequence, sequence + 1);
            const frame = yield* encodeComputeProtocolMessage({
              protocolVersion: COMPUTE_PROTOCOL_VERSION,
              type,
              sessionId: request.sessionId,
              generation: expectedGeneration,
              requestId,
              sequence,
              payload,
            }).pipe(
              Effect.mapError((cause) =>
                transportError(operation, "Failed to encode bridge command.", cause),
              ),
            );
            yield* handle
              .write(frame)
              .pipe(
                Effect.mapError((cause) =>
                  transportError(operation, "Failed to send bridge command.", cause),
                ),
              );
          }),
        );

      const requestResponse = Effect.fn("ComputeBridgeTransport.requestResponse")(function* (
        operation: ComputeTransportError["operation"],
        command: {
          readonly type: string;
          readonly payload: unknown;
          readonly generation: ComputeSessionGeneration;
          readonly requestId?: ComputeRequestId | null;
        },
        response: {
          readonly type: BridgeMessage["type"];
          readonly generation: ComputeSessionGeneration;
          readonly requestId?: ComputeRequestId | null;
        },
        timeoutMs: number,
      ) {
        const waiter = yield* registerResponse(
          operation,
          response.type,
          response.requestId ?? null,
          response.generation,
        );
        yield* sendCommand(
          operation,
          command.type,
          command.payload,
          command.generation,
          command.requestId ?? null,
        ).pipe(Effect.onError(() => waiter.remove));
        return yield* waiter.await(timeoutMs);
      });

      /**
       * Spend one startup deadline across both round trips. Separate full budgets exceed the
       * promised bound; an outer racing timer makes diagnostics nondeterministic. Let the stalled
       * step report the remaining-budget timeout.
       */
      const startupDeadline = (yield* Clock.currentTimeMillis) + startupTimeoutMs;
      const remainingStartupMs = Clock.currentTimeMillis.pipe(
        Effect.map((now) => Math.max(1, startupDeadline - now)),
      );

      const handshake = commandGate
        .withPermits(1)(
          Effect.gen(function* () {
            const ack = yield* requestResponse(
              "handshake",
              {
                type: "hello",
                generation: request.generation,
                payload: {
                  buildId: "scient-server",
                  frameLimit: 16 * 1024 * 1024,
                  requiredCapabilities: [...request.requiredCapabilities],
                  ownerToken,
                },
              },
              { type: "hello-ack", generation: request.generation },
              yield* remainingStartupMs,
            );
            const ackPayload = ack.payload as {
              ownerToken: string;
              pid: number;
              platform: string;
              capabilities: ComputeCapability[];
            };
            if (ackPayload.ownerToken !== ownerToken) {
              return yield* transportError("handshake", "Owner token mismatch.");
            }
            if (ackPayload.pid !== handle.pid) {
              return yield* transportError("handshake", "Bridge PID mismatch.");
            }
            if (!hasCapabilities(ackPayload.capabilities, request.requiredCapabilities)) {
              return yield* transportError("handshake", "Bridge capabilities are incomplete.");
            }

            // The reservations stay bound until the bridge is authenticated.
            // Protection was registered while the ports were reserved, so from this
            // handoff onward the scanner can never race the private protocol.
            if (endpointLease !== null) yield* endpointLease.handoff;

            const ready = yield* requestResponse(
              "handshake",
              {
                type: "start-kernel",
                generation: request.generation,
                payload: {
                  workingDirectory: request.launch.cwd,
                  kernel: request.launch.kernel ?? null,
                  ...(endpointLease === null ? {} : { kernelPorts: endpointLease.ports }),
                },
              },
              { type: "kernel-ready", generation: request.generation },
              yield* remainingStartupMs,
            );
            const payload = ready.payload as {
              kernelPid: number | null;
              languageId: string;
              languageVersion: string;
              protocolVersion: number;
              capabilities: ComputeCapability[];
            };
            if (payload.protocolVersion !== COMPUTE_PROTOCOL_VERSION) {
              return yield* transportError("handshake", "Kernel protocol version mismatch.");
            }
            const expectedLanguage = request.launch.kernel?.language ?? request.languageId;
            if (payload.languageId !== expectedLanguage) {
              return yield* transportError(
                "handshake",
                `Expected language '${expectedLanguage}', received '${payload.languageId}'.`,
              );
            }
            if (!hasCapabilities(payload.capabilities, request.requiredCapabilities)) {
              return yield* transportError("handshake", "Kernel capabilities are incomplete.");
            }
            const runtime: ComputeRuntimeIdentity = {
              languageId: request.languageId,
              transportKind: ComputeTransportKind.make(request.transportKind),
              protocolVersion: payload.protocolVersion,
              languageVersion: payload.languageVersion,
              platform: ackPayload.platform,
              transportProcessId: ackPayload.pid,
              runtimeProcessId: payload.kernelPid,
            };
            MutableRef.set(runtimeIdentity, runtime);
            yield* emit({ _tag: "ready", runtime, capabilities: payload.capabilities });
          }),
        )
        .pipe(Effect.tapError(() => cleanupOwnedProcess("handshake").pipe(Effect.ignore)));
      yield* handshake;

      const ensureGeneration = (
        operation: ComputeTransportError["operation"],
        expected: ComputeSessionGeneration,
      ) =>
        Effect.suspend(() => {
          if (MutableRef.get(closed) || MutableRef.get(lost)) {
            return Effect.fail(transportError(operation, "The runtime is no longer reachable."));
          }
          if (operation !== "shutdown" && MutableRef.get(stopping)) {
            return Effect.fail(transportError(operation, "The runtime is stopping."));
          }
          const current = MutableRef.get(generation);
          return expected === current
            ? Effect.void
            : Effect.fail(
                transportError(
                  operation,
                  `The command expected generation ${expected}, but the session is at generation ${current}.`,
                ),
              );
        });

      /**
       * Keep execute outside commandGate: waiting behind restart only delays an inevitable
       * stale-generation refusal. writeGate still orders it atomically against other executions.
       */
      const execute: ComputeChannel["execute"] = (executeRequest) =>
        Effect.suspend(() => {
          if (MutableRef.get(transitioning)) {
            return Effect.fail(transportError("execute", "The runtime is changing generation."));
          }
          if (MutableRef.get(activeRequestId) !== null) {
            return Effect.fail(transportError("execute", "An execution is already active."));
          }
          if (MutableRef.get(inspectingVariables)) {
            return Effect.fail(
              transportError("execute", "The runtime is inspecting its current variables."),
            );
          }
          if (estimateTextBytes(executeRequest.code) > 1024 * 1024) {
            return Effect.fail(
              transportError("execute", "Execution code exceeds the 1048576 byte limit."),
            );
          }
          MutableRef.set(activeRequestId, executeRequest.requestId);
          return ensureGeneration("execute", executeRequest.expectedGeneration).pipe(
            Effect.andThen(
              sendCommand(
                "execute",
                "execute",
                {
                  code: executeRequest.code,
                  silent: false,
                  storeHistory: true,
                  ...(executeRequest.sourceContext === undefined
                    ? {}
                    : {
                        sourceContext: executeRequest.sourceContext,
                      }),
                },
                executeRequest.expectedGeneration,
                executeRequest.requestId,
              ),
            ),
            Effect.tapError(() =>
              Effect.sync(() => {
                MutableRef.set(activeRequestId, null);
              }),
            ),
          );
        });

      const interrupt: ComputeChannel["interrupt"] = (interruptRequest) =>
        commandGate.withPermits(1)(
          ensureGeneration("interrupt", interruptRequest.expectedGeneration).pipe(
            Effect.andThen(
              requestResponse(
                "interrupt",
                {
                  type: "interrupt",
                  payload: {},
                  generation: interruptRequest.expectedGeneration,
                  requestId: interruptRequest.requestId,
                },
                {
                  type: "interrupt-result",
                  generation: interruptRequest.expectedGeneration,
                  requestId: interruptRequest.requestId,
                },
                DEFAULT_INTERRUPT_TIMEOUT_MS,
              ),
            ),
            // Rejected/timeout interrupts mean execution survived and may need restart escalation.
            // Return typed outcomes rather than collapsing them into broken-pipe errors.
            Effect.map(
              (message) => (message.payload as { result: ComputeInterruptOutcome }).result,
            ),
          ),
        );

      const inspectVariables: ComputeChannel["inspectVariables"] = (variablesRequest) =>
        commandGate.withPermits(1)(
          Effect.suspend(() => {
            if (MutableRef.get(transitioning)) {
              return Effect.fail(
                transportError("variables", "The runtime is changing generation."),
              );
            }
            if (MutableRef.get(activeRequestId) !== null) {
              return Effect.fail(transportError("variables", "An execution is already active."));
            }
            MutableRef.set(inspectingVariables, true);
            return ensureGeneration("variables", variablesRequest.expectedGeneration).pipe(
              Effect.andThen(
                requestResponse(
                  "variables",
                  {
                    type: "inspect-variables",
                    payload: {},
                    generation: variablesRequest.expectedGeneration,
                    requestId: variablesRequest.requestId,
                  },
                  {
                    type: "variables",
                    generation: variablesRequest.expectedGeneration,
                    requestId: variablesRequest.requestId,
                  },
                  DEFAULT_VARIABLES_TIMEOUT_MS,
                ),
              ),
              Effect.flatMap((message) => {
                const payload = message.payload as {
                  variables: ComputeVariableSnapshot["variables"];
                  truncated: boolean;
                  error: string | null;
                };
                return payload.error === null
                  ? Effect.succeed({
                      generation: variablesRequest.expectedGeneration,
                      variables: payload.variables,
                      truncated: payload.truncated,
                    } satisfies ComputeVariableSnapshot)
                  : Effect.fail(transportError("variables", payload.error));
              }),
              Effect.ensuring(
                Effect.sync(() => {
                  MutableRef.set(inspectingVariables, false);
                }),
              ),
            );
          }),
        );

      const restart: ComputeChannel["restart"] = (restartRequest) =>
        commandGate.withPermits(1)(
          ensureGeneration("restart", restartRequest.expectedGeneration).pipe(
            Effect.andThen(
              Effect.suspend(() =>
                restartRequest.nextGeneration ===
                nextComputeSessionGeneration(restartRequest.expectedGeneration)
                  ? Effect.void
                  : Effect.fail(
                      transportError(
                        "restart",
                        "Restart must advance exactly one session generation.",
                      ),
                    ),
              ),
            ),
            Effect.andThen(
              Effect.sync(() => {
                MutableRef.set(transitioning, true);
              }),
            ),
            Effect.andThen(
              requestResponse(
                "restart",
                {
                  type: "restart",
                  payload: { nextGeneration: restartRequest.nextGeneration },
                  generation: restartRequest.expectedGeneration,
                },
                { type: "restarted", generation: restartRequest.nextGeneration },
                startupTimeoutMs,
              ).pipe(Effect.tapError((error) => lose(error))),
            ),
            Effect.asVoid,
          ),
        );

      const shutdown: ComputeChannel["shutdown"] = (shutdownRequest) =>
        // Shutdown has its own bounded round trip; a slow restart cannot monopolize Stop.
        Effect.suspend(() => {
          if (MutableRef.get(closed)) return Effect.void;
          return ensureGeneration("shutdown", shutdownRequest.expectedGeneration).pipe(
            // Arm shutdown intent before sending: close/exit watchers can run before
            // shutdown-complete arrives. Clear it on round-trip failure so genuine loss reporting
            // resumes.
            Effect.andThen(
              Effect.sync(() => {
                MutableRef.set(stopping, true);
              }),
            ),
            Effect.andThen(
              requestResponse(
                "shutdown",
                {
                  type: "shutdown",
                  payload: {},
                  generation: shutdownRequest.expectedGeneration,
                },
                {
                  type: "shutdown-complete",
                  generation: shutdownRequest.expectedGeneration,
                },
                DEFAULT_SHUTDOWN_TIMEOUT_MS,
              ).pipe(
                // A shutdown without a reply is not clean. Withdraw intent and emit lost while the
                // failure reason is still known, or event consumers could wait forever for terminal
                // evidence.
                Effect.tapError((error) =>
                  Effect.sync(() => {
                    MutableRef.set(stopping, false);
                  }).pipe(Effect.andThen(lose(error))),
                ),
              ),
            ),
            Effect.andThen(
              cleanupOwnedProcess("shutdown").pipe(
                Effect.tapError((error) =>
                  Effect.sync(() => {
                    MutableRef.set(stopping, false);
                  }).pipe(Effect.andThen(lose(error))),
                ),
              ),
            ),
            Effect.andThen(
              Effect.sync(() => {
                MutableRef.set(closed, true);
              }),
            ),
            Effect.andThen(Queue.end(events)),
            Effect.asVoid,
          );
        }).pipe(shutdownGate.withPermits(1));

      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          // Reuse shutdown so protocol-close ordering has one owner. Bound and ignore failed/slow
          // goodbye during scope close, then tear down the process tree.
          if (!MutableRef.get(lost)) {
            yield* shutdown({ expectedGeneration: MutableRef.get(generation) }).pipe(
              Effect.timeoutOrElse({
                duration: DEFAULT_FINALIZER_SHUTDOWN_MS,
                orElse: () => Effect.void,
              }),
              Effect.ignore,
            );
          }
          MutableRef.set(closed, true);
          yield* failPending(transportError("shutdown", "Transport scope closed.")).pipe(
            Effect.ignore,
          );
          yield* Queue.end(events).pipe(Effect.ignore);
          // The spawn ownership finalizer runs after protocol shutdown. Release endpoint/runtime
          // leases only on proven cleanup; propagate failure through Scope.close so the session
          // retains host capacity.
        }),
      );

      const eventStream = Stream.fromQueue(events).pipe(
        Stream.map((weighted) => {
          const remaining = Math.max(0, MutableRef.get(eventBytes) - weighted.byteLength);
          MutableRef.set(eventBytes, remaining);
          if (MutableRef.get(droppingOutput) && remaining <= resumeEventQueueBytes) {
            MutableRef.set(droppingOutput, false);
          }
          return weighted.event;
        }),
      );

      return {
        events: eventStream,
        execute,
        interrupt,
        inspectVariables,
        restart,
        shutdown,
      } satisfies ComputeChannel;
    }),
  };
}
