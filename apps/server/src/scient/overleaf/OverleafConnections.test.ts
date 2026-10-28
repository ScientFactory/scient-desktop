// @effect-diagnostics nodeBuiltinImport:off -- A local HTTP remote returns real Git bridge failures.
import * as NodeHttp from "node:http";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { gitRefusal } from "./OverleafConnections.ts";
import { OverleafGitError } from "./OverleafGitExecutor.ts";
import { withExecutor } from "./OverleafGitExecutor.testkit.ts";

describe("Overleaf project access failures", () => {
  it.effect("classifies real Git responses from missing and forbidden HTTP repositories", () =>
    withExecutor(({ git, work }) =>
      Effect.gen(function* () {
        const server = yield* Effect.acquireRelease(
          Effect.promise(
            () =>
              new Promise<NodeHttp.Server>((resolve, reject) => {
                const server = NodeHttp.createServer((request, response) => {
                  response.writeHead(request.url?.startsWith("/missing/") ? 404 : 403, {
                    "content-type": "text/plain",
                  });
                  response.end("Project unavailable");
                });
                server.once("error", reject);
                server.listen(0, "127.0.0.1", () => resolve(server));
              }),
          ),
          (server) =>
            Effect.promise(
              () =>
                new Promise<void>((resolve, reject) =>
                  server.close((error) => (error ? reject(error) : resolve())),
                ),
            ),
        );
        const address = server.address();
        if (address === null || typeof address === "string")
          return yield* Effect.die("No HTTP test port");
        for (const [path, reason] of [
          ["missing", "project-not-found"],
          ["forbidden", "access-denied"],
        ] as const) {
          const error = yield* Effect.flip(
            git.execute({
              cwd: work,
              // Only this synthetic remote may use HTTP; production remotes stay HTTPS-only.
              args: [
                "-c",
                "protocol.http.allow=always",
                "ls-remote",
                `http://127.0.0.1:${address.port}/${path}/`,
              ],
            }),
          );
          expect(error.reason).toBe("non-zero-exit");
          expect(gitRefusal(error)).toBe(reason);
          expect(error.message).not.toContain("http://");
        }
      }).pipe(Effect.scoped),
    ),
  );

  it("recognizes the Git bridge's text-only authorization response", () => {
    expect(
      gitRefusal(
        new OverleafGitError({
          reason: "non-zero-exit",
          exitCode: 128,
          detail:
            "remote: You are not authorized to access this project.\nfatal: Could not read from remote repository.",
        }),
      ),
    ).toBe("access-denied");
    expect(
      gitRefusal(
        new OverleafGitError({
          reason: "non-zero-exit",
          exitCode: 128,
          detail: "fatal: unexpected remote response",
        }),
      ),
    ).toBe("git-failed");
  });
});
