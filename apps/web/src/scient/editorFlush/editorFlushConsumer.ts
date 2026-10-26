import type {
  EditorFlushRequest,
  EditorFlushResponse,
  EditorFlushStreamEvent,
  EnvironmentId,
} from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";

/**
 * Answer only on the request's still-current connection; discard late replaced-connection replies.
 * Send one goodbye on actual close/environment exit, but none for back-forward-cache pages
 * retaining drafts; register immediately on restoration.
 */
export function createEditorFlushConsumerAtom<E>(options: {
  readonly requestsAtom: Atom.Atom<AsyncResult.AsyncResult<EditorFlushStreamEvent, E>>;
  readonly clientId: string;
  readonly environmentId: EnvironmentId;
  readonly flush: (
    request: EditorFlushRequest,
    connectionId: string,
  ) => Promise<Pick<EditorFlushResponse, "saved" | "failures">>;
  readonly respond: (response: EditorFlushResponse) => Promise<unknown>;
  readonly leave: (connectionId: string) => Promise<unknown>;
  /** Registers this window again, on a new connection. */
  readonly reconnect: () => void;
}): Atom.Atom<void> {
  return Atom.make((get) => {
    let disposed = false;
    /** The window's latest connection: the only one it answers or says goodbye on. */
    let current: string | null = null;
    /** The connection it already said goodbye for. */
    let leftOn: string | null = null;
    const leave = () => {
      if (current === null || leftOn === current) return;
      leftOn = current;
      void options.leave(current).catch(() => {
        // Without a goodbye the server keeps counting this window, failing closed.
      });
    };
    const answered = new Set<string>();
    const consume = (result: AsyncResult.AsyncResult<EditorFlushStreamEvent, E>) => {
      if (disposed || !AsyncResult.isSuccess(result)) return;
      const event = result.value;
      if (event.type === "connected") {
        current = event.connectionId;
        return;
      }
      current ??= event.connectionId;
      const { connectionId, request } = event;
      if (connectionId !== current) return;
      // A request delivered again after a reconnect is answered again.
      const key = `${connectionId}\0${request.requestId}`;
      if (answered.has(key)) return;
      answered.add(key);
      const oldest = answered.values().next().value;
      if (answered.size > 256 && oldest !== undefined) answered.delete(oldest);
      void options
        .flush(request, connectionId)
        .then((reply) =>
          disposed || connectionId !== current
            ? undefined
            : options.respond({
                clientId: options.clientId,
                connectionId,
                requestId: request.requestId,
                ...reply,
              }),
        )
        .catch(() => {
          // The connection is gone; the server counts this window as unanswered.
        });
    };
    const pageHidden = (event: Event) => {
      if (!(event as PageTransitionEvent).persisted) leave();
    };
    const pageShown = (event: Event) => {
      if ((event as PageTransitionEvent).persisted && !disposed) options.reconnect();
    };
    globalThis.addEventListener?.("pagehide", pageHidden);
    globalThis.addEventListener?.("pageshow", pageShown);
    get.addFinalizer(() => {
      disposed = true;
      globalThis.removeEventListener?.("pagehide", pageHidden);
      globalThis.removeEventListener?.("pageshow", pageShown);
      leave();
    });
    // Subscribe before reading the cached value; request ids prevent answering twice.
    const initial = get.once(options.requestsAtom);
    get.subscribe(options.requestsAtom, consume);
    consume(initial);
  }).pipe(
    Atom.setIdleTTL(0),
    Atom.withLabel(`scient-editor-flush:${options.environmentId}:${options.clientId}`),
  );
}
