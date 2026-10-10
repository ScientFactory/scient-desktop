/** Connected, task-private production web/CLI/SQLite/default ACP proof. No seeded projection or mocked intake. */
import { test, expect, afterEach } from "vite-plus/test";
import { chromium, type BrowserContext, type Page } from "playwright";
import * as NodeChildProcess from "node:child_process";
import * as NodeNet from "node:net";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import * as NodeSqlite from "node:sqlite";
const root = NodePath.resolve(import.meta.dirname, "../../..");
const peerSource =
  "// Task-private simulated provider. stdout belongs exclusively to ACP.\nimport fs from 'node:fs';\nimport path from 'node:path';\nimport { randomUUID } from 'node:crypto';\nimport { fileURLToPath, pathToFileURL } from 'node:url';\nimport * as Effect from 'effect/Effect';\nimport * as Layer from 'effect/Layer';\nimport * as Scope from 'effect/Scope';\nimport * as Deferred from 'effect/Deferred';\nimport * as Schema from 'effect/Schema';\nimport * as NodeServices from '@effect/platform-node/NodeServices';\nimport * as NodeRuntime from '@effect/platform-node/NodeRuntime';\n\nconst root = path.dirname(fileURLToPath(import.meta.url));\nconst config = JSON.parse(fs.readFileSync(path.join(root, 'private-config.json'), 'utf8'));\nconst AcpAgent = await import(pathToFileURL(path.join(config.worktree, 'packages/effect-acp/src/agent.ts')).href);\nconst AcpError = await import(pathToFileURL(path.join(config.worktree, 'packages/effect-acp/src/errors.ts')).href);\nconst storage = path.join(root, 'control');\nconst Session = Schema.Struct({ sessionId: Schema.String, cwd: Schema.String,\n  model: Schema.String, mode: Schema.String, history: Schema.Array(Schema.String) });\nconst decodeSession = Schema.decodeSync(Schema.fromJsonString(Session));\nconst active = new Map();\nconst audit = (event, fields = {}) => fs.appendFileSync(path.join(storage, 'audit.jsonl'),\n  `${JSON.stringify({ at: new Date().toISOString(), pid: process.pid, event, ...fields })}\\n`);\nconst filename = (id) => {\n  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid controlled session ID');\n  return path.join(storage, 'sessions', `${id}.json`);\n};\nconst save = (session) => {\n  const target = filename(session.sessionId);\n  fs.writeFileSync(`${target}.tmp-${process.pid}`, JSON.stringify(session));\n  fs.renameSync(`${target}.tmp-${process.pid}`, target);\n};\nconst load = (id) => decodeSession(fs.readFileSync(filename(id), 'utf8'));\nconst options = (session) => [\n  { configId: 'model', name: 'Model', category: 'model', type: 'select', currentValue: session.model,\n    options: [{ value: 'controlled-model', name: 'Controlled ACP acceptance (simulated)' }] },\n  { configId: 'mode', name: 'Native interaction mode', category: 'mode', type: 'select',\n    currentValue: session.mode, options: [{ value: 'build', name: 'Build' }, { value: 'plan', name: 'Plan' }] },\n];\nconst program = Effect.gen(function* () {\n  const agent = yield* AcpAgent.AcpAgent;\n  const scope = yield* Scope.Scope;\n  const notify = (sessionId, update) => agent.client.sessionUpdate({ sessionId, update });\n  const text = (sessionId, messageId, value) => notify(sessionId, {\n    sessionUpdate: 'agent_message_chunk', messageId, content: { type: 'text', text: value },\n  });\n  const idle = (sessionId, stopReason) => notify(sessionId, { sessionUpdate: 'state_update', state: 'idle', stopReason });\n  yield* agent.handleInitialize(() => Effect.sync(() => {\n    audit('initialize');\n    return { protocolVersion: 2, info: { name: 'Controlled ACP acceptance', version: '0.0.1' },\n      capabilities: { session: {} }, authMethods: [] };\n  }));\n  yield* agent.handleAuthenticate(() => Effect.succeed({}));\n  yield* agent.handleLogout(() => Effect.succeed({}));\n  yield* agent.handleCreateSession((request) => Effect.sync(() => {\n    const session = { sessionId: randomUUID(), cwd: request.cwd, model: 'controlled-model', mode: 'build', history: [] };\n    save(session); audit('session_new', { sessionId: session.sessionId, cwd: session.cwd });\n    return { sessionId: session.sessionId, configOptions: options(session) };\n  }));\n  yield* agent.handleResumeSession((request) => Effect.sync(() => {\n    const session = load(request.sessionId);\n    session.cwd = request.cwd; save(session); audit('session_resume', { sessionId: session.sessionId });\n    return { configOptions: options(session) };\n  }));\n  yield* agent.handleListSessions(() => Effect.sync(() => ({ sessions: fs.readdirSync(path.join(storage, 'sessions'))\n    .filter((name) => name.endsWith('.json')).map((name) => {\n      const session = decodeSession(fs.readFileSync(path.join(storage, 'sessions', name), 'utf8'));\n      return { sessionId: session.sessionId, cwd: session.cwd, title: 'Controlled ACP acceptance' };\n    }) })));\n  yield* agent.handleSetSessionConfigOption((request) => Effect.gen(function* () {\n    const session = yield* Effect.sync(() => load(request.sessionId));\n    if (request.configId === 'model' && request.value === 'controlled-model') session.model = request.value;\n    else if (request.configId === 'mode' && (request.value === 'build' || request.value === 'plan')) session.mode = request.value;\n    else return yield* AcpError.AcpRequestError.invalidParams('Unknown controlled configuration');\n    yield* Effect.sync(() => { save(session); audit('config_applied', {\n      sessionId: session.sessionId, configId: request.configId, value: request.value }); });\n    yield* notify(session.sessionId, { sessionUpdate: 'config_option_update', configOptions: options(session) });\n    return { configOptions: options(session) };\n  }));\n  yield* agent.handleCancel(({ sessionId }) => Effect.gen(function* () {\n    const turn = active.get(sessionId);\n    if (turn === undefined) { yield* Effect.sync(() => audit('cancel_idle', { sessionId })); return; }\n    yield* Effect.sync(() => audit('cancel_requested', { sessionId, turnId: turn.turnId }));\n    yield* Deferred.succeed(turn.cancelled, undefined);\n    // Cancel is a notification; the actual worker emits one authoritative idle receipt.\n    yield* Deferred.await(turn.finished);\n  }));\n  yield* agent.handleCloseSession(({ sessionId }) => Effect.gen(function* () {\n    const turn = active.get(sessionId);\n    if (turn !== undefined) { yield* Deferred.succeed(turn.cancelled, undefined); yield* Deferred.await(turn.finished); }\n    yield* Effect.sync(() => audit('session_closed', { sessionId })); return {};\n  }));\n  yield* agent.handlePrompt((request) => Effect.gen(function* () {\n    if (active.has(request.sessionId)) return yield* AcpError.AcpRequestError.invalidRequest('Controlled session already running');\n    const session = yield* Effect.sync(() => load(request.sessionId));\n    const input = request.prompt.filter((block) => block.type === 'text').map((block) => block.text).join('\\n');\n    const marker = [...input.matchAll(/ACP_ACCEPTANCE:(HOLD|PERMISSION|ANSWER|FAIL|PLAN)(?:\\s+([^\\n]*))?/g)].at(-1);\n    const action = marker?.[1] ?? 'ANSWER';\n    const label = (marker?.[2] ?? 'portable continuation').slice(0, 160);\n    const turnId = randomUUID();\n    const cancelled = yield* Deferred.make();\n    const finished = yield* Deferred.make();\n    const turn = { turnId, cancelled, finished };\n    active.set(request.sessionId, turn);\n    yield* Effect.sync(() => {\n      fs.writeFileSync(path.join(storage, 'pending', `${turnId}.json`), JSON.stringify({\n        pid: process.pid, sessionId: session.sessionId, turnId, action, label, mode: session.mode }));\n      audit('prompt_accepted', { sessionId: session.sessionId, turnId, action, label, mode: session.mode });\n    });\n    const work = Effect.gen(function* () {\n      yield* notify(session.sessionId, { sessionUpdate: 'state_update', state: 'running' });\n      yield* text(session.sessionId, turnId, `Controlled ACP acceptance \u2014 ${label}\\n`);\n      if (action === 'PLAN') {\n        yield* notify(session.sessionId, { sessionUpdate: 'plan_update',\n          plan: { type: 'markdown', planId: 'controlled-extracted-plan',\n            content: '# Extracted intent plan\\n\\nPreserve this source plan through extraction and retry.' } });\n      }\n      if (action === 'HOLD') {\n        yield* text(session.sessionId, turnId, 'Waiting for the private release signal.\\n');\n        while (!fs.existsSync(path.join(storage, 'release', turnId))) yield* Effect.sleep('50 millis');\n      }\n      if (action === 'PERMISSION') {\n        yield* Effect.sync(() => audit('permission_requested', { sessionId: session.sessionId, turnId }));\n        const response = yield* agent.client.requestPermission({ sessionId: session.sessionId,\n          title: 'Controlled no-op command (simulated; no command will execute)',\n          options: [{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },\n            { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' }],\n          subject: { type: 'tool_call', toolCall: { toolCallId: `permission-${turnId}`,\n            title: 'Controlled no-op command', kind: 'execute', rawInput: { command: 'controlled-noop' } } } });\n        yield* Effect.sync(() => audit('permission_response', { sessionId: session.sessionId, turnId, outcome: response.outcome }));\n        yield* text(session.sessionId, turnId, `Permission response: ${JSON.stringify(response.outcome)}\\n`);\n      }\n      yield* Effect.sync(() => { session.history.push(label); save(session); });\n      yield* text(session.sessionId, turnId, `Finished ${label}. Native interaction mode: ${session.mode}.\\n`);\n      return action === 'FAIL' ? 'error' : 'end_turn';\n    });\n    const runner = Effect.gen(function* () {\n      const reason = yield* Effect.raceFirst(work, Deferred.await(cancelled).pipe(Effect.as('cancelled'))).pipe(\n        Effect.catchCause(() => Effect.sync(() => {\n          // Never log arbitrary ACP causes, request payloads, environment or credentials.\n          audit('worker_failed', { sessionId: session.sessionId, turnId });\n          return 'error';\n        })));\n      yield* Effect.sync(() => {\n        if (active.get(session.sessionId) === turn) active.delete(session.sessionId);\n        fs.rmSync(path.join(storage, 'pending', `${turnId}.json`), { force: true });\n        fs.rmSync(path.join(storage, 'release', turnId), { force: true });\n      });\n      yield* idle(session.sessionId, reason);\n      yield* Effect.sync(() => audit('idle', { sessionId: session.sessionId, turnId, stopReason: reason }));\n    }).pipe(Effect.ensuring(Deferred.succeed(finished, undefined)));\n    yield* Effect.forkIn(runner, scope);\n    return {}; // ACP v2 prompt response acknowledges acceptance; idle settles work.\n  }));\n  yield* Effect.sync(() => audit('ready'));\n  return yield* Effect.never;\n});\nprogram.pipe(Effect.scoped, Effect.provide(Layer.provide(AcpAgent.layerStdio(), NodeServices.layer)), NodeRuntime.runMain);\n";
