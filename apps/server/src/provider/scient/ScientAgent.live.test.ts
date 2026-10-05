// @effect-diagnostics nodeBuiltinImport:off
/**
 * Opt-in suite against a real Scient Agent executable. Each part runs only
 * when its variables are set, so CI reports it as skipped rather than passed:
 *
 * - `SCIENT_AGENT_QUALIFY_BINARY`: the `scient-agent` executable to qualify.
 * - `OMP_QUALIFY_BINARY`: an `omp` executable, for the coexistence cases.
 * - `SCIENT_AGENT_QUALIFY_FULL_TURN=1`: also run a turn against a real model
 *   (`OMP_QUALIFY_MODEL`, default a local Ollama model).
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { createModelSelection } from "@t3tools/shared/model";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";

import { nativeOmpSession, watchNativeOmpTextTurn } from "../testUtils/nativeOmpSession.ts";
import { checkOmpProviderStatus } from "../Layers/OmpProvider.ts";
import * as OmpExecutableGate from "../omp/OmpExecutableGate.ts";
import { ompLiveInstance, ompQualifyBinary, ompQualifyModel } from "../omp/OmpLive.testFixtures.ts";
import {
  makeOmpRpcProcess,
  OMP_ISOLATED_ARGS,
  type OmpRpcProcessOptions,
} from "../omp/OmpRpcProcess.ts";
import { ompTarget } from "../omp/OmpTarget.ts";
import { ProviderConnectionActionError } from "../../scient/providerLifecycle/ProviderConnectionActions.ts";
import {
  makeScientAgentConnectionActions,
  readScientAgentAccounts,
} from "../../scient/providerLifecycle/ScientAgentConnectionActions.ts";
import { scientAgentProcessEnvironment, scientAgentTarget } from "./ScientAgentTarget.ts";

const scientAgentBinary = process.env.SCIENT_AGENT_QUALIFY_BINARY || undefined;
const fullTurn = process.env.SCIENT_AGENT_QUALIFY_FULL_TURN === "1";
const binary = scientAgentBinary ?? "";
const layer = Layer.mergeAll(NodeServices.layer, OmpExecutableGate.layer);

/** The production process factory, leasing from this test's executable gate. */
const gatedProcess = Effect.map(
  OmpExecutableGate.OmpExecutableGate,
  (gate) => (options: OmpRpcProcessOptions) =>
    makeOmpRpcProcess(options).pipe(
      Effect.provideService(OmpExecutableGate.OmpExecutableGate, gate),
    ),
);

/** A fresh directory with a home the user "owns" and the state directory Scient owns. */
const makeRoot = (label: string) => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), `scient-agent-live-${label}-`));
  const home = NodePath.join(root, "home");
  const stateDir = NodePath.join(root, "state");
  NodeFS.mkdirSync(home, { recursive: true });
  NodeFS.mkdirSync(stateDir, { recursive: true });
  return { root, home, stateDir, attachmentsDir: NodePath.join(root, "attachments") };
};

/** A Scient Agent instance built the way the driver builds one. */
const scientAgentInstance = (home: string, stateDir: string, instanceId: string) => {
  const agentRoot = NodePath.join(
    stateDir,
    scientAgentTarget.stateNamespace,
    "instances",
    instanceId,
  );
  NodeFS.mkdirSync(agentRoot, { recursive: true });
  return {
    agentRoot,
    environment: scientAgentProcessEnvironment({
      baseEnv: {
        PATH: process.env.PATH ?? "",
        HOME: home,
        USERPROFILE: home,
        HTTPS_PROXY: "http://127.0.0.1:9",
        HTTP_PROXY: "http://127.0.0.1:9",
        NO_PROXY: "127.0.0.1,localhost",
      },
      root: agentRoot,
      platform: HostProcessPlatform.defaultValue(),
    }),
  };
};

const settings = (binaryPath: string) => ({ enabled: true, binaryPath });

