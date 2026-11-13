// @effect-diagnostics nodeBuiltinImport:off -- A local HTTP remote returns real Git bridge failures.
import * as NodeHttp from "node:http";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { isRefusedBeforeSending, OverleafGitError } from "./OverleafGitExecutor.ts";
import { withExecutor } from "./OverleafGitExecutor.testkit.ts";
import { gitRefusal } from "./OverleafProtocolProbe.ts";
import { parsePushPorcelain } from "./OverleafRepository.ts";

/** A local HTTP remote answering every request with `answer`; its port. */
const serve = (answer: NodeHttp.RequestListener) =>
  Effect.acquireRelease(
    Effect.promise(
      () =>
        new Promise<NodeHttp.Server>((resolve, reject) => {
          const server = NodeHttp.createServer(answer);
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
  ).pipe(
    Effect.flatMap((server) => {
      const address = server.address();
      return address === null || typeof address === "string"
        ? Effect.die("No HTTP test port")
        : Effect.succeed(address.port);
    }),
  );

const pkt = (line: string) => `${(line.length + 4).toString(16).padStart(4, "0")}${line}`;

describe("Overleaf project access failures", () => {
  it.effect("classifies real Git responses from missing and forbidden HTTP repositories", () =>
    withExecutor(({ git, work }) =>
      Effect.gen(function* () {
        const port = yield* serve((request, response) => {
          response.writeHead(request.url?.startsWith("/missing/") ? 404 : 403, {
            "content-type": "text/plain",
          });
          response.end("Project unavailable");
        });
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
                `http://127.0.0.1:${port}/${path}/`,
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

  it.effect("tells a push refused before any pack went out from one that failed after", () =>
    withExecutor(({ git, work }) =>
      Effect.gen(function* () {
        const port = yield* serve((request, response) => {
          const stage = request.url?.split("/")[1] ?? "";
          request.resume();
          request.on("end", () => {
            if (request.url?.includes("/info/refs")) {
              if (stage === "forbidden" || stage === "missing") {
                response.writeHead(stage === "missing" ? 404 : 403, {
                  "content-type": "text/plain",
                });
                return response.end("Project unavailable");
              }
              response.writeHead(200, {
                "content-type": "application/x-git-receive-pack-advertisement",
              });
              return response.end(
                `${pkt("# service=git-receive-pack\n")}0000${
                  stage === "no-access"
                    ? pkt("ERR no git access\n")
                    : `${pkt(`${"0".repeat(40)} capabilities^{}\0report-status\n`)}0000`
                }`,
              );
            }
            if (stage === "pack-forbidden") {
              response.writeHead(403, { "content-type": "text/plain" });
              return response.end("Project unavailable");
            }
            response.writeHead(200, { "content-type": "application/x-git-receive-pack-result" });
            response.end(pkt("ERR no git access\n"));
          });
        });
        const repo = `${work}/repo`;
        yield* git.execute({ cwd: work, args: ["init", "-q", repo] });
        const tree = new TextDecoder()
          .decode((yield* git.execute({ cwd: repo, args: ["mktree"] })).stdout)
          .trim();
        const commit = new TextDecoder()
          .decode(
            (yield* git.execute({ cwd: repo, args: ["commit-tree", tree, "-m", "send"] })).stdout,
          )
          .trim();
        const push = (stage: string) =>
          git.execute({
            cwd: repo,
            args: [
              "-c",
              "protocol.http.allow=always",
              "push",
              "--porcelain",
              `http://127.0.0.1:${port}/${stage}/`,
              `${commit}:refs/heads/main`,
            ],
            acceptExitCodes: [1],
          });
        for (const [stage, reason] of [
          ["forbidden", "access-denied"],
          ["missing", "project-not-found"],
          ["no-access", "project-not-found"],
        ] as const) {
          const error = yield* Effect.flip(push(stage));
          expect(isRefusedBeforeSending(error)).toBe(true);
          expect(gitRefusal(error)).toBe(reason);
        }
        // After the pack went out Git exits 1 with no ref status: an unknown outcome.
        for (const stage of ["pack-forbidden", "pack-no-access"]) {
          const result = yield* push(stage);
          expect(result.exitCode).toBe(1);
          expect(
            parsePushPorcelain(new TextDecoder().decode(result.stdout), result.stderr)._tag,
          ).toBe("unknown");
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
