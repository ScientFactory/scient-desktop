import type {
  EditorFlushRequest,
  EditorFlushResponse,
  EditorFlushStreamEvent,
  EnvironmentId,
} from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";

/**
 * One window's side of the editor flush for one environment, independent of
 * React renders: answers each request once per connection, and says goodbye
 * when the window closes (`pagehide`) or stops answering for this environment,
 * so the server forgets it at once instead of counting it as lost.
 */
export function createEditorFlushConsumerAtom<E>(options: {
  readonly requestsAtom: Atom.Atom<AsyncResult.AsyncResult<EditorFlushStreamEvent, E>>;
  readonly clientId: string;
  readonly environmentId: EnvironmentId;
  readonly flush: (
    request: EditorFlushRequest,
  ) => Promise<Pick<EditorFlushResponse, "saved" | "failures">>;
  readonly respond: (response: EditorFlushResponse) => Promise<unknown>;
  readonly leave: () => Promise<unknown>;
}): Atom.Atom<void> {
  return Atom.make((get) => {
    let disposed = false;
    let left = false;
    const leave = () => {
      if (left) return;
      left = true;
      void options.leave().catch(() => {
        // Without a goodbye the server keeps counting this window, failing closed.
      });
    };
    const answered = new Set<string>();
    const consume = (result: AsyncResult.AsyncResult<EditorFlushStreamEvent, E>) => {
      if (disposed || !AsyncResult.isSuccess(result) || result.value.type !== "request") return;
      const { connectionId, request } = result.value;
      // A request delivered again after a reconnect is answered again.
      const key = `${connectionId}\0${request.requestId}`;
      if (answered.has(key)) return;
      answered.add(key);
      const oldest = answered.values().next().value;
      if (answered.size > 256 && oldest !== undefined) answered.delete(oldest);
      void options
        .flush(request)
        .then((reply) =>
          disposed
            ? undefined
            : options.respond({
                clientId: options.clientId,
                requestId: request.requestId,
                ...reply,
              }),
        )
        .catch(() => {
          // The connection is gone; the server counts this window as unanswered.
        });
    };
    globalThis.addEventListener?.("pagehide", leave);
    get.addFinalizer(() => {
      disposed = true;
      globalThis.removeEventListener?.("pagehide", leave);
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