/**
 * One model that is never called, so a test that runs no turn starts on a
 * machine with no model keys and no local model server.
 */
const writeStubModel = (agentRoot: string): void => {
  const agentDir = NodePath.join(agentRoot, "agent");
  NodeFS.mkdirSync(agentDir, { recursive: true });
  NodeFS.writeFileSync(
    NodePath.join(agentDir, "models.yml"),
    [
      "providers:",
      "  scient-agent-live-test:",
      "    baseUrl: http://127.0.0.1:9/v1",
      "    api: openai-completions",
      "    auth: none",
      "    models:",
      "      - id: stub",
      "        name: Live test stub",
      "        input: [text]",
      "        contextWindow: 8192",
      "        maxTokens: 1024",
      "",
    ].join("\n"),
  );
};

/**
 * What the agent left in the user's home directory, apart from the Bun
 * runtime's own transpiler cache (`~/Library/Caches/bun` on macOS), which
 * every Bun program writes.
 */
const homeEntries = (home: string): ReadonlyArray<string> =>
  NodeFS.readdirSync(home)
    .filter((name) => name !== "Library" && name !== ".cache")
    .toSorted();

/** Every path under `directory`, relative to it. */
const tree = (directory: string): ReadonlyArray<string> =>
  NodeFS.existsSync(directory)
    ? (NodeFS.readdirSync(directory, { recursive: true }) as ReadonlyArray<string>).toSorted()
    : [];