const cleanups = new Set<() => Promise<void>>();
afterEach(async () => {
  for (const close of cleanups) await close();
  cleanups.clear();
});
const stage = (value: string) => console.info("[connected stage] " + value);
const pause = "/Users/yaacov/REPOs/ScientFactory/reviews/v1-removal-20261004/checks/.pause";
async function port() {
  const server = NodeNet.createServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No fixture port");
  await new Promise<void>((done, fail) => server.close((e) => (e ? fail(e) : done())));
  return address.port;
}
async function stopped(child: NodeChildProcess.ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  // Descendants can retain stdout after the leader exits. The leased outer runner
  // reaps the exact whole group; fixture cleanup waits the authoritative exit.
  await new Promise<void>((done, fail) => {
    const force = setTimeout(() => child.kill("SIGKILL"), 10000);
    const deadline = setTimeout(
      () => finish(new Error("Owned fixture leader did not exit")),
      13000,
    );
    const finish = (error?: Error) => {
      clearTimeout(force);
      clearTimeout(deadline);
      child.off("exit", exited);
      child.stdout?.destroy();
      child.stderr?.destroy();
      if (error) fail(error);
      else done();
    };
    const exited = () => finish();
    child.once("exit", exited);
    child.kill("SIGTERM");
  });
}
async function fixture() {
  // Runner supplies only an allowlisted private environment and the single FIFO lease.
  if (!process.env.HOME?.includes("extracted-intent-private-home"))
    throw new Error("Private fixture HOME required");
  try {
    await NodeFSP.lstat(pause);
    throw new Error("Qualification paused");
  } catch (e) {
    if (!(e instanceof Error && "code" in e && e.code === "ENOENT")) throw e;
  }
  const directory = await NodeFSP.mkdtemp(
    NodePath.join(NodeOS.tmpdir(), "extracted-intent-connected-"),
  );
  const base = NodePath.join(directory, "state"),
    workspace = NodePath.join(directory, "workspace"),
    peer = NodePath.join(directory, "peer");
  await NodeFSP.mkdir(NodePath.join(base, "userdata"), { recursive: true });
  await NodeFSP.mkdir(workspace);
  await NodeFSP.mkdir(peer);
  for (const name of ["pending", "release", "sessions"])
    await NodeFSP.mkdir(NodePath.join(peer, "control", name), { recursive: true });
  await NodeFSP.writeFile(
    NodePath.join(workspace, "README.md"),
    "Synthetic extracted-intent fixture\n",
  );
  NodeChildProcess.execFileSync("git", ["init", "-q"], { cwd: workspace });
  NodeChildProcess.execFileSync("git", ["add", "README.md"], { cwd: workspace });
  NodeChildProcess.execFileSync(
    "git",
    [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.test",
      "commit",
      "-qm",
      "Fixture",
    ],
    { cwd: workspace },
  );
  await NodeFSP.symlink(
    NodePath.join(root, "packages/effect-acp/node_modules"),
    NodePath.join(peer, "node_modules"),
    "dir",
  );
  await NodeFSP.writeFile(
    NodePath.join(peer, "private-config.json"),
    JSON.stringify({ worktree: root, baseDir: base, stateName: "userdata" }),
    { mode: 0o600 },
  );
  await NodeFSP.writeFile(NodePath.join(peer, "peer.mjs"), peerSource, { mode: 0o600 });
  const executable = NodePath.join(peer, "controlled-acp");
  await NodeFSP.writeFile(
    executable,
    `#!/bin/sh\nexec '${process.execPath}' '${NodePath.join(peer, "peer.mjs")}' "$@"\n`,
    { mode: 0o700 },
  );
  await NodeFSP.writeFile(
    NodePath.join(base, "userdata/settings.json"),
    JSON.stringify({
      providers: Object.fromEntries(
        [
          "codex",
          "claudeAgent",
          "cursor",
          "grok",
          "pi",
          "opencode",
          "droid",
          "omp",
          "scient",
          "antigravity",
        ].map((id) => [id, { enabled: false }]),
      ),
      providerInstances: {
        controlled_extracted_intent: {
          driver: "acpRegistry",
          displayName: "Controlled extracted intent",
          enabled: true,
          config: {
            agentId: "controlled-extracted-intent",
            commandPath: executable,
            distribution: "npx",
            customModels: [],
          },
        },
      },
    }),
    { mode: 0o600 },
  );
  await NodeFSP.mkdir(NodePath.join(base, "caches/acp-registry"), { recursive: true });
  await NodeFSP.writeFile(
    NodePath.join(base, "caches/acp-registry/registry.json"),
    JSON.stringify({
      version: "1.0.0",
      agents: [
        {
          id: "controlled-extracted-intent",
          name: "Controlled extracted intent",
          version: "0.0.1",
          description: "Task-private simulated ACP process",
          distribution: {
            npx: { package: "controlled-extracted-intent@0.0.1", args: [], env: {} },
          },
        },
      ],
    }),
  );
  const backendPort = await port(),
    webPort = await port(),
    origin = `http://127.0.0.1:${webPort}`;
  const credential = NodeCrypto.randomUUID() + NodeCrypto.randomUUID();
  const env = {
    ...process.env,
    T3CODE_SINGLE_ORIGIN_DEV: "1",
    T3CODE_MODE: "web",
    T3CODE_HOME: base,
    T3CODE_PORT: String(backendPort),
    T3CODE_HOST: "127.0.0.1",
    VITE_DEV_SERVER_URL: origin,
    T3CODE_DEV_AUTH_TOKEN: credential,
    T3CODE_NO_BROWSER: "true",
    T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD: "true",
    PORT: String(webPort),
  };
  let output = "";
  const capture = (chunk: Buffer) => {
    output = (
      output +
      chunk
        .toString()
        .replaceAll(credential, "[synthetic credential redacted]")
        .replace(/Bearer [^\s]+/g, "Bearer [redacted]")
    ).slice(-12000);
  };
  const server = NodeChildProcess.spawn(
    process.execPath,
    [
      NodePath.join(root, "apps/server/src/bin.ts"),
      "start",
      "--base-dir",
      base,
      "--port",
      String(backendPort),
      "--dev-url",
      origin,
      "--no-browser",
      "--auto-bootstrap-project-from-cwd",
    ],
    { cwd: workspace, env, stdio: ["ignore", "pipe", "pipe"] },
  );
  server.stdout?.on("data", capture);
  server.stderr?.on("data", capture);
  const web = NodeChildProcess.spawn(
    "pnpm",
    ["exec", "vp", "dev", "--host", "127.0.0.1", "--port", String(webPort), "--strictPort"],
    { cwd: NodePath.join(root, "apps/web"), env, stdio: ["ignore", "pipe", "pipe"] },
  );
  web.stdout?.on("data", capture);
  web.stderr?.on("data", capture);
  let context: BrowserContext | undefined;
  let observedPage: Page | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    try {
      await context?.close();
      await browser?.close();
    } finally {
      await stopped(server);
      await stopped(web);
      console.info(
        "[connected owned teardown] " +
          JSON.stringify({
            server: { pid: server.pid, exitCode: server.exitCode, signal: server.signalCode },
            web: { pid: web.pid, exitCode: web.exitCode, signal: web.signalCode },
          }),
      );
      await NodeFSP.rm(directory, { recursive: true, force: true });
    }
  };
  cleanups.add(close);
  stage("owned processes started");
  try {
    await expect
      .poll(
        async () => {
          if (server.exitCode !== null || web.exitCode !== null)
            throw new Error("Owned startup exited: " + output);
          try {
            return (
              await fetch(origin + "/.well-known/t3/environment", {
                signal: AbortSignal.timeout(3000),
              })
            ).status;
          } catch {
            return 0;
          }
        },
        { timeout: 120000, interval: 500 },
      )
      .toBe(200);
    stage("HTTP descriptor ready");
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext();
    context.setDefaultTimeout(15000);
    stage("browser ready");
    const auth = await context.request.post(origin + "/api/auth/browser-session", {
      data: { credential },
    });
    expect(auth.status(), output).toBe(200);
    stage("authenticated");
    const shellResponse = await context.request.get(origin + "/api/orchestration/shell", {
      headers: { "x-t3-orchestration-protocol": "2" },
      timeout: 15000,
    });
    expect(shellResponse.status()).toBe(200);
    const shell = (await shellResponse.json()) as {
      projects: Array<{ id: string; workspaceRoot: string }>;
    };
    const ownProject = shell.projects.filter((project) => project.workspaceRoot === workspace);
    expect(ownProject).toHaveLength(1);
    console.info("[connected selected project] " + JSON.stringify(ownProject[0]));
    const page = await context.newPage();
    observedPage = page;
    page.on("pageerror", (error) => {
      capture(Buffer.from(error.message));
      console.info(
        "[connected browser error] " +
          error.message.replaceAll(credential, "[synthetic credential redacted]").slice(0, 1200),
      );
    });
    await page.goto(origin);
    stage("root route mounted");
    await page.evaluate(
      () =>
        new Promise<void>((done, fail) => {
          const timer = setTimeout(
            () => fail(new Error("Native browser animation frame unavailable")),
            5000,
          );
          requestAnimationFrame(() => {
            clearTimeout(timer);
            done();
          });
        }),
    );
    stage("native browser animation frame observed");
    await expect
      .poll(() => page.getByRole("button", { name: /New thread/ }).count(), { timeout: 60000 })
      .toBeGreaterThan(0);
    stage("new thread control ready");
    await page.getByRole("button", { name: "New thread in workspace", exact: true }).click();
    stage("public project draft requested");
    await page
      .locator('[data-testid="composer-editor"][contenteditable="true"]')
      .waitFor({ timeout: 60000 });
    stage("editable composer mounted");
    return { directory, base, origin, peer, page, context, output: () => output, close };
  } catch (cause) {
    if (observedPage && !observedPage.isClosed()) {
      console.info(
        "[connected setup dialogs] " +
          JSON.stringify(
            (await observedPage.getByRole("dialog").allTextContents()).map((value) =>
              value.slice(0, 2400),
            ),
          ),
      );
      console.info(
        "[connected setup options] " +
          JSON.stringify(
            (
              await observedPage
                .locator('[data-slot="command-item"], [role="option"]')
                .allTextContents()
            )
              .map((value) => value.slice(0, 400))
              .slice(0, 20),
          ),
      );
    }
    await close();
    throw new Error("Connected fixture setup failed: " + String(cause) + "\n" + output, { cause });
  }
}
async function buttonStates(page: Page) {
  return page.getByRole("button").evaluateAll((elements) =>
    elements
      .map((element) => ({
        label: (element.getAttribute("aria-label") ?? element.textContent ?? "")
          .trim()
          .slice(0, 160),
        disabled: element.hasAttribute("disabled"),
      }))
      .filter((value) => value.label.length > 0)
      .slice(-40),
  );
}
async function typePrompt(page: Page, text: string) {
  const editor = page.getByTestId("composer-editor");
  await editor.click({ timeout: 15000 });
  await editor.press("ControlOrMeta+A");
  await editor.press("Backspace");
  await editor.pressSequentially(text, { timeout: 15000 });
  // Reload and Send exercise the draft the user actually authored.
  await expect.poll(() => editor.innerText(), { timeout: 15000 }).toBe(text);
}
async function send(page: Page, text: string) {
  await typePrompt(page, text);
  stage("composer typed through native keyboard");
  try {
    await page.getByRole("button", { name: /^(Send|Queue) message$/ }).click({ timeout: 15000 });
    stage("native Send control clicked");
  } catch (cause) {
    console.info("[connected send controls] " + JSON.stringify(await buttonStates(page)));
    throw cause;
  }
}
async function audit(peer: string) {
  try {
    return (await NodeFSP.readFile(NodePath.join(peer, "control/audit.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { event: string; action?: string; label?: string });
  } catch {
    return [];
  }
}
async function extract(
  f: Awaited<ReturnType<typeof fixture>>,
  label: string,
  prepareQueuedDraft?: () => Promise<void>,
) {
  stage("offering HOLD");
  await send(f.page, "ACP_ACCEPTANCE:HOLD owner");
  await expect
    .poll(
      async () =>
        (await audit(f.peer)).filter((x) => x.event === "prompt_accepted" && x.action === "HOLD")
          .length,
      { timeout: 30000 },
    )
    .toBe(1);
  stage("native HOLD accepted");
  if (prepareQueuedDraft) {
    await typePrompt(f.page, "ACP_ACCEPTANCE:ANSWER " + label);
    await prepareQueuedDraft();
    await f.page.getByRole("button", { name: "Queue message", exact: true }).click();
  } else {
    await send(f.page, "ACP_ACCEPTANCE:ANSWER " + label);
  }
  stage("queued actual message");
  await f.page.getByRole("button", { name: "Stop generation", exact: true }).click();
  stage("Stop submitted");
  await f.page
    .getByRole("button", { name: "Edit queued message", exact: true })
    .first()
    .click({ timeout: 30000 });
  await expect
    .poll(() => f.page.getByTestId("composer-editor").innerText(), { timeout: 15000 })
    .toContain(label);
}
test("a committed extracted intent retries the identical packet after a lost acknowledgement and preserves a later draft", async () => {
  const f = await fixture();
  const offers: Array<Record<string, unknown>> = [];
  let dropped = false;
  let sourcePlanRef: { threadId: string; planId: string } | undefined;
  let sourcePlanQueueOffers = 0;
  const sql = new NodeSqlite.DatabaseSync(NodePath.join(f.base, "userdata/statev2.sqlite"), {
    readOnly: true,
  });
  try {
    // Proxy the actual authenticated RPC connection. All requests reach the
    // production server; only the first extracted intake's real success is lost.
    await f.page.routeWebSocket(/\/ws(?:\?|$)/, (socket) => {
      const server = socket.connectToServer();
      let lostRequestId: string | number | undefined;
      socket.onMessage((message) => {
        const decoded = JSON.parse(message.toString());
        const frames = Array.isArray(decoded) ? decoded : [decoded];
        for (const frame of frames) {
          const payload = frame.payload;
          // Supply a real native plan through the public dispatch contract. The
          // server still validates/adopts it; no plan or queued row is seeded.
          if (
            sourcePlanRef &&
            frame._tag === "Request" &&
            payload?.type === "message.dispatch" &&
            payload.dispatchMode?.type === "queue_after_active"
          ) {
            payload.sourcePlanRef = sourcePlanRef;
            sourcePlanQueueOffers += 1;
          }
          if (
            frame._tag === "Request" &&
            payload?.type === "message.dispatch" &&
            typeof payload.commandId === "string" &&
            payload.commandId.startsWith("extracted-intent:")
          ) {
            offers.push(payload);
            if (offers.length === 1) lostRequestId = frame.id;
          }
        }
        server.send(JSON.stringify(Array.isArray(decoded) ? frames : frames[0]));
      });
      server.onMessage((message) => {
        const decoded = JSON.parse(message.toString());
        const frames = Array.isArray(decoded) ? decoded : [decoded];
        const delivered = frames.filter((frame) => {
          if (
            !dropped &&
            frame._tag === "Exit" &&
            frame.requestId === lostRequestId &&
            frame.exit?._tag === "Success"
          ) {
            dropped = true;
            return false;
          }
          return true;
        });
        if (delivered.length === frames.length) socket.send(message);
        else if (delivered.length > 0)
          socket.send(JSON.stringify(Array.isArray(decoded) ? delivered : delivered[0]));
      });
    });
    // Routing starts with the next connection, including every subsequent reload.
    await f.page.reload();
    await f.page.getByRole("combobox", { name: "Runtime mode", exact: true }).click();
    await f.page.getByRole("option", { name: /^Supervised/ }).click();
    await send(f.page, "ACP_ACCEPTANCE:PLAN extracted-plan");
    const nativePlan = () =>
      sql.prepare("SELECT payload_json FROM orchestration_v2_projection_plans LIMIT 1").get() as
        | { payload_json: string }
        | undefined;
    await expect.poll(() => nativePlan(), { timeout: 30000 }).toBeDefined();
    const plan = JSON.parse(nativePlan()!.payload_json);
    expect(plan).toMatchObject({ kind: "proposed_plan", status: "active" });
    expect(plan.markdown).toContain("Preserve this source plan");
    sourcePlanRef = { threadId: plan.threadId, planId: plan.id };
    await expect
      .poll(() => f.page.getByRole("button", { name: "Stop generation", exact: true }).count(), {
        timeout: 30000,
      })
      .toBe(0);
    await extract(f, "lost-ack-once", async () => {
      await f.page.locator('input[type="file"]').setInputFiles({
        name: "extracted-evidence.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("Synthetic extracted intent attachment bytes\n"),
      });
      await expect
        .poll(() => f.page.getByTestId("composer-editor").innerText(), { timeout: 15000 })
        .toContain("extracted-evidence.txt");
      await f.page.getByTestId("composer-editor").pressSequentially(" $pdf-authoring");
      await f.page.locator('[data-composer-item-id$=":pdf-authoring"]').click({ timeout: 15000 });
    });
    await f.page.getByRole("button", { name: "Send message", exact: true }).click();
    await expect.poll(() => dropped, { timeout: 30000 }).toBe(true);
    expect(offers).toHaveLength(1);
    const offered = offers[0]!;
    expect(offered).toMatchObject({
      type: "message.dispatch",
      runtimeMode: "approval-required",
      interactionMode: "default",
      modelSelection: { instanceId: "controlled_extracted_intent", model: "controlled-model" },
      selectedScientSkillNames: ["pdf-authoring"],
      attachments: [{ name: "extracted-evidence.txt", mimeType: "text/plain" }],
    });
    expect(offered.context).toBeDefined();
    expect(sourcePlanQueueOffers).toBe(1);
    expect(offered.sourcePlanRef).toEqual(sourcePlanRef);
    expect(
      sql
        .prepare("SELECT status FROM orchestration_command_receipts WHERE command_id = ?")
        .get(String(offered.commandId)),
    ).toEqual({ status: "accepted" });
    await expect
      .poll(
        async () =>
          (await audit(f.peer)).filter(
            (event) =>
              event.event === "prompt_accepted" &&
              event.action === "ANSWER" &&
              event.label?.startsWith("lost-ack-once"),
          ).length,
        { timeout: 30000 },
      )
      .toBe(1);
    await typePrompt(f.page, "ACP_ACCEPTANCE:ANSWER later-ordinary-draft");
    await f.page.reload();
    await expect
      .poll(() => f.page.getByTestId("composer-editor").innerText(), { timeout: 60000 })
      .toContain("later-ordinary-draft");
    await f.page.getByRole("button", { name: "Send message", exact: true }).click();
    await expect.poll(() => offers.length, { timeout: 30000 }).toBe(2);
    expect(offers[1]).toEqual(offered);
    await expect
      .poll(() => f.page.getByRole("button", { name: "Send message", exact: true }).isEnabled(), {
        timeout: 30000,
      })
      .toBe(true);
    expect(await f.page.getByTestId("composer-editor").innerText()).toContain(
      "later-ordinary-draft",
    );
    expect(
      (await audit(f.peer)).filter(
        (event) =>
          event.event === "prompt_accepted" &&
          event.action === "ANSWER" &&
          event.label?.startsWith("lost-ack-once"),
      ),
    ).toHaveLength(1);
    const persisted = sql
      .prepare("SELECT payload_json FROM orchestration_v2_projection_messages WHERE message_id = ?")
      .get(String(offered.messageId)) as { payload_json: string };
    const message = JSON.parse(persisted.payload_json);
    expect(message.attachments).toHaveLength(1);
    const claimedAttachment = message.attachments[0];
    const pendingAttachment = (offered.attachments as Array<{ id: string }>)[0]!;
    expect(claimedAttachment).toEqual({ ...pendingAttachment, id: claimedAttachment.id });
    expect(claimedAttachment.id).toMatch(/^[a-zA-Z0-9_-]+$/);
    expect(message.threadId).toBe(offered.threadId);
    expect(claimedAttachment.id).toMatch(/^thread-/);
    expect(claimedAttachment.id).not.toBe(pendingAttachment.id);
    expect(
      await NodeFSP.readFile(
        NodePath.join(f.base, "userdata/attachments", `${claimedAttachment.id}.txt`),
        "utf8",
      ),
    ).toBe("Synthetic extracted intent attachment bytes\n");
    // Admission promotes pending uploads and their context bindings together.
    // The retry packet still uses the exact original pending IDs above.
    const offeredContext = offered.context as {
      records: Array<{ kind: string; attachmentId?: string }>;
    };
    expect(
      offeredContext.records.filter(
        (record) => record.kind === "file" && record.attachmentId === pendingAttachment.id,
      ),
    ).toHaveLength(1);
    expect(message.context).toEqual({
      ...offeredContext,
      records: offeredContext.records.map((record) =>
        record.attachmentId === pendingAttachment.id
          ? { ...record, attachmentId: claimedAttachment.id }
          : record,
      ),
    });
    expect(message.selectedScientSkillNames).toEqual(offered.selectedScientSkillNames);
    const runRow = sql
      .prepare(
        "SELECT payload_json FROM orchestration_v2_projection_runs WHERE json_extract(payload_json, '$.userMessageId') = ?",
      )
      .get(String(offered.messageId)) as { payload_json: string };
    expect(JSON.parse(runRow.payload_json).sourcePlanRef).toEqual(sourcePlanRef);
    await f.page.getByRole("button", { name: "Send message", exact: true }).click();
    await expect
      .poll(
        async () =>
          (await audit(f.peer)).filter(
            (event) => event.event === "prompt_accepted" && event.label === "later-ordinary-draft",
          ).length,
        { timeout: 30000 },
      )
      .toBe(1);
    expect(offers).toHaveLength(2);
    console.info(
      "[connected lost ACK receipt] " +
        JSON.stringify({
          commandId: offered.commandId,
          messageId: offered.messageId,
          extractedWireOffers: offers.length,
          identicalRetry: true,
          nativeOffers: 1,
          attachmentCount: message.attachments.length,
          laterDraftNativeOffers: 1,
        }),
    );
  } finally {
    console.info(
      "[connected lost ACK native observations] " +
        JSON.stringify(
          (await audit(f.peer)).filter(
            (event) =>
              event.event === "prompt_accepted" ||
              event.event === "idle" ||
              event.event === "worker_failed",
          ),
        ),
    );
    console.info(
      "[connected lost ACK wire observations] " +
        JSON.stringify(
          offers.map((offer) => ({
            commandId: offer.commandId,
            messageId: offer.messageId,
            runtimeMode: offer.runtimeMode,
            attachmentCount: Array.isArray(offer.attachments) ? offer.attachments.length : null,
          })),
        ),
    );
    sql.close();
    await f.close();
  }
});
test("an extracted intent has one owner across hydration, owner-close recovery and consumed stale copies", async () => {
  const f = await fixture();
  try {
    const uploads: string[] = [];
    f.context.on("request", (request) => {
      if (
        ["POST", "PUT"].includes(request.method()) &&
        new URL(request.url()).pathname.startsWith("/api/attachments")
      ) {
        uploads.push(new URL(request.url()).pathname);
      }
    });
    await extract(f, "foreign-once", async () => {
      await f.page.locator('input[type="file"]').setInputFiles({
        name: "owned-extracted-file.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("An actual file travels with the foreign draft.\n"),
      });
      await expect
        .poll(() => f.page.getByTestId("composer-editor").innerText(), {
          timeout: 15000,
        })
        .toContain("owned-extracted-file.txt");
    });
    const foreign = await f.context.newPage();
    await foreign.goto(f.page.url());
    await expect
      .poll(() => foreign.getByTestId("composer-editor").innerText(), { timeout: 60000 })
      .toContain("foreign-once");
    const uploadsBeforeForeignSend = uploads.length;
    expect(uploadsBeforeForeignSend).toBeGreaterThan(0);
    await foreign.getByRole("button", { name: "Send message", exact: true }).click();
    await expect
      .poll(() => foreign.locator("body").innerText(), { timeout: 15000 })
      .toMatch(/another window|already submitted|extracted intent/i);
    expect(uploads).toHaveLength(uploadsBeforeForeignSend);
    expect(
      (await audit(f.peer)).filter(
        (x) =>
          x.event === "prompt_accepted" &&
          x.action === "ANSWER" &&
          x.label?.startsWith("foreign-once"),
      ),
    ).toHaveLength(0);
    const sql = new NodeSqlite.DatabaseSync(NodePath.join(f.base, "userdata/statev2.sqlite"), {
      readOnly: true,
    });
    try {
      expect(
        sql
          .prepare(
            "SELECT count(*) AS n FROM orchestration_v2_projection_runs WHERE json_extract(payload_json, '$.userMessageId') IN (SELECT message_id FROM orchestration_v2_projection_messages WHERE json_extract(payload_json, '$.text') LIKE '%foreign-once%')",
          )
          .get(),
      ).toEqual({ n: 1 });
    } finally {
      sql.close();
    }
    const stale = await f.context.newPage();
    await stale.goto(f.page.url());
    await expect
      .poll(() => stale.getByTestId("composer-editor").innerText(), { timeout: 60000 })
      .toContain("foreign-once");
    // Visible hydrated text precedes asynchronous journal recovery. Finish the
    // stale page's lease attempt while the original owner still holds ownership.
    await expect
      .poll(() => stale.getByRole("button", { name: "Send message", exact: true }).isEnabled(), {
        timeout: 60000,
      })
      .toBe(true);
    await f.page.close();
    await foreign.reload();
    await expect
      .poll(() => foreign.getByTestId("composer-editor").innerText(), { timeout: 60000 })
      .toContain("foreign-once");
    await foreign.getByRole("button", { name: "Send message", exact: true }).click();
    await expect
      .poll(
        async () =>
          (await audit(f.peer)).filter(
            (x) =>
              x.event === "prompt_accepted" &&
              x.action === "ANSWER" &&
              x.label?.startsWith("foreign-once"),
          ).length,
        { timeout: 30000 },
      )
      .toBe(1);
    await expect
      .poll(async () => (await foreign.getByTestId("composer-editor").innerText()).trim(), {
        timeout: 15000,
      })
      .toBe("");
    const uploadsBeforeStaleSend = uploads.length;
    await stale.getByRole("button", { name: "Send message", exact: true }).click();
    await expect
      .poll(() => stale.locator("body").innerText(), { timeout: 15000 })
      .toContain("already submitted");
    expect(uploads).toHaveLength(uploadsBeforeStaleSend);
    expect(
      (await audit(f.peer)).filter(
        (x) =>
          x.event === "prompt_accepted" &&
          x.action === "ANSWER" &&
          x.label?.startsWith("foreign-once"),
      ),
    ).toHaveLength(1);
    // Identical text deliberately authored after consumption is a new message.
    await send(foreign, "ACP_ACCEPTANCE:ANSWER foreign-once");
    await expect
      .poll(
        async () =>
          (await audit(f.peer)).filter(
            (x) =>
              x.event === "prompt_accepted" &&
              x.action === "ANSWER" &&
              x.label?.startsWith("foreign-once"),
          ).length,
        { timeout: 30000 },
      )
      .toBe(2);
    const accepted = new NodeSqlite.DatabaseSync(NodePath.join(f.base, "userdata/statev2.sqlite"), {
      readOnly: true,
    });
    try {
      expect(
        accepted
          .prepare(
            "SELECT count(*) AS n FROM orchestration_v2_projection_runs WHERE status != 'cancelled' AND json_extract(payload_json, '$.userMessageId') IN (SELECT message_id FROM orchestration_v2_projection_messages WHERE json_extract(payload_json, '$.text') LIKE '%foreign-once%')",
          )
          .get(),
      ).toEqual({ n: 2 });
    } finally {
      accepted.close();
    }
  } finally {
    // Read only this freshly created synthetic database before teardown. The
    // deciding native/SQL facts remain in the guarded log even on assertion RED.
    console.info(
      "[connected ownership native receipt] " + JSON.stringify((await audit(f.peer)).slice(-50)),
    );
    const sql = new NodeSqlite.DatabaseSync(NodePath.join(f.base, "userdata/statev2.sqlite"), {
      readOnly: true,
    });
    try {
      console.info(
        "[connected ownership SQL receipt] " +
          JSON.stringify(
            sql
              .prepare(
                "SELECT run_id, thread_id, ordinal, status, json_extract(payload_json, '$.queueHeld') AS queueHeld, json_extract(payload_json, '$.userMessageId') AS userMessageId FROM orchestration_v2_projection_runs ORDER BY thread_id, ordinal LIMIT 20",
              )
              .all(),
          ),
      );
    } finally {
      sql.close();
      await f.close();
    }
  }
}, 180000);
test("a stashed extracted draft moves to another thread without duplicating its intent", async () => {
  const f = await fixture();
  const offers: Array<Record<string, unknown>> = [];
  let sourcePlanRef: { threadId: string; planId: string } | undefined;
  const observe = (page: Page) =>
    page.on("websocket", (socket) => {
      socket.on("framesent", ({ payload: raw }) => {
        const decoded = JSON.parse(raw.toString());
        for (const frame of Array.isArray(decoded) ? decoded : [decoded]) {
          const payload = frame.payload;
          if (
            frame._tag === "Request" &&
            typeof payload?.commandId === "string" &&
            payload.commandId.startsWith("extracted-intent:")
          ) {
            offers.push(payload);
          }
        }
      });
    });
  const uploads: string[] = [];
  f.context.on("request", (request) => {
    if (
      ["POST", "PUT"].includes(request.method()) &&
      new URL(request.url()).pathname.startsWith("/api/attachments")
    ) {
      uploads.push(new URL(request.url()).pathname);
    }
  });
  observe(f.page);
  f.context.on("page", observe);
  const sql = new NodeSqlite.DatabaseSync(NodePath.join(f.base, "userdata/statev2.sqlite"), {
    readOnly: true,
  });
  try {
    await f.page.routeWebSocket(/\/ws(?:\?|$)/, (socket) => {
      const server = socket.connectToServer();
      socket.onMessage((message) => {
        const decoded = JSON.parse(message.toString());
        const frames = Array.isArray(decoded) ? decoded : [decoded];
        for (const frame of frames) {
          if (
            sourcePlanRef &&
            frame._tag === "Request" &&
            frame.payload?.type === "message.dispatch" &&
            frame.payload.dispatchMode?.type === "queue_after_active"
          ) {
            frame.payload.sourcePlanRef = sourcePlanRef;
          }
        }
        server.send(JSON.stringify(Array.isArray(decoded) ? frames : frames[0]));
      });
      server.onMessage((message) => socket.send(message));
    });
    await f.page.reload();
    await f.page.getByRole("combobox", { name: "Runtime mode", exact: true }).click();
    await f.page.getByRole("option", { name: /^Supervised/ }).click();
    // Generate a real native plan, then associate the queued message through
    // the public dispatch contract, as in the lost-acknowledgement control.
    await send(f.page, "ACP_ACCEPTANCE:PLAN stashed-source-plan");
    const nativePlan = () =>
      sql.prepare("SELECT payload_json FROM orchestration_v2_projection_plans LIMIT 1").get() as
        | { payload_json: string }
        | undefined;
    await expect.poll(() => nativePlan(), { timeout: 30000 }).toBeDefined();
    const plan = JSON.parse(nativePlan()!.payload_json);
    expect(plan).toMatchObject({ kind: "proposed_plan", status: "active" });
    sourcePlanRef = { threadId: plan.threadId, planId: plan.id };
    await expect
      .poll(() => f.page.getByRole("button", { name: "Stop generation", exact: true }).count(), {
        timeout: 30000,
      })
      .toBe(0);
    await extract(f, "cross-target-once", async () => {
      await f.page.locator('input[type="file"]').setInputFiles({
        name: "stashed-evidence.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("Synthetic cross-target stash attachment bytes\n"),
      });
      await expect
        .poll(() => f.page.getByTestId("composer-editor").innerText(), { timeout: 15000 })
        .toContain("stashed-evidence.txt");
      await f.page.getByTestId("composer-editor").pressSequentially(" $pdf-authoring");
      await f.page.locator('[data-composer-item-id$=":pdf-authoring"]').click({ timeout: 15000 });
    });
    const sourceUrl = f.page.url();
    const sourceRow = sql
      .prepare(
        "SELECT thread_id FROM orchestration_v2_projection_messages WHERE json_extract(payload_json, '$.text') LIKE '%cross-target-once%' LIMIT 1",
      )
      .get() as { thread_id: string };
    expect(sourceRow.thread_id).toBeTruthy();
    const stale = await f.context.newPage();
    await stale.goto(sourceUrl);
    await expect
      .poll(() => stale.getByTestId("composer-editor").innerText(), { timeout: 60000 })
      .toContain("cross-target-once");
    await f.page.getByTestId("composer-editor").press("ControlOrMeta+s");
    await expect
      .poll(async () => (await f.page.getByTestId("composer-editor").innerText()).trim(), {
        timeout: 15000,
      })
      .toBe("");
    await f.page.getByRole("button", { name: "New thread in workspace", exact: true }).click();
    await expect.poll(() => f.page.url(), { timeout: 15000 }).not.toBe(sourceUrl);
    await f.page.getByRole("button", { name: /^Stashed prompts: 1\. Open stash\.$/ }).click();
    await f.page
      .getByRole("button", { name: /^Restore stashed prompt:.*cross-target-once/ })
      .click();
    await expect
      .poll(() => f.page.getByTestId("composer-editor").innerText(), { timeout: 15000 })
      .toContain("cross-target-once");
    await f.page.getByRole("button", { name: "Send message", exact: true }).click();
    await expect.poll(() => offers.length, { timeout: 30000 }).toBe(1);
    const offered = offers[0]!;
    expect(offered.threadId).not.toBe(sourceRow.thread_id);
    expect(offered).toMatchObject({
      runtimeMode: "approval-required",
      interactionMode: "default",
      modelSelection: { instanceId: "controlled_extracted_intent", model: "controlled-model" },
      initialMessage: {
        selectedScientSkillNames: ["pdf-authoring"],
        attachments: [{ name: "stashed-evidence.txt", mimeType: "text/plain" }],
      },
    });
    await expect
      .poll(
        async () =>
          (await audit(f.peer)).filter(
            (event) =>
              event.event === "prompt_accepted" &&
              event.action === "ANSWER" &&
              event.label?.startsWith("cross-target-once"),
          ).length,
        { timeout: 30000 },
      )
      .toBe(1);
    expect(
      sql
        .prepare("SELECT status FROM orchestration_command_receipts WHERE command_id = ?")
        .get(String(offered.commandId)),
    ).toEqual({ status: "accepted" });
    expect(
      sql
        .prepare("SELECT status FROM orchestration_command_receipts WHERE command_id = ?")
        .get(`${offered.commandId}:initial-message`),
    ).toEqual({ status: "accepted" });
    const opening = offered.initialMessage as { messageId: string };
    expect(typeof opening.messageId).toBe("string");
    const row = sql
      .prepare("SELECT payload_json FROM orchestration_v2_projection_messages WHERE message_id = ?")
      .get(opening.messageId) as { payload_json: string };
    const message = JSON.parse(row.payload_json);
    const run = sql
      .prepare(
        "SELECT payload_json FROM orchestration_v2_projection_runs WHERE json_extract(payload_json, '$.userMessageId') = ?",
      )
      .get(opening.messageId) as { payload_json: string };
    expect(JSON.parse(run.payload_json).sourcePlanRef).toEqual(sourcePlanRef);
    expect((offered.initialMessage as { sourcePlanRef?: unknown }).sourcePlanRef).toEqual(
      sourcePlanRef,
    );
    expect(message.threadId).toBe(offered.threadId);
    expect(message.selectedScientSkillNames).toEqual(["pdf-authoring"]);
    expect(message.attachments).toHaveLength(1);
    const claimed = message.attachments[0];
    expect(
      await NodeFSP.readFile(
        NodePath.join(f.base, "userdata/attachments", `${claimed.id}.txt`),
        "utf8",
      ),
    ).toBe("Synthetic cross-target stash attachment bytes\n");
    expect(
      message.context.records.filter(
        (record: { kind: string; attachmentId?: string }) =>
          record.kind === "file" && record.attachmentId === claimed.id,
      ),
    ).toHaveLength(1);
    // The old hydrated copy still carries the same intent. Intake on the new
    // target consumes it globally rather than authorizing a second message.
    await expect
      .poll(() => stale.getByTestId("composer-editor").innerText(), { timeout: 15000 })
      .toContain("cross-target-once");
    const uploadsBeforeStaleSend = uploads.length;
    expect(uploadsBeforeStaleSend).toBeGreaterThan(0);
    await stale.getByRole("button", { name: "Send message", exact: true }).click();
    await expect
      .poll(() => stale.locator("body").innerText(), { timeout: 15000 })
      .toContain("already submitted");
    expect(offers).toHaveLength(1);
    expect(uploads).toHaveLength(uploadsBeforeStaleSend);
    expect(
      (await audit(f.peer)).filter(
        (event) =>
          event.event === "prompt_accepted" &&
          event.action === "ANSWER" &&
          event.label?.startsWith("cross-target-once"),
      ),
    ).toHaveLength(1);
    expect(
      sql
        .prepare(
          "SELECT count(*) AS n FROM orchestration_v2_projection_runs WHERE status != 'cancelled' AND json_extract(payload_json, '$.userMessageId') IN (SELECT message_id FROM orchestration_v2_projection_messages WHERE json_extract(payload_json, '$.text') LIKE '%cross-target-once%')",
        )
        .get(),
    ).toEqual({ n: 1 });
    console.info(
      "[connected cross-target stash receipt] " +
        JSON.stringify({
          sourceThreadId: sourceRow.thread_id,
          targetThreadId: offered.threadId,
          commandId: offered.commandId,
          messageId: opening.messageId,
          wireOffers: offers.length,
          nativeOffers: 1,
          attachmentCount: message.attachments.length,
          staleCopyRefused: true,
        }),
    );
  } finally {
    console.info(
      "[connected cross-target native observations] " +
        JSON.stringify(
          (await audit(f.peer)).filter(
            (event) => event.event === "prompt_accepted" || event.event === "idle",
          ),
        ),
    );
    console.info(
      "[connected cross-target wire observations] " +
        JSON.stringify(
          offers.map((offer) => ({
            commandId: offer.commandId,
            messageId: offer.messageId,
            threadId: offer.threadId,
          })),
        ),
    );
    sql.close();
    await f.close();
  }
}, 180000);

test("diagnoses the public controlled-provider composer readiness before intake", async () => {
  const f = await fixture();
  try {
    await typePrompt(f.page, "ACP_ACCEPTANCE:HOLD readiness");
    stage("readiness composer typed through native keyboard");
    console.info("[connected readiness controls] " + JSON.stringify(await buttonStates(f.page)));
    try {
      await f.page
        .getByRole("button", { name: "Send message", exact: true })
        .click({ trial: true, timeout: 15000 });
      stage("public Send action enabled");
    } catch (cause) {
      console.info(
        "[connected readiness failure controls] " + JSON.stringify(await buttonStates(f.page)),
      );
      console.info(
        "[connected readiness editor] " +
          JSON.stringify(await f.page.getByTestId("composer-editor").innerText()),
      );
      throw cause;
    }
  } finally {
    await f.close();
  }
}, 180000);

test("drains successful FIFO work and sends any held row after idle reorder", async () => {
  const f = await fixture();
  const sql = new NodeSqlite.DatabaseSync(NodePath.join(f.base, "userdata/statev2.sqlite"), {
    readOnly: true,
  });
  const strip = f.page.getByTestId("thread-queue-strip");
  const queueRows = strip.locator('[data-testid^="thread-queue-row-"]');
  const runs = () =>
    sql
      .prepare(`
    SELECT json_extract(m.payload_json, '$.text') AS text, r.status,
      coalesce(json_extract(r.payload_json, '$.queueHeld'), 0) AS held,
      coalesce(json_extract(r.payload_json, '$.queuePosition'), r.ordinal) AS position
    FROM orchestration_v2_projection_runs r
    JOIN orchestration_v2_projection_messages m
      ON m.message_id = json_extract(r.payload_json, '$.userMessageId')
    ORDER BY r.ordinal LIMIT 20
  `)
      .all() as Array<{ text: string; status: string; held: number | null; position: number }>;
  const queued = () =>
    runs()
      .filter((run) => run.status === "queued")
      .toSorted((a, b) => a.position - b.position);
  const completed = (label: string) =>
    runs().some(
      (run) => run.text === `ACP_ACCEPTANCE:ANSWER ${label}` && run.status === "completed",
    );
  const queue = async (label: string) => {
    await typePrompt(f.page, `ACP_ACCEPTANCE:ANSWER ${label}`);
    await f.page.getByRole("button", { name: "Queue message", exact: true }).click();
    await expect
      .poll(() => queued().some((run) => run.text === `ACP_ACCEPTANCE:ANSWER ${label}`), {
        timeout: 15000,
      })
      .toBe(true);
  };
  try {
    await send(f.page, "ACP_ACCEPTANCE:HOLD auto-root");
    await expect
      .poll(
        async () =>
          (await audit(f.peer)).filter(
            (event) => event.event === "prompt_accepted" && event.label === "auto-root",
          ).length,
        { timeout: 30000 },
      )
      .toBe(1);
    await queue("fifo-first");
    await queue("fifo-second");
    await expect.poll(() => queueRows.count(), { timeout: 15000 }).toBe(2);
    expect(queued().map((run) => run.held)).toEqual([0, 0]);
    stage("successful queue admitted without a hold");

    // Release the simulated peer's real pending work. It emits its ordinary
    // ACP idle event; the production worker alone admits both successors.
    const pending = await NodeFSP.readdir(NodePath.join(f.peer, "control/pending"));
    expect(pending).toHaveLength(1);
    const held = JSON.parse(
      await NodeFSP.readFile(NodePath.join(f.peer, "control/pending", pending[0]!), "utf8"),
    ) as {
      turnId: string;
      action: string;
      label: string;
    };
    expect({ action: held.action, label: held.label }).toEqual({
      action: "HOLD",
      label: "auto-root",
    });
    await NodeFSP.writeFile(NodePath.join(f.peer, "control/release", held.turnId), "release\n");
    await expect
      .poll(() => completed("fifo-first") && completed("fifo-second"), { timeout: 30000 })
      .toBe(true);
    await expect.poll(() => queueRows.count(), { timeout: 15000 }).toBe(0);
    expect(
      (await audit(f.peer))
        .filter((event) => event.event === "prompt_accepted")
        .map((event) => event.label),
    ).toEqual(["auto-root", "fifo-first", "fifo-second"]);
    stage("successful completion automatically drained FIFO");

    await send(f.page, "ACP_ACCEPTANCE:HOLD stopped-root");
    await expect
      .poll(
        async () =>
          (await audit(f.peer)).filter(
            (event) => event.event === "prompt_accepted" && event.label === "stopped-root",
          ).length,
        { timeout: 30000 },
      )
      .toBe(1);
    await queue("held-first");
    await queue("held-second");
    await f.page.getByRole("button", { name: "Stop generation", exact: true }).click();
    await expect.poll(() => queued().map((run) => run.held), { timeout: 30000 }).toEqual([1, 1]);
    // A held queue on an idle thread offers Send on every row and no Resume queue.
    await expect
      .poll(() => strip.getByRole("button", { name: "Send", exact: true }).count(), {
        timeout: 15000,
      })
      .toBe(2);
    await expect(strip.getByRole("button", { name: "Resume queue", exact: true })).toHaveCount(0);
    stage("public Stop held both pending messages");

    // Exercise the original strip's actual pointer sensor while the thread is idle.
    const from = await queueRows
      .nth(1)
      .getByRole("button", {
        name: "Reorder queued message",
        exact: true,
      })
      .boundingBox();
    const to = await queueRows.first().boundingBox();
    expect(from).not.toBeNull();
    expect(to).not.toBeNull();
    await f.page.mouse.move(from!.x + from!.width / 2, from!.y + from!.height / 2);
    await f.page.mouse.down();
    await f.page.mouse.move(from!.x + from!.width / 2, to!.y + to!.height / 2, { steps: 10 });
    await f.page.mouse.up();
    await expect
      .poll(() => queued().map((run) => run.text), { timeout: 15000 })
      .toEqual(["ACP_ACCEPTANCE:ANSWER held-second", "ACP_ACCEPTANCE:ANSWER held-first"]);
    await expect
      .poll(() => queueRows.first().innerText(), { timeout: 15000 })
      .toContain("held-second");
    stage("idle pointer reorder reached native queue authority");

    // Send on the second row starts that message now; the rest of the queue
    // continues after it without a Resume.
    await queueRows.nth(1).getByRole("button", { name: "Send", exact: true }).click();
    await expect.poll(() => completed("held-first"), { timeout: 30000 }).toBe(true);
    await expect.poll(() => completed("held-second"), { timeout: 30000 }).toBe(true);
    await expect.poll(() => queueRows.count(), { timeout: 15000 }).toBe(0);
    expect(queued()).toEqual([]);
    expect(
      (await audit(f.peer))
        .filter((event) => event.event === "prompt_accepted")
        .map((event) => event.label),
    ).toEqual([
      "auto-root",
      "fifo-first",
      "fifo-second",
      "stopped-root",
      "held-first",
      "held-second",
    ]);
    stage("Send on a non-head row resumed the whole queue");
    console.info("[connected queue policy receipt] " + JSON.stringify(runs()));
  } finally {
    console.info(
      "[connected queue policy native observations] " +
        JSON.stringify(
          (await audit(f.peer)).filter(
            (event) => event.event === "prompt_accepted" || event.event === "idle",
          ),
        ),
    );
    console.info("[connected queue policy final state] " + JSON.stringify(runs()));
    sql.close();
    await f.close();
  }
}, 180000);

test("promotes one queued message through the public Steer control and real ACP restart", async () => {
  const f = await fixture();
  const sql = new NodeSqlite.DatabaseSync(NodePath.join(f.base, "userdata/statev2.sqlite"), {
    readOnly: true,
  });
  const promotions: Array<{ commandId: string; queuedRunId: string; targetRunId: string }> = [];
  const strip = f.page.getByTestId("thread-queue-strip");
  try {
    await f.page.routeWebSocket(/\/ws(?:\?|$)/, (socket) => {
      const server = socket.connectToServer();
      socket.onMessage((message) => {
        const decoded = JSON.parse(message.toString());
        for (const frame of Array.isArray(decoded) ? decoded : [decoded]) {
          if (frame._tag === "Request" && frame.payload?.type === "queued-message.promote-to-steer")
            promotions.push(frame.payload);
        }
        server.send(message);
      });
      server.onMessage((message) => socket.send(message));
    });
    await f.page.reload();
    await expect
      .poll(() => f.page.getByTestId("composer-editor").count(), { timeout: 60000 })
      .toBe(1);
    await send(f.page, "ACP_ACCEPTANCE:HOLD steer-owner");
    await expect
      .poll(
        async () =>
          (await audit(f.peer)).filter(
            (event) => event.event === "prompt_accepted" && event.label === "steer-owner",
          ).length,
        { timeout: 30000 },
      )
      .toBe(1);
    await typePrompt(f.page, "ACP_ACCEPTANCE:ANSWER steered-once");
    await f.page.getByRole("button", { name: "Queue message", exact: true }).click();
    await expect
      .poll(() => strip.locator('[data-testid^="thread-queue-row-"]').count(), { timeout: 15000 })
      .toBe(1);
    const queued = sql
      .prepare(`SELECT r.run_id, json_extract(r.payload_json, '$.userMessageId') AS message_id
      FROM orchestration_v2_projection_runs r WHERE r.status = 'queued'`)
      .get() as { run_id: string; message_id: string };
    const active = sql
      .prepare(`SELECT run_id FROM orchestration_v2_projection_runs
      WHERE status = 'running'`)
      .get() as { run_id: string };
    expect(queued).toBeDefined();
    expect(active).toBeDefined();
    await strip.getByRole("button", { name: "Steer", exact: true }).click();
    await expect
      .poll(
        async () =>
          (await audit(f.peer)).filter(
            (event) => event.event === "prompt_accepted" && event.label === "steered-once",
          ).length,
        { timeout: 30000 },
      )
      .toBe(1);
    await expect
      .poll(
        () =>
          sql
            .prepare(`SELECT status FROM orchestration_v2_projection_runs
      WHERE run_id = ?`)
            .get(active.run_id),
        { timeout: 30000 },
      )
      .toEqual({ status: "completed" });
    expect(promotions).toHaveLength(1);
    expect(promotions[0]).toMatchObject({ queuedRunId: queued.run_id, targetRunId: active.run_id });
    expect(
      sql
        .prepare(`SELECT status FROM orchestration_v2_projection_runs WHERE run_id = ?`)
        .get(queued.run_id),
    ).toEqual({ status: "cancelled" });
    const message = sql
      .prepare(`SELECT m.run_id, json_extract(m.payload_json, '$.text') AS text,
      json_extract(i.payload_json, '$.inputIntent') AS intent
      FROM orchestration_v2_projection_messages m JOIN orchestration_v2_projection_turn_items i
        ON json_extract(i.payload_json, '$.messageId') = m.message_id
      WHERE m.message_id = ? AND i.type = 'user_message'`)
      .get(queued.message_id);
    expect(message).toEqual({
      run_id: active.run_id,
      text: "ACP_ACCEPTANCE:ANSWER steered-once",
      intent: "promoted_queued_to_steer",
    });
    await expect
      .poll(() => strip.locator('[data-testid^="thread-queue-row-"]').count(), { timeout: 15000 })
      .toBe(0);
    await expect
      .poll(() => f.page.locator('[data-user-message-intent="promoted_queued_to_steer"]').count(), {
        timeout: 15000,
      })
      .toBe(1);
    expect(
      (await audit(f.peer))
        .filter((event) => event.event === "prompt_accepted")
        .map((event) => event.label),
    ).toEqual(["steer-owner", "steered-once"]);
    expect(
      (await audit(f.peer)).filter((event) => event.event === "cancel_requested"),
    ).toHaveLength(1);
    console.info("[connected positive steer receipt] " + JSON.stringify({ promotions, message }));
  } finally {
    console.info(
      "[connected positive steer native observations] " +
        JSON.stringify(
          (await audit(f.peer)).filter(
            (event) =>
              event.event === "prompt_accepted" ||
              event.event === "idle" ||
              event.event === "cancel_requested",
          ),
        ),
    );
    sql.close();
    await f.close();
  }
}, 180000);
