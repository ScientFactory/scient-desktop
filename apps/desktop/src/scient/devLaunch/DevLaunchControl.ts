// @effect-diagnostics nodeBuiltinImport:off -- The controller talks to this channel over a local socket or named pipe.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";

import * as Effect from "effect/Effect";

import * as ElectronApp from "../../electron/ElectronApp.ts";
import * as DesktopWindow from "../../window/DesktopWindow.ts";

/**
 * The standing development app's controller (scripts/dev-app/) starts each
 * launch with a control address and a one-launch token. It asks this channel
 * whether the main window finished the renderer-ready handshake, brings the
 * window forward, or quits through the normal before-quit shutdown. Launches
 * without both variables (packaged apps, plain `pnpm dev:desktop`) never open it.
 */
const DEV_LAUNCH_CONTROL_ENV = "SCIENT_DEV_LAUNCH_CONTROL";
const DEV_LAUNCH_TOKEN_ENV = "SCIENT_DEV_LAUNCH_TOKEN";

const MAX_REQUEST_BYTES = 4 * 1024;
const REQUEST_TIMEOUT_MS = 5_000;

export interface DevLaunchControlConfig {
  readonly address: string;
  readonly token: string;
}

export type DevLaunchControlRequestType = "status" | "activate" | "quit";

export type DevLaunchControlResponse =
  | { readonly ok: true; readonly ready: boolean }
  | { readonly ok: false; readonly error: "invalid-request" | "unauthorized" };

export function readDevLaunchControlConfig(
  env: Readonly<Record<string, string | undefined>>,
): DevLaunchControlConfig | null {
  const address = env[DEV_LAUNCH_CONTROL_ENV]?.trim();
  const token = env[DEV_LAUNCH_TOKEN_ENV]?.trim();
  if (!address || !token || token.length < 32) return null;
  return { address, token };
}

function tokenMatches(expected: string, received: unknown): boolean {
  if (typeof received !== "string") return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(received);
  return a.length === b.length && NodeCrypto.timingSafeEqual(a, b);
}

function parseRequest(
  line: string,
  token: string,
): DevLaunchControlRequestType | DevLaunchControlResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return { ok: false, error: "invalid-request" };
  }
  if (typeof parsed !== "object" || parsed === null) return { ok: false, error: "invalid-request" };
  const request = parsed as { readonly token?: unknown; readonly type?: unknown };
  if (!tokenMatches(token, request.token)) return { ok: false, error: "unauthorized" };
  return request.type === "status" || request.type === "activate" || request.type === "quit"
    ? request.type
    : { ok: false, error: "invalid-request" };
}

export async function startDevLaunchControlServer(input: {
  readonly config: DevLaunchControlConfig;
  readonly isReady: () => boolean;
  readonly activate: () => void;
  readonly quit: () => void;
}): Promise<{ readonly close: () => Promise<void> }> {
  const sockets = new Set<NodeNet.Socket>();
  const server = NodeNet.createServer((socket) => {
    sockets.add(socket);
    socket.setEncoding("utf8");
    socket.setTimeout(REQUEST_TIMEOUT_MS, () => socket.destroy());
    let buffer = "";
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (buffer.length > MAX_REQUEST_BYTES) {
        socket.destroy();
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      const request = parseRequest(buffer.slice(0, newline), input.config.token);
      const respond = (response: DevLaunchControlResponse) =>
        socket.end(`${JSON.stringify(response)}\n`);
      if (typeof request !== "string") {
        respond(request);
        return;
      }
      if (request === "activate") input.activate();
      // Answer first: quitting closes this server.
      respond({ ok: true, ready: input.isReady() });
      if (request === "quit") input.quit();
    });
    socket.on("error", () => socket.destroy());
    socket.on("close", () => sockets.delete(socket));
  });

  // A Unix socket left by a crashed launch would block listen; the controller
  // gives every launch a fresh path inside its private runtime directory.
  const isNamedPipe = input.config.address.startsWith("\\\\.\\pipe\\");
  if (!isNamedPipe) await NodeFSP.rm(input.config.address, { force: true });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(input.config.address, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  if (!isNamedPipe) await NodeFSP.chmod(input.config.address, 0o600);

  return {
    close: () =>
      new Promise((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

let rendererReady = false;

/** Called beside DesktopAppActivation.setRendererReady for the main window. */
export function noteDevLaunchRendererReady(ready: boolean): void {
  rendererReady = ready;
}

export const start = Effect.gen(function* () {
  const config = readDevLaunchControlConfig(process.env);
  if (config === null) return;
  const desktopWindow = yield* DesktopWindow.DesktopWindow;
  const electronApp = yield* ElectronApp.ElectronApp;
  const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());
  yield* Effect.acquireRelease(
    Effect.tryPromise(() =>
      startDevLaunchControlServer({
        config,
        isReady: () => rendererReady,
        activate: () => void runPromise(desktopWindow.activate.pipe(Effect.ignoreCause)),
        quit: () => void runPromise(electronApp.quit),
      }),
    ),
    (server) => Effect.promise(() => server.close()),
  ).pipe(
    Effect.tap(() => Effect.logInfo("development launch control ready")),
    Effect.catchCause((cause) =>
      Effect.logWarning("development launch control unavailable", { cause }),
    ),
  );
});
