/**
 * Probe and redactor must parse identical SSE streams. Treat split CRLF as one terminator and
 * charge all its raw bytes to the ending event, never the next one, so chunk boundaries cannot
 * bypass event limits.
 */

/** One dispatched event: fields as received (data lines not yet joined). */
export interface SseEvent {
  data: string[] | undefined;
  event: string | undefined;
  id: string | undefined;
  retry: string | undefined;
}

export interface SseSink {
  /** A dispatched event. Returning false stops the parser (`"stopped"`). */
  readonly onEvent: (event: SseEvent) => boolean;
  /** One comment line (its content is never surfaced). */
  readonly onComment: () => void;
}

/** `continue` until the sink stopped the parser or an event exceeded the byte cap. */
export type SseFeed = "continue" | "stopped" | "too-large";

export interface SseParser {
  /** Feeds raw upstream bytes. */
  readonly push: (chunk: Uint8Array, sink: SseSink) => SseFeed;
  /**
   * End of upstream. An event held at a chunk-ending CR is dispatched; any
   * other event without its terminating blank line is incomplete and, per the
   * SSE specification, discarded.
   */
  readonly end: (sink: SseSink) => SseFeed;
}

const emptyEvent = (): SseEvent => ({
  data: undefined,
  event: undefined,
  id: undefined,
  retry: undefined,
});

export const makeSseParser = (maxEventBytes: number): SseParser => {
  const decoder = new TextDecoder();
  let line = "";
  let eventBytes = 0;
  let event = emptyEvent();
  let state: SseFeed = "continue";
  /**
   * A chunk ended on CR. A following LF belongs to the same line ending, so it
   * is charged to the event that owns the CR (and is never charged to the next).
   */
  let pendingCarriageReturn = false;
  /** The pending CR ended a dispatch line whose event had room for its LF. */
  let lineFeedOwnedByDispatched = false;
  /**
   * The pending CR ended a dispatch line exactly at the cap: the event is held
   * until we know whether an LF (making it one byte too large) follows.
   */
  let dispatchDeferred = false;

  const finish = (result: SseFeed): SseFeed => {
    state = result;
    return result;
  };

  /** Handles one complete line; false when the sink stopped. */
  const handleLine = (complete: string, sink: SseSink): boolean => {
    if (complete.length === 0) {
      const dispatched = event;
      event = emptyEvent();
      eventBytes = 0;
      return sink.onEvent(dispatched);
    }
    if (complete.startsWith(":")) {
      sink.onComment();
      return true;
    }
    const colon = complete.indexOf(":");
    const name = colon === -1 ? complete : complete.slice(0, colon);
    const value = colon === -1 ? "" : complete.slice(colon + 1).replace(/^ /, "");
    switch (name) {
      case "data":
        (event.data ??= []).push(value);
        break;
      case "event":
        event.event = value;
        break;
      case "id":
        if (!value.includes("\u0000")) event.id = value;
        break;
      case "retry":
        event.retry = value;
        break;
      default:
        break;
    }
    return true;
  };

  const push = (chunk: Uint8Array, sink: SseSink): SseFeed => {
    if (state !== "continue") return state;
    const text = decoder.decode(chunk, { stream: true });
    if (text.length === 0) return state;
    let index = 0;
    if (pendingCarriageReturn) {
      pendingCarriageReturn = false;
      const lineFeed = text.charCodeAt(0) === 10;
      if (lineFeed) index = 1;
      if (dispatchDeferred) {
        dispatchDeferred = false;
        // The LF completes a CRLF that takes the held event past the cap.
        if (lineFeed) return finish("too-large");
        if (!handleLine("", sink)) return finish("stopped");
      } else if (lineFeed && !lineFeedOwnedByDispatched) {
        // The LF of a CRLF split across chunks, charged to its own event.
        eventBytes += 1;
        if (eventBytes > maxEventBytes) return finish("too-large");
      }
      lineFeedOwnedByDispatched = false;
    }
    let nextCr = text.indexOf("\r", index);
    let nextLf = text.indexOf("\n", index);
    while (index < text.length) {
      if (nextCr !== -1 && nextCr < index) nextCr = text.indexOf("\r", index);
      if (nextLf !== -1 && nextLf < index) nextLf = text.indexOf("\n", index);
      const end = nextCr === -1 ? nextLf : nextLf === -1 ? nextCr : Math.min(nextCr, nextLf);
      const piece = text.slice(index, end === -1 ? text.length : end);
      const crlf = end !== -1 && text.charCodeAt(end) === 13 && text.charCodeAt(end + 1) === 10;
      eventBytes += Buffer.byteLength(piece, "utf8") + (end === -1 ? 0 : crlf ? 2 : 1);
      if (eventBytes > maxEventBytes) return finish("too-large");
      line += piece;
      if (end === -1) break;
      const chunkEndingCr = !crlf && text.charCodeAt(end) === 13 && end + 1 === text.length;
      index = crlf ? end + 2 : end + 1;
      const complete = line;
      line = "";
      if (chunkEndingCr) {
        pendingCarriageReturn = true;
        if (complete.length === 0) {
          if (eventBytes + 1 > maxEventBytes) {
            dispatchDeferred = true;
            break;
          }
          lineFeedOwnedByDispatched = true;
        }
      }
      if (!handleLine(complete, sink)) return finish("stopped");
    }
    return state;
  };

  const end = (sink: SseSink): SseFeed => {
    if (state !== "continue") return state;
    if (dispatchDeferred) {
      dispatchDeferred = false;
      // The stream's last byte was the CR that ended the held event.
      if (!handleLine("", sink)) return finish("stopped");
    }
    return state;
  };

  return { push, end };
};
