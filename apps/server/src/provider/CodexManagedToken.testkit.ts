// @effect-diagnostics nodeBuiltinImport:off - Synthetic broker tests use a real private IPC connection.
import * as NodeNet from "node:net";
import * as Effect from "effect/Effect";

export const brokerClient = Effect.fn("CodexManagedTokenTestkit.brokerClient")(
  (endpoint: string, request: unknown) =>
    Effect.acquireRelease(
      Effect.callback<{ socket: NodeNet.Socket; response: Promise<string> }, Error>((resume) => {
        const socket = NodeNet.createConnection(endpoint);
        let text = "";
        socket.setEncoding("utf8");
        socket.on("data", (chunk) => {
          text += chunk;
        });
        const response = new Promise<string>((resolve) =>
          socket.once("close", () => resolve(text)),
        );
        socket.on("error", () => {});
        socket.once("error", (error) => resume(Effect.fail(error)));
        socket.once("connect", () => {
          socket.write(JSON.stringify(request) + "\n");
          resume(Effect.succeed({ socket, response }));
        });
        return Effect.sync(() => {
          if (socket.connecting) socket.destroy();
        });
      }),
      ({ socket }) => Effect.sync(() => socket.destroy()),
    ),
);
