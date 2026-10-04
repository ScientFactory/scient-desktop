// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as Effect from "effect/Effect";

/**
 * An ACP stand-in that behaves like Droid 0.228.0 where Scient depends on it:
 * `{}` config acknowledgements followed by `config_option_update`, an
 * `autonomy_level` selector (`AUTONOMY=none` omits it), and concurrent
 * prompts. The test supplies `onPrompt(message)` and optionally `onCancel()`;
 * `request`, `update`, `reply` and `fail` are in scope. Every inbound message
 * is appended to the log.
 */
async function makeScriptedDroid(body: string, env: Record<string, string> = {}) {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "droid-acp-scripted-"));
  const logPath = NodePath.join(dir, "inbound.ndjson");
  const agentPath = NodePath.join(dir, "agent.mjs");
  await NodeFSP.writeFile(
    agentPath,
    `
import * as fs from "node:fs";
import * as readline from "node:readline";
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const state = {
  autonomy: process.env.AUTONOMY ?? "normal",
  locked: process.env.AUTONOMY_LOCKED === "1",
  model: process.env.MODEL ?? "droid-native",
  prompts: 0,
  nextId: 1000,
  waiters: new Map(),
};
const options = () => [
  ...(state.autonomy === "none"
    ? []
    : [{ id: "autonomy_level", name: "Autonomy", category: "mode", type: "select", currentValue: state.autonomy,
        options: ["normal", "spec", "auto-low", "auto-medium", "auto-high"].map((value) => ({ value, name: value })) }]),
  { id: "model", name: "Model", category: "model", type: "select", currentValue: state.model,
    options: ["droid-native", "custom:scient-fixture", "droid-other"].map((value) => ({ value, name: value })) },
];
const update = (value) => send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "scripted", update: value } });
const publish = () => update({ sessionUpdate: "config_option_update", configOptions: options() });
const request = (method, params) => new Promise((resolve) => {
  const id = state.nextId++;
  state.waiters.set(id, resolve);
  send({ jsonrpc: "2.0", id, method, params: { sessionId: "scripted", ...params } });
});
const reply = (message, result) => send({ jsonrpc: "2.0", id: message.id, result });
const fail = (message, error) => send({ jsonrpc: "2.0", id: message.id, error });
let onCancel = () => {};
let onConfig = () => {};
// A write this returns true for is answered but never reported.
let unreported = () => false;
${body}
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  fs.appendFileSync(${JSON.stringify(logPath)}, line + "\\n");
  if (message.id !== undefined && message.method === undefined) {
    state.waiters.get(message.id)?.(message);
    state.waiters.delete(message.id);
    return;
  }
  switch (message.method) {
    case "initialize":
      return reply(message, { protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: [] });
    case "session/new":
    case "session/load":
      return reply(message, { sessionId: "scripted", configOptions: options() });
    case "session/set_config_option":
      if (message.params.configId === "autonomy_level" && !state.locked) state.autonomy = message.params.value;
      if (message.params.configId === "model") state.model = message.params.value;
      onConfig(message);
      reply(message, {});
      return unreported(message) ? undefined : publish();
    case "session/cancel":
      return onCancel();
    case "session/prompt":
      state.prompts++;
      return onPrompt(message);
    default:
      if (message.id !== undefined) reply(message, {});
  }
});
`,
    "utf8",
  );
  const binaryPath = NodePath.join(dir, "fake-droid.sh");
  await NodeFSP.writeFile(
    binaryPath,
    [
      "#!/bin/sh",
      ...Object.entries(env).map(([key, value]) => `export ${key}=${JSON.stringify(value)}`),
      `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(agentPath)}`,
      "",
    ].join("\n"),
    "utf8",
  );
  await NodeFSP.chmod(binaryPath, 0o755);
  const readLog = () =>
    Effect.promise(() => NodeFSP.readFile(logPath, "utf8").catch(() => "")).pipe(
      Effect.map((contents) =>
        contents
          .split("\n")
          .filter((line) => line.length > 0)
          .map(
            (line) =>
              JSON.parse(line) as {
                readonly id?: number;
                readonly method?: string;
                readonly params?: Record<string, unknown>;
                readonly result?: {
                  readonly [key: string]: unknown;
                  readonly outcome?: { readonly outcome?: string; readonly optionId?: string };
                };
              },
          ),
      ),
    );
  return { binaryPath, readLog, cleanup: () => NodeFSP.rm(dir, { recursive: true, force: true }) };
}

export const scriptedDroid = (body: string, env?: Record<string, string>) =>
  Effect.acquireRelease(
    Effect.promise(() => makeScriptedDroid(body, env)),
    (droid) => Effect.promise(droid.cleanup),
  );
