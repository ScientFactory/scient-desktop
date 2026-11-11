/**
 * An opened Office document: its engine worker and what the reader shows of it. It lives apart from
 * the viewer so a reader that comes back to the file finds it laid out (see officeDocuments.ts).
 */
export interface OfficeSession<State> {
  readonly state: () => State;
  /** About how much memory the engine holds, in bytes; its WebAssembly memory never shrinks. */
  readonly memory: () => number;
  /** The engine failed; a viewer coming back opens a new one. */
  readonly failed: () => boolean;
  /** Calls `listener` with each new state; returns the unsubscribe. */
  readonly subscribe: (listener: (state: State) => void) => () => void;
  readonly close: () => void;
}

/** A place for the session a viewer opens, kept with the document it belongs to. */
export interface OfficeSessionSlot {
  current: {
    readonly close: () => void;
    readonly memory: () => number;
    readonly failed: () => boolean;
  } | null;
}

/** A small store for a session's state. */
export function sessionState<State>(initial: State) {
  let state = initial;
  const listeners = new Set<(state: State) => void>();
  return {
    get: () => state,
    set: (next: State) => {
      state = next;
      for (const listener of listeners) listener(state);
    },
    subscribe: (listener: (state: State) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/**
 * The session in `slot`, or a new one from `open` stored there. Without a slot the caller owns the
 * session and closes it; with one, the slot's owner does.
 */
export function slotSession<Session extends NonNullable<OfficeSessionSlot["current"]>>(
  slot: OfficeSessionSlot | undefined,
  open: () => Session,
): { readonly session: Session; readonly release: () => void } {
  if (!slot) {
    const session = open();
    return { session, release: session.close };
  }
  const session = (slot.current as Session | null) ?? open();
  slot.current = session;
  return { session, release: () => undefined };
}