describe.runIf(scientAgentBinary)("real Scient Agent", () => {
  it.effect("is recognised and reports its models", () =>
    Effect.gen(function* () {
      const { root, home, stateDir } = makeRoot("status");
      const { environment } = scientAgentInstance(home, stateDir, "scient");
      const result = yield* checkOmpProviderStatus(
        scientAgentTarget,
        settings(binary),
        environment,
        yield* gatedProcess,
        root,
      );
      expect(result.status).toBe("ready");
      expect(result.version).toMatch(/^0\.\d+\.\d+/u);
      expect(result.models.length).toBeGreaterThan(0);
      NodeFS.rmSync(root, { recursive: true, force: true });
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("lists its sign-ins and runs one the way Scient's sign-in screen does", () =>
    Effect.gen(function* () {
      const { root, home, stateDir } = makeRoot("sign-in");
      const { environment } = scientAgentInstance(home, stateDir, "scient");
      const makeProcess = yield* gatedProcess;
      const status = yield* checkOmpProviderStatus(
        scientAgentTarget,
        settings(binary),
        environment,
        makeProcess,
        root,
        readScientAgentAccounts,
      );
      const accounts = status.accounts ?? [];
      expect(accounts.find((entry) => entry.id === "openai-codex")?.kind).toBe("account");
      // A new root has no stored sign-in, so there is nothing to sign out of.
      expect(accounts.find((entry) => entry.id === "openrouter")).toMatchObject({
        kind: "account",
        canDisconnect: false,
      });
      expect(accounts.some((entry) => entry.kind === "key")).toBe(true);

      const actions = makeScientAgentConnectionActions({
        open: makeProcess({
          target: scientAgentTarget,
          command: binary,
          env: environment,
          extraArgs: OMP_ISOLATED_ARGS,
        }).pipe(
          Effect.provide(NodeServices.layer),
          Effect.map((client) => ({
            events: client.events,
            command: client.command,
            extensionUiResponse: client.extensionUiResponse,
            redact: client.redaction.text,
          })),
          Effect.mapError(
            (cause) => new ProviderConnectionActionError({ message: cause.message, cause }),
          ),
        ),
      });
      // OpenRouter's flow builds its link locally and waits on a loopback
      // callback, so the start reaches no outside service.
      const scope = yield* Scope.make();
      const attempt = yield* actions
        .start("scient_agent_account", "openrouter")
        .pipe(Scope.provide(scope));
      expect(attempt.authorizationUrl).toMatch(/^https:\/\/openrouter\.ai\/auth\?/u);
      expect(attempt.authorizationUrlKind).toBe("primary");
      expect(attempt.submitAuthorizationCode).toBeDefined();
      expect(attempt.instructions).toMatch(/authorization code/iu);
      yield* attempt.cancel;
      yield* Scope.close(scope, Exit.void);

      // Signing out of an entry with nothing stored is answered, not an error.
      yield* Effect.scoped(actions.disconnectAccount!("openrouter"));
      expect(homeEntries(home)).toEqual([]);
      NodeFS.rmSync(root, { recursive: true, force: true });
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("keeps every file it owns under the root Scient assigns", () =>
    Effect.gen(function* () {
      const { root, home, stateDir, attachmentsDir } = makeRoot("ownership");
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true })),
      );
      const { environment, agentRoot } = scientAgentInstance(home, stateDir, "scient");
      const workspace = NodePath.join(root, "workspace");
      NodeFS.mkdirSync(workspace);
      writeStubModel(agentRoot);
      const instanceId = ProviderInstanceId.make("scient");
      const session = yield* nativeOmpSession({
        root,
        cwd: workspace,
        target: scientAgentTarget,
        binaryPath: binary,
        instanceId,
        threadId: ThreadId.make("scient-agent-ownership"),
        modelSelection: createModelSelection(instanceId, "scient-agent-live-test/stub"),
        stateDir,
        attachmentsDir,
        environment,
        homePath: agentRoot,
        makeProcess: yield* gatedProcess,
      });
      expect(session.runtime.providerSession.status).toBe("ready");
      yield* session.close;

      // The agent's own state: only under its root.
      for (const expected of ["agent", "logs", "natives"]) {
        expect(NodeFS.existsSync(NodePath.join(agentRoot, expected))).toBe(true);
      }
      expect(homeEntries(home)).toEqual([]);
      // Scient's folders for this product, never Oh My Pi's.
      expect(NodeFS.existsSync(NodePath.join(stateDir, "scient-agent-sessions"))).toBe(true);
      expect(NodeFS.existsSync(NodePath.join(stateDir, "omp-sessions"))).toBe(false);
      expect(NodeFS.existsSync(NodePath.join(stateDir, "omp"))).toBe(false);
      // Starting a conversation writes nothing into the project.
      expect(NodeFS.readdirSync(workspace)).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("keeps its state under that root when a .env names another place", () =>
    Effect.gen(function* () {
      const { root, home, stateDir, attachmentsDir } = makeRoot("dotenv");
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true })),
      );
      const { environment, agentRoot } = scientAgentInstance(home, stateDir, "scient");
      const workspace = NodePath.join(root, "workspace");
      const elsewhere = NodePath.join(root, "elsewhere");
      NodeFS.mkdirSync(workspace);
      // The agent loads the project's and the home directory's .env after launch,
      // so these never pass through the environment Scient builds.
      const dotenv = [
        `SCIENT_AGENT_DIR=${NodePath.join(elsewhere, "agent")}`,
        `SCIENT_AGENT_SESSION_DIR=${NodePath.join(elsewhere, "sessions")}`,
        `SCIENT_AGENT_CONFIG_FILES=${NodePath.join(elsewhere, "overlay.yml")}`,
        "SCIENT_AGENT_PROFILE=elsewhere",
        "",
      ].join("\n");
      NodeFS.writeFileSync(NodePath.join(workspace, ".env"), dotenv);
      NodeFS.writeFileSync(NodePath.join(home, ".env"), dotenv);
      writeStubModel(agentRoot);
      const instanceId = ProviderInstanceId.make("scient");
      const session = yield* nativeOmpSession({
        root,
        cwd: workspace,
        target: scientAgentTarget,
        binaryPath: binary,
        instanceId,
        threadId: ThreadId.make("scient-agent-dotenv"),
        modelSelection: createModelSelection(instanceId, "scient-agent-live-test/stub"),
        stateDir,
        attachmentsDir,
        environment,
        homePath: agentRoot,
        makeProcess: yield* gatedProcess,
      });
      expect(session.runtime.providerSession.status).toBe("ready");
      yield* session.close;

      expect(NodeFS.existsSync(NodePath.join(agentRoot, "agent", "agent.db"))).toBe(true);
      expect(NodeFS.existsSync(NodePath.join(agentRoot, "profiles"))).toBe(false);
      expect(NodeFS.existsSync(elsewhere)).toBe(false);
      expect(homeEntries(home)).toEqual([".env"]);
      expect(NodeFS.readdirSync(workspace)).toEqual([".env"]);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  describe.runIf(ompQualifyBinary)("beside a real Oh My Pi", () => {
    const ompBinary = ompQualifyBinary ?? "";

    it.effect("each target refuses the other's executable", () =>
      Effect.gen(function* () {
        const { root, home, stateDir } = makeRoot("identity");
        const { environment } = scientAgentInstance(home, stateDir, "scient");
        const makeProcess = yield* gatedProcess;
        const asScientAgent = yield* checkOmpProviderStatus(
          scientAgentTarget,
          settings(ompBinary),
          environment,
          makeProcess,
          root,
        );
        expect(asScientAgent.status).toBe("error");
        expect(asScientAgent.message).toBe(scientAgentTarget.unsupportedDetail);
        const omp = ompLiveInstance(NodePath.join(root, "omp"));
        const asOmp = yield* checkOmpProviderStatus(
          ompTarget,
          settings(binary),
          omp.environment,
          makeProcess,
          root,
        );
        expect(asOmp.status).toBe("error");
        expect(asOmp.message).toBe(ompTarget.unsupportedDetail);
        NodeFS.rmSync(root, { recursive: true, force: true });
      }).pipe(Effect.scoped, Effect.provide(layer)),
    );

    it.effect(
      "runs at the same time without either touching the other's files",
      () =>
        Effect.gen(function* () {
          const { root, home, stateDir, attachmentsDir } = makeRoot("coexistence");
          const workspace = NodePath.join(root, "workspace");
          NodeFS.mkdirSync(workspace);
          const makeProcess = yield* gatedProcess;
          // Oh My Pi with the user's default home, as an instance with no
          // home or profile setting uses it.
          const ompHome = NodePath.join(home, ".omp");
          const ompEnvironment: NodeJS.ProcessEnv = {
            PATH: process.env.PATH ?? "",
            HTTPS_PROXY: "http://127.0.0.1:9",
            HTTP_PROXY: "http://127.0.0.1:9",
            NO_PROXY: "127.0.0.1,localhost",
            HOME: home,
            USERPROFILE: home,
          };
          for (const name of Object.values(ompTarget.environment)) delete ompEnvironment[name];
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true })),
          );
          const ompId = ProviderInstanceId.make("omp");
          const omp = yield* nativeOmpSession({
            root,
            cwd: workspace,
            target: ompTarget,
            binaryPath: ompBinary,
            instanceId: ompId,
            threadId: ThreadId.make("coexistence-omp"),
            modelSelection: createModelSelection(ompId, ompQualifyModel),
            stateDir,
            attachmentsDir,
            environment: ompEnvironment,
            makeProcess,
          });
          const ompFilesBefore = tree(ompHome);
          expect(ompFilesBefore.length).toBeGreaterThan(0);

          const { environment, agentRoot } = scientAgentInstance(home, stateDir, "scient");
          const scientId = ProviderInstanceId.make("scient");
          const scientAgent = yield* nativeOmpSession({
            root,
            cwd: workspace,
            target: scientAgentTarget,
            binaryPath: binary,
            instanceId: scientId,
            threadId: ThreadId.make("coexistence-scient-agent"),
            modelSelection: createModelSelection(scientId, ompQualifyModel),
            stateDir,
            attachmentsDir,
            environment,
            homePath: agentRoot,
            makeProcess,
          });
          expect(omp.runtime.providerSession.status).toBe("ready");
          expect(scientAgent.runtime.providerSession.status).toBe("ready");

          // Scient Agent added nothing to the home directory: Oh My Pi's home
          // is still the only entry.
          expect(homeEntries(home)).toEqual([".omp"]);
          // Each product has its own folders under Scient's state directory.
          expect(NodeFS.readdirSync(NodePath.join(stateDir, "omp-sessions")).length).toBe(1);
          expect(NodeFS.readdirSync(NodePath.join(stateDir, "scient-agent-sessions")).length).toBe(
            1,
          );

          // Stopping one leaves the other running.
          yield* scientAgent.close;
          expect(scientAgent.runtime.providerSession.status).toBe("stopped");
          expect(omp.runtime.providerSession.status).toBe("ready");
          // Scient Agent's whole life cycle removed nothing Oh My Pi wrote.
          const ompFilesAfter = new Set(tree(ompHome));
          for (const file of ompFilesBefore) {
            if (file.includes(`${NodePath.sep}run${NodePath.sep}`) || file.startsWith("run")) {
              continue;
            }
            expect(ompFilesAfter.has(file), `Oh My Pi lost ${file}`).toBe(true);
          }
          yield* omp.close;
        }).pipe(Effect.scoped, Effect.provide(layer)),
      120_000,
    );
  });

  describe.runIf(ompQualifyBinary)("under load beside a real Oh My Pi", () => {
    it.effect(
      "starts and stops many conversations of both products at once and leaves no process behind",
      () =>
        Effect.gen(function* () {
          const { root, home, stateDir, attachmentsDir } = makeRoot("load");
          const workspace = NodePath.join(root, "workspace");
          NodeFS.mkdirSync(workspace);
          const makeProcess = yield* gatedProcess;
          const { environment, agentRoot } = scientAgentInstance(home, stateDir, "scient");
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true })),
          );
          const scientId = ProviderInstanceId.make("scient");
          const scientOptions = {
            root,
            cwd: workspace,
            target: scientAgentTarget,
            binaryPath: binary,
            instanceId: scientId,
            modelSelection: createModelSelection(scientId, ompQualifyModel),
            stateDir,
            attachmentsDir,
            environment,
            homePath: agentRoot,
            makeProcess,
          };
          const ompInstance = ompLiveInstance(NodePath.join(root, "omp"), {
            baseEnv: {
              PATH: process.env.PATH ?? "",
              HTTPS_PROXY: "http://127.0.0.1:9",
              HTTP_PROXY: "http://127.0.0.1:9",
              NO_PROXY: "127.0.0.1,localhost",
            },
          });
          const ompId = ProviderInstanceId.make("omp");
          const ompOptions = {
            root,
            cwd: workspace,
            target: ompTarget,
            binaryPath: ompQualifyBinary ?? "",
            instanceId: ompId,
            modelSelection: createModelSelection(ompId, ompQualifyModel),
            stateDir,
            attachmentsDir,
            environment: ompInstance.environment,
            homePath: ompInstance.homePath,
            makeProcess,
          };
          const conversations = Array.from({ length: 6 }, (_, index) => index).flatMap((index) => [
            { ...scientOptions, threadId: ThreadId.make(`load-scient-agent-${index}`) },
            { ...ompOptions, threadId: ThreadId.make(`load-omp-${index}`) },
          ]);
          const sessions = yield* Effect.forEach(conversations, nativeOmpSession, {
            concurrency: "unbounded",
          });
          expect(sessions.map((session) => session.runtime.providerSession.status)).toEqual(
            conversations.map(() => "ready"),
          );
          // Every session directory holds exactly one product's conversation.
          expect(NodeFS.readdirSync(NodePath.join(stateDir, "scient-agent-sessions"))).toHaveLength(
            6,
          );
          expect(NodeFS.readdirSync(NodePath.join(stateDir, "omp-sessions"))).toHaveLength(6);

          // Each process was started with a session directory under this root.
          const running = () =>
            NodeChildProcess.spawnSync("pgrep", ["-f", stateDir], { encoding: "utf8" })
              .stdout.split("\n")
              .filter((pid) => pid.trim().length > 0);
          expect(running().length).toBeGreaterThanOrEqual(conversations.length);

          yield* Effect.forEach(sessions, (session) => session.close, {
            concurrency: "unbounded",
            discard: true,
          });
          for (const session of sessions)
            expect(session.runtime.providerSession.status).toBe("stopped");
          expect(running()).toEqual([]);
          expect(homeEntries(home)).toEqual([]);
        }).pipe(Effect.scoped, Effect.provide(layer)),
      180_000,
    );
  });

  it.effect.skipIf(!fullTurn)(
    `completes a real model turn with ${ompQualifyModel}, resumes it, and cannot be resumed by Oh My Pi`,
    () =>
      Effect.gen(function* () {
        const { root, home, stateDir, attachmentsDir } = makeRoot("turn");
        const workspace = NodePath.join(root, "workspace");
        NodeFS.mkdirSync(workspace);
        const { environment, agentRoot } = scientAgentInstance(home, stateDir, "scient");
        const instanceId = ProviderInstanceId.make("scient");
        const makeProcess = yield* gatedProcess;
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true })),
        );
        const options = {
          root,
          cwd: workspace,
          target: scientAgentTarget,
          binaryPath: binary,
          instanceId,
          threadId: ThreadId.make("scient-agent-turn"),
          modelSelection: createModelSelection(instanceId, ompQualifyModel),
          stateDir,
          attachmentsDir,
          environment,
          homePath: agentRoot,
          makeProcess,
        };
        const session = yield* nativeOmpSession(options);
        const terminal = yield* watchNativeOmpTextTurn(session.events);
        yield* session.start({
          text: "Create a file named answer.txt containing only the number 42. Then reply with exactly QUALIFIED_SCIENT_AGENT.",
        });
        expect((yield* terminal.pipe(Effect.timeout("120 seconds"))).trim()).toBe(
          "QUALIFIED_SCIENT_AGENT",
        );
        // The task's output is in the project; the agent's state is not.
        expect(NodeFS.readFileSync(NodePath.join(workspace, "answer.txt"), "utf8").trim()).toBe(
          "42",
        );
        expect(NodeFS.readdirSync(workspace)).toEqual(["answer.txt"]);
        expect(homeEntries(home)).toEqual([]);

        const prior = session.latestProviderThread();
        expect(prior.nativeMetadata?.resumeCursor).toBeDefined();
        yield* session.close;
        const resumed = yield* nativeOmpSession({ ...options, resumeProviderThread: prior });
        expect(resumed.runtime.providerSession.status).toBe("ready");
        expect(resumed.providerThread.nativeThreadRef?.nativeId).toBe(
          prior.nativeThreadRef?.nativeId,
        );
        yield* resumed.close;

        // Even the same instance id cannot confer cross-product resume authority.
        if (ompQualifyBinary) {
          const refused = yield* nativeOmpSession({
            ...options,
            target: ompTarget,
            binaryPath: ompQualifyBinary,
            environment: ompLiveInstance(NodePath.join(root, "omp"), {
              baseEnv: {
                PATH: process.env.PATH ?? "",
                HTTPS_PROXY: "http://127.0.0.1:9",
                HTTP_PROXY: "http://127.0.0.1:9",
                NO_PROXY: "127.0.0.1,localhost",
              },
            }).environment,
            resumeProviderThread: prior,
          }).pipe(Effect.flip);
          expect(refused._tag).toBe("ProviderAdapterResumeThreadError");
        }
        NodeFS.rmSync(root, { recursive: true, force: true });
      }).pipe(Effect.scoped, Effect.provide(layer)),
    600_000,
  );
});
