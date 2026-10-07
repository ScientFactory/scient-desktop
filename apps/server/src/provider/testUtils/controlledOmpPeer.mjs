import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";
import * as NodeURL from "node:url";

// Controlled native stdio endpoint; it never calls a model, vendor, shell tool or account.
if (process.argv.includes("--version")) {
  process.stdout.write("18.4.8\n");
  process.exit(0);
}
const args = process.argv.slice(2);
const value = (flag) => args[args.indexOf(flag) + 1];
const root = NodeFS.realpathSync(value("--session-dir"));
const auditPath = process.env.SCIENT_CONTROLLED_OMP_AUDIT;
const controlPath = process.env.SCIENT_CONTROLLED_OMP_CONTROL;
if (!auditPath || !controlPath || value("--mode") !== "rpc")
  throw new Error("Invalid controlled process launch");
const audit = (entry) =>
  NodeFS.appendFileSync(auditPath, JSON.stringify({ pid: process.pid, ...entry }) + "\n");
const output = (frame) => process.stdout.write(JSON.stringify(frame) + "\n");
const hooks = new Map();
const commands = new Map();
const api = {
  on: (name, handler) => {
    const list = hooks.get(name) ?? [];
    list.push(handler);
    hooks.set(name, list);
  },
  registerCommand: (name, command) => commands.set(name, command),
  registerProvider: () => {
    throw new Error("This controlled peer has no custom models");
  },
  unregisterProvider: () => {},
  registerTool: () => {
    throw new Error("This controlled peer has MCP disabled");
  },
};
const emitHook = async (name, input = {}) => {
  for (const handler of hooks.get(name) ?? []) await handler(input);
};
const extensions = args.flatMap((arg, index) => (arg === "--extension" ? [args[index + 1]] : []));
for (const file of extensions)
  await (await import(NodeURL.pathToFileURL(NodeFS.realpathSync(file)).href)).default(api);
audit({
  type: "opened",
  executable: NodeFS.realpathSync(process.argv[1]),
  cwd: NodeFS.realpathSync(process.cwd()),
  root,
  extensionCount: extensions.length,
  mode: value("--mode"),
  approvalMode: value("--approval-mode"),
});
let ordinal = 0;
let sessionId;
let sessionFile;
let thinkingLevel = "off";
const model = {
  provider: "controlled",
  id: "model",
  name: "Controlled OMP",
  input: ["text"],
  contextWindow: 8192,
  maxTokens: 512,
};
const fresh = () => {
  sessionId = `controlled-${process.pid}-${++ordinal}`;
  sessionFile = NodePath.join(root, `${sessionId}.jsonl`);
  NodeFS.writeFileSync(sessionFile, JSON.stringify({ type: "session", id: sessionId }) + "\n", {
    mode: 0o600,
  });
};
fresh();
const response = (command, data) =>
  output({
    type: "response",
    id: command.id,
    command: command.type,
    success: true,
    ...(data === undefined ? {} : { data }),
  });
output({
  type: "ready",
  protocolVersion: 1,
  supportedProtocolVersions: [1, 2],
  maxFrameBytes: 1048576,
  maxReassembledFrameBytes: 67108864,
});
const input = NodeReadline.createInterface({ input: process.stdin, terminal: false });
let active;
const finish = () => {
  if (!active) throw new Error("No controlled foreground turn");
  const message = {
    role: "assistant",
    content: [{ type: "text", text: "CONTROLLED_DONE" }],
    stopReason: "stop",
  };
  NodeFS.appendFileSync(sessionFile, JSON.stringify({ type: "message", ...message }) + "\n");
  output({ type: "message_end", message, messageId: `assistant-${active}` });
  output({ type: "turn_end", message });
  output({ type: "agent_end", messages: [message], isTerminal: true, yielded: true });
  output({
    type: "prompt_result",
    id: active,
    agentInvoked: true,
    status: "completed",
    sessionSettled: true,
  });
  output({ type: "session_settled" });
  active = undefined;
};
// A task-private file releases the controlled foreground only after real SQL queue admission.
let released = false;
const control = NodeFS.watch(controlPath, () => {
  if (!released && NodeFS.readFileSync(controlPath, "utf8") === "finish" && active) {
    released = true;
    finish();
  }
});
for await (const line of input) {
  const command = JSON.parse(line);
  audit({
    type: "command",
    command: command.type,
    sessionFile,
    ...(command.type === "switch_session" ? { switchTarget: command.sessionPath } : {}),
    ...(command.type === "prompt"
      ? {
          held: command.message.endsWith("CONTROLLED_HOLD"),
          promptLabel: command.message.endsWith("queued-second")
            ? "queued-second"
            : command.message.endsWith("queued-first")
              ? "queued-first"
              : "foreground",
        }
      : {}),
  });
  switch (command.type) {
    case "negotiate_protocol":
      response(command, { protocolVersion: 2 });
      break;
    case "get_state":
      response(command, {
        sessionFile,
        sessionId,
        model,
        thinkingLevel,
        isStreaming: active !== undefined,
        isCompacting: false,
      });
      break;
    case "get_available_models":
      response(command, { models: [model] });
      break;
    case "get_available_commands":
      response(command, { commands: [] });
      break;
    case "set_subagent_subscription":
      response(command, { level: command.level });
      break;
    case "set_event_filter":
      response(command, { events: command.events });
      break;
    case "new_session":
      fresh();
      await emitHook("session_start");
      response(command, { cancelled: false });
      break;
    case "switch_session": {
      const file = NodeFS.realpathSync(command.sessionPath);
      if (NodePath.relative(root, file).startsWith("..")) throw new Error("Foreign transcript");
      sessionFile = file;
      sessionId = JSON.parse(NodeFS.readFileSync(file, "utf8").split("\n")[0]).id;
      await emitHook("session_start");
      response(command, { cancelled: false });
      break;
    }
    case "set_model":
      if (command.provider !== model.provider || command.modelId !== model.id)
        throw new Error("Foreign model");
      response(command, model);
      break;
    case "set_thinking_level":
      thinkingLevel = command.level;
      response(command, { level: thinkingLevel });
      break;
    case "prompt": {
      if (active) throw new Error("Overlapping prompt");
      active = command.id;
      await emitHook("before_agent_start", { systemPrompt: ["Controlled native boundary"] });
      response(command, { agentInvoked: true });
      output({ type: "agent_start" });
      output({ type: "turn_start" });
      NodeFS.appendFileSync(
        sessionFile,
        JSON.stringify({ type: "message", role: "user", text: command.message }) + "\n",
      );
      if (command.message.endsWith("CONTROLLED_HOLD")) break;
      finish();
      break;
    }
    default:
      throw new Error(`Unexpected native command ${command.type}`);
  }
}
control.close();
await emitHook("session_shutdown");
audit({ type: "closed", sessionFile });
process.exit(0);
