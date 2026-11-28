// @effect-diagnostics nodeBuiltinImport:off -- wacli's send delegate is a private Unix socket or Windows named pipe that speaks one JSON line each way.
/**
 * Sending through the running `wacli sync --follow` directly, over the delegate it opens for
 * other wacli commands (protocol version 1 of the pinned release): message text and recipients
 * never appear in a process's arguments, and there is no fallback that opens a second WhatsApp
 * session. See docs/internals/scient-whatsapp.md.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeNet from "node:net";

import * as Effect from "effect/Effect";

export type DelegateOutcome =
  /** Nothing accepted the request: it was not sent. */
  | { readonly _tag: "Unavailable" }
  /** The request went out but no complete reply came back: it may have been sent. */
  | { readonly _tag: "Lost" }
  | { readonly _tag: "Replied"; readonly reply: unknown };

/**
 * Where the running sync listens: `<store>/.send.sock` on macOS and Linux (`storeDir` is the path
 * wacli was given), a pipe named for the store's real path on Windows.
 */
export function delegateAddress(input: {
  readonly platform: NodeJS.Platform;
  readonly storeDir: string;
  readonly realStoreDir: string;
  readonly join: (...segments: ReadonlyArray<string>) => string;
}): string {
  if (input.platform !== "win32") return input.join(input.storeDir, ".send.sock");
  const digest = NodeCrypto.createHash("sha256")
    .update(input.realStoreDir.toLowerCase())
    .digest("hex");
  return `\\\\.\\pipe\\wacli-send-${digest}`;
}

/** One request and its one-line reply, within `timeoutMs`. */
export const callDelegate = (address: string, request: object, timeoutMs: number) =>
  Effect.callback<DelegateOutcome>((resume) => {
    let written = false;
    let settled = false;
    let buffered = "";
    const socket = NodeNet.createConnection(address);
    const finish = (outcome: DelegateOutcome) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resume(Effect.succeed(outcome));
    };
    const lostOrUnavailable = () => finish(written ? { _tag: "Lost" } : { _tag: "Unavailable" });
    const readReply = () => {
      const line = buffered.split("\n", 1)[0]?.trim() ?? "";
      if (line === "") return lostOrUnavailable();
      try {
        finish({ _tag: "Replied", reply: JSON.parse(line) });
      } catch {
        finish({ _tag: "Lost" });
      }
    };
    socket.setEncoding("utf8");
    socket.setTimeout(timeoutMs, lostOrUnavailable);
    socket.on("connect", () => {
      written = true;
      socket.write(`${JSON.stringify(request)}\n`);
    });
    socket.on("data", (chunk: string) => {
      buffered += chunk;
      if (buffered.includes("\n")) readReply();
    });
    socket.on("end", readReply);
    socket.on("error", lostOrUnavailable);
    socket.on("close", lostOrUnavailable);
    return Effect.sync(() => {
      settled = true;
      socket.destroy();
    });
  });
