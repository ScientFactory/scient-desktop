import type {
  EnvironmentId,
  ScientDocumentHostRequest,
  ScientDocumentHostResponse,
  ScientDocumentHostStreamEvent,
} from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";

/** Expected public document-host failures; arbitrary renderer causes are never serialized. */
export class ScientDocumentHostExecutionError extends Error {
  readonly _tag = "ScientDocumentHostExecutionError";
}

export function serializeScientDocumentHostError(
  error: unknown,
  environmentId: EnvironmentId,
  request: ScientDocumentHostRequest,
): NonNullable<ScientDocumentHostResponse["error"]> {
  return {
    _tag: "ScientDocumentHostExecutionError",
    message:
      error instanceof ScientDocumentHostExecutionError
        ? error.message
        : "The controlled document operation failed.",
    detail: {
      environmentId,
      threadId: request.threadId,
      requestId: request.requestId,
      operation: request.operation,
    },
  };
}

export interface ScientDocumentRequestHandler {
  readonly handle: (request: ScientDocumentHostRequest, signal: AbortSignal) => Promise<unknown>;
}

/** Owns every stream emission independently of React renders, with one leased connection generation. */
export function createScientDocumentHostRequestConsumerAtom<E>(options: {
  readonly requestsAtom: Atom.Atom<AsyncResult.AsyncResult<ScientDocumentHostStreamEvent, E>>;
  readonly clientId: string;
  readonly environmentId: EnvironmentId;
  readonly requestHandlerAtom: Atom.Atom<ScientDocumentRequestHandler>;
  readonly respond: (response: ScientDocumentHostResponse) => Promise<unknown>;
}): Atom.Atom<void> {
  return Atom.make((get) => {
    get.mount(options.requestHandlerAtom);
    let disposed = false;
    type Generation = {
      readonly connectionId: string;
      readonly controller: AbortController;
      readonly pending: Set<string>;
      readonly completed: Set<string>;
      announced: boolean;
    };
    let active: Generation | null = null;
    const retired = new Set<string>();
    const retire = () => {
      if (!active) return;
      retired.add(active.connectionId);
      active.controller.abort();
      active = null;
      const oldest = retired.values().next().value;
      if (retired.size > 256 && oldest !== undefined) retired.delete(oldest);
    };
    const open = (connectionId: string, announced: boolean): Generation => {
      retire();
      const generation = {
        connectionId,
        announced,
        controller: new AbortController(),
        pending: new Set<string>(),
        completed: new Set<string>(),
      };
      active = generation;
      return generation;
    };
    const isLive = (generation: Generation) =>
      !disposed && active === generation && !generation.controller.signal.aborted;
    const consume = (result: AsyncResult.AsyncResult<ScientDocumentHostStreamEvent, E>) => {
      if (disposed) return;
      if (!AsyncResult.isSuccess(result) || result.waiting) {
        retire();
        return;
      }
      const event = result.value;
      if (event.type === "connected") {
        if (active?.connectionId === event.connectionId) active.announced = true;
        else open(event.connectionId, true);
        return;
      }
      if (retired.has(event.connectionId) && active?.connectionId !== event.connectionId) return;
      let generation = active;
      if (generation === null) generation = open(event.connectionId, false);
      else if (generation.connectionId !== event.connectionId) {
        if (generation.announced) return;
        generation = open(event.connectionId, false);
      }
      const request = event.request;
      if (generation.pending.has(request.requestId) || generation.completed.has(request.requestId))
        return;
      generation.pending.add(request.requestId);
      const current = generation;
      const signal = current.controller.signal;
      void Promise.resolve()
        .then(() => {
          if (!isLive(current)) return;
          return get.once(options.requestHandlerAtom).handle(request, signal);
        })
        .then(
          (value) =>
            isLive(current)
              ? options.respond({
                  clientId: options.clientId,
                  connectionId: current.connectionId,
                  requestId: request.requestId,
                  ok: true,
                  ...(value === undefined ? {} : { result: value }),
                })
              : undefined,
          (error) =>
            isLive(current)
              ? options.respond({
                  clientId: options.clientId,
                  connectionId: current.connectionId,
                  requestId: request.requestId,
                  ok: false,
                  error: serializeScientDocumentHostError(error, options.environmentId, request),
                })
              : undefined,
        )
        .catch(() => {
          // A retired/broken transport cannot accept this receipt. The server owns its request timeout.
        })
        .finally(() => {
          current.pending.delete(request.requestId);
          if (!isLive(current)) return;
          current.completed.add(request.requestId);
          const oldest = current.completed.values().next().value;
          if (current.completed.size > 256 && oldest !== undefined)
            current.completed.delete(oldest);
        });
    };
    get.addFinalizer(() => {
      disposed = true;
      retire();
    });
    // Subscribe before inspecting the cached value; request IDs prevent duplicate initial delivery.
    const initial = get.once(options.requestsAtom);
    get.subscribe(options.requestsAtom, consume);
    consume(initial);
  }).pipe(
    Atom.setIdleTTL(0),
    Atom.withLabel(`scient-document-host:${options.environmentId}:${options.clientId}`),
  );
}
