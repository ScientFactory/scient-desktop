// @effect-diagnostics globalTimers:off -- The mock deliberately simulates a delayed native process crash.
/** Test fixture for Antigravity's persistent stream-json protocol. */

import * as NodeReadline from "node:readline";

const conversationArgumentIndex = process.argv.indexOf("--conversation");
const conversationId =
  (conversationArgumentIndex >= 0 ? process.argv[conversationArgumentIndex + 1] : undefined) ??
  `mock-conversation-${process.pid}`;
let initialized = false;
let turn = 0;

const send = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);

const lines = NodeReadline.createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", (line) => {
  const parsed = JSON.parse(line) as { event?: string; message?: { content?: string } };
  if (parsed.event !== "user" || typeof parsed.message?.content !== "string") {
    process.stderr.write("invalid user event\n");
    process.exit(2);
  }
  const prompt = parsed.message.content;
  turn += 1;
  if (!initialized) {
    initialized = true;
    send({ event: "init", conversation_id: conversationId, init: { version: "mock" } });
  }
  const userPrompt = prompt.includes("\n\n") ? (prompt.split("\n\n").at(-1) ?? prompt) : prompt;
  if (userPrompt === "MALFORMED") {
    process.stdout.write("not-json\n");
    return;
  }
  if (userPrompt === "EXIT") {
    process.stderr.write("mock process failure\n");
    process.exit(17);
  }
  if (userPrompt === "HANG") return;

  if (prompt.includes("TOOL")) {
    send({
      event: "step_update",
      step_update: {
        conversation_id: conversationId,
        step_index: 1,
        state: "ACTIVE",
        step_type: "tool",
        tool_name: "read_file",
        tool_info: { parameters: { path: "README.md" } },
      },
    });
    send({
      event: "step_update",
      step_update: {
        conversation_id: conversationId,
        step_index: 1,
        state: "DONE",
        step_type: "tool",
        tool_name: "read_file",
        tool_info: { output: "contents" },
      },
    });
  }
  if (prompt.includes("SUBAGENT")) {
    send({
      event: "step_update",
      step_update: {
        conversation_id: conversationId,
        step_index: 3,
        state: "DONE",
        step_type: "tool",
        subagent_info: {
          subagents: [{ type_name: "research", role: "Research", conversation_id: "sub-1" }],
        },
      },
    });
  }
  if (userPrompt === "FAIL") {
    send({
      event: "result",
      result: {
        conversation_id: conversationId,
        status: "ERROR",
        error: "mock turn failure",
      },
    });
    return;
  }

  const response = userPrompt === "ECHO_PROMPT" ? prompt : `turn-${turn}:${userPrompt}`;
  send({
    event: "step_update",
    step_update: {
      conversation_id: conversationId,
      step_index: 2,
      state: "ACTIVE",
      step_type: "agent_response",
      text_delta: response.slice(0, 5),
    },
  });
  send({
    event: "step_update",
    step_update: {
      conversation_id: conversationId,
      step_index: 2,
      state: "DONE",
      step_type: "agent_response",
      text_delta: response.slice(5),
    },
  });
  send({
    event: "result",
    result: {
      conversation_id: conversationId,
      status: "SUCCESS",
      response,
      structured_output: process.env.AGY_MOCK_STRUCTURED_OUTPUT
        ? JSON.parse(process.env.AGY_MOCK_STRUCTURED_OUTPUT)
        : { response },
      usage: { input_tokens: turn, output_tokens: turn + 1 },
    },
  });
  if (userPrompt === "CRASH_AFTER") {
    setTimeout(() => {
      process.stderr.write("mock idle process failure\n");
      process.exit(18);
    }, 5);
  }
});
