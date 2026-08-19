// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalTimers:off -- Promise timeout bounds a live Node HTTP fixture.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import * as NodeTimers from "node:timers";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";

import {
  buildOverleafGitEnvironment,
  layer as executorLayer,
  OverleafGitExecutor,
  posixAskpassScript,
  windowsAskpassLauncher,
  windowsAskpassPowerShellScript,
} from "./OverleafGitExecutor.ts";
import { OverleafStateStore } from "./OverleafStateStore.ts";

const withTimeout = <A>(promise: Promise<A>, message: string) => {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = NodeTimers.setTimeout(() => reject(new Error(message)), 15_000);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) NodeTimers.clearTimeout(timer);
  });
};

// The managed Codex Windows sandbox denies taskkill/CIM process-tree access.
// Keep the live assertion enabled for normal developer machines and CI, where
// it verifies the same tree-kill primitive used by the packaged application.
const liveProcessTreeTest = NodeProcess.env.CODEX_PERMISSION_PROFILE !== undefined ? it.skip : it;
const testPlatform = NodeProcess.env.OS === "Windows_NT" ? "win32" : "linux";

describe("Overleaf Git credential boundary", () => {
  it("constructs a closed environment without ambient Git, SSH, proxy, trace, or Node values", () => {
    const env = buildOverleafGitEnvironment({
      home: "C:/state/runtime/op/home",
      temp: "C:/state/runtime/op/tmp",
      childPath: "C:/Program Files/Git/cmd;C:/Windows/System32",
      hooks: "C:/state/runtime/op/hooks",
      globalConfig: "C:/state/runtime/op/gitconfig",
      globalExcludes: "C:/state/runtime/op/excludes",
      askpass: "C:/state/runtime/op/askpass.cmd",
      tokenPath: "C:/state/runtime/op/token with spaces",
      identity: { name: "Human Author", email: "human@example.com" },
      windows: {
        systemRoot: "C:/Windows",
        systemDrive: "C:",
        comspec: "C:/Windows/System32/cmd.exe",
        pathext: ".COM;.EXE;.BAT;.CMD",
        appData: "C:/state/runtime/op/home/AppData/Roaming",
        localAppData: "C:/state/runtime/op/home/AppData/Local",
      },
    });

    expect(env).toMatchObject({
      GIT_TERMINAL_PROMPT: "0",
      GIT_ASKPASS_REQUIRE: "force",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "Human Author",
      GIT_COMMITTER_EMAIL: "human@example.com",
      SystemRoot: "C:/Windows",
      TEMP: "C:/state/runtime/op/tmp",
    });
    expect(
      Object.keys(env).some((key) => /^(?:SSH_|https?_proxy|GIT_TRACE|NODE_OPTIONS)/iu.test(key)),
    ).toBe(false);
    expect(Object.values(env).join("\n")).not.toContain("AI");
    expect(Object.values(env).join("\n")).not.toContain("LLM");
  });

  it("uses newline-free askpass output and a packaged-app-independent Windows runtime", () => {
    const script = windowsAskpassPowerShellScript();
    const launcher = windowsAskpassLauncher(
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      "C:\\state with spaces\\askpass.ps1",
    );
    expect(script).toContain("File]::ReadAllText");
    expect(script).toContain("Console]::Out.Write");
    expect(script).not.toMatch(/WriteLine|\btype\b/iu);
    expect(launcher).toContain('powershell.exe"');
    expect(launcher).not.toContain("node");
    expect(launcher).not.toContain("ELECTRON_RUN_AS_NODE");
    expect(posixAskpassScript()).toContain("printf '%s'");
  });

  liveProcessTreeTest(
    "kills the remote-helper process tree before deleting operation credentials",
    async () => {
      const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "overleaf-git-executor-"));
      const runtimeRoot = NodePath.join(root, "runtime");
      const operationId = NodeCrypto.randomUUID();
      let resolveAuthenticated!: (authorization: string) => void;
      let resolveSocketClosed!: () => void;
      const authenticated = new Promise<string>((resolve) => {
        resolveAuthenticated = resolve;
      });
      const socketClosed = new Promise<void>((resolve) => {
        resolveSocketClosed = resolve;
      });
      const server = NodeHttp.createServer((request, response) => {
        const authorization = request.headers.authorization;
        if (!authorization) {
          response.writeHead(401, { "WWW-Authenticate": 'Basic realm="Overleaf test"' });
          response.end();
          return;
        }
        resolveAuthenticated(authorization);
        request.socket.once("close", resolveSocketClosed);
        // Deliberately leave the authenticated request open. Interrupting the
        // executor must terminate git and its git-remote-http descendant.
      });
      try {
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(0, "127.0.0.1", () => resolve());
        });
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("HTTP fixture did not bind.");
        const state = OverleafStateStore.of({
          runtimeRoot,
          newId: Effect.sync(() => NodeCrypto.randomUUID()),
        } as unknown as OverleafStateStore["Service"]);
        const testLayer = executorLayer.pipe(
          Layer.provide(Layer.succeed(OverleafStateStore, state)),
          Layer.provide(Layer.succeed(HostProcessPlatform, testPlatform)),
          Layer.provideMerge(NodeServices.layer),
        );
        // The Node HTTP fixture is deliberately outside the Effect test runtime;
        // this single bridge keeps its listen/close lifecycle in one async owner.
        // oxlint-disable-next-line t3code/no-manual-effect-runtime-in-tests -- The live Node HTTP fixture owns this single async bridge.
        const authorization = await Effect.runPromise(
          Effect.gen(function* () {
            const executor = yield* OverleafGitExecutor;
            const fiber = yield* Effect.forkChild(
              executor.execute({
                operationId,
                cwd: root,
                args: [
                  "-c",
                  "protocol.http.allow=always",
                  "ls-remote",
                  `http://127.0.0.1:${address.port}/project`,
                ],
                token: new TextEncoder().encode("token with spaces"),
                timeoutMs: 60_000,
              }),
            );
            const header = yield* Effect.promise(() =>
              withTimeout(authenticated, "Git did not reach the authenticated HTTP request."),
            );
            yield* Fiber.interrupt(fiber);
            yield* Effect.promise(() =>
              withTimeout(socketClosed, "The git-remote-http descendant kept its socket open."),
            );
            return header;
          }).pipe(Effect.provide(testLayer), Effect.scoped),
        );
        expect(Buffer.from(authorization.replace(/^Basic /u, ""), "base64").toString("utf8")).toBe(
          "git:token with spaces",
        );
        await expect(NodeFSP.stat(NodePath.join(runtimeRoot, operationId))).rejects.toMatchObject({
          code: "ENOENT",
        });
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        // Windows can briefly retain a directory handle after taskkill reports the
        // process tree exited. Retry the fixture-root cleanup, while the stronger
        // credential-directory and socket assertions above remain immediate.
        await NodeFSP.rm(root, {
          recursive: true,
          force: true,
          maxRetries: 10,
          retryDelay: 100,
        });
      }
    },
    30_000,
  );
});
