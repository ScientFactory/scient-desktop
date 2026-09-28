import { describe, expect, it } from "vite-plus/test";

import { initialOmpTurnState, reduceOmpTurn } from "./OmpTurnMachine.ts";

const begin = () => reduceOmpTurn(initialOmpTurnState, { type: "begin" }).state;

describe("Oh My Pi turn machine", () => {
  it("treats a prompt acknowledgement as acceptance, not completion", () => {
    const accepted = reduceOmpTurn(begin(), {
      type: "prompt-accepted",
      requestId: "req-1",
      agentInvoked: true,
    });
    expect(accepted.outcome).toBeUndefined();
    expect(accepted.state.phase).toBe("accepted");
  });

  it("completes a local prompt without waiting for agent_end", () => {
    const local = reduceOmpTurn(begin(), {
      type: "prompt-accepted",
      requestId: "req-1",
      agentInvoked: false,
    });
    expect(local.outcome).toBe("local");
  });

  it("waits for a later idle confirmation after a terminal agent_end", () => {
    const running = reduceOmpTurn(begin(), { type: "agent-start" }).state;
    const draining = reduceOmpTurn(running, { type: "agent-end", terminal: true });
    expect(draining.outcome).toBeUndefined();
    expect(draining.state.phase).toBe("draining");
    expect(reduceOmpTurn(draining.state, { type: "drain-idle" }).outcome).toBe("completed");
  });

  it("does not complete when agent_end says more work is scheduled", () => {
    const running = reduceOmpTurn(begin(), { type: "agent-start" }).state;
    const continued = reduceOmpTurn(running, { type: "agent-end", terminal: false });
    expect(continued.outcome).toBeUndefined();
    expect(continued.state.phase).toBe("running");
    expect(reduceOmpTurn(continued.state, { type: "drain-idle" }).outcome).toBeUndefined();
  });

  it("fails a later error for the accepted request and ignores a different request", () => {
    const accepted = reduceOmpTurn(begin(), {
      type: "prompt-accepted",
      requestId: "req-1",
      agentInvoked: true,
    }).state;
    expect(
      reduceOmpTurn(accepted, { type: "prompt-failed", requestId: "req-2" }).outcome,
    ).toBeUndefined();
    expect(reduceOmpTurn(accepted, { type: "prompt-failed", requestId: "req-1" }).outcome).toBe(
      "failed",
    );
  });

  it("R1-F1 applies no prompt outcome before the turn knows its prompt id", () => {
    const open = begin();
    expect(reduceOmpTurn(open, { type: "prompt-failed", requestId: "7" }).outcome).toBeUndefined();
    const result = reduceOmpTurn(open, {
      type: "prompt-result",
      requestId: "7",
      agentInvoked: false,
    });
    expect(result.outcome).toBeUndefined();
    expect(result.state.requestId).toBeUndefined();
    // The turn's own prompt command being rejected still settles it.
    expect(reduceOmpTurn(open, { type: "command-failed" }).outcome).toBe("failed");
  });

  it("keeps a late acknowledgement from reopening a draining turn", () => {
    const running = reduceOmpTurn(begin(), { type: "agent-start" }).state;
    const draining = reduceOmpTurn(running, { type: "agent-end", terminal: true }).state;
    const acknowledged = reduceOmpTurn(draining, {
      type: "prompt-accepted",
      requestId: "req-1",
      agentInvoked: true,
    });
    expect(acknowledged.state.phase).toBe("draining");
    expect(reduceOmpTurn(acknowledged.state, { type: "drain-idle" }).outcome).toBe("completed");
  });

  it("never turns a process exit into success", () => {
    const running = reduceOmpTurn(begin(), { type: "agent-start" }).state;
    expect(reduceOmpTurn(running, { type: "process-exit" }).outcome).toBe("unknown");
    expect(reduceOmpTurn(initialOmpTurnState, { type: "process-exit" }).outcome).toBeUndefined();
  });

  it("keeps an unconfirmed idle check uncertain", () => {
    const running = reduceOmpTurn(begin(), { type: "agent-start" }).state;
    const draining = reduceOmpTurn(running, { type: "agent-end", terminal: true }).state;
    expect(reduceOmpTurn(draining, { type: "unconfirmed" }).outcome).toBe("unknown");
    expect(reduceOmpTurn(initialOmpTurnState, { type: "unconfirmed" }).outcome).toBeUndefined();
  });

  it("ignores the tail of an aborted run after the next turn begins", () => {
    // Run 1 was still open when its turn settled by an acknowledged abort.
    const next = reduceOmpTurn(initialOmpTurnState, { type: "begin", staleRunId: 1 }).state;
    const tail = reduceOmpTurn(next, { type: "agent-end", terminal: true, runId: 1 });
    expect(tail.outcome).toBeUndefined();
    expect(tail.state.phase).toBe("accepted");
    expect(reduceOmpTurn(tail.state, { type: "drain-idle" }).outcome).toBeUndefined();
    const running = reduceOmpTurn(tail.state, { type: "agent-start", runId: 2 }).state;
    expect(running.phase).toBe("running");
    const draining = reduceOmpTurn(running, { type: "agent-end", terminal: true, runId: 2 }).state;
    expect(reduceOmpTurn(draining, { type: "drain-idle" }).outcome).toBe("completed");
  });

  it("ignores an agent end for a run the turn does not own", () => {
    const running = reduceOmpTurn(begin(), { type: "agent-start", runId: 4 }).state;
    const foreign = reduceOmpTurn(running, { type: "agent-end", terminal: true, runId: 3 });
    expect(foreign.state.phase).toBe("running");
    const own = reduceOmpTurn(foreign.state, { type: "agent-end", terminal: true, runId: 4 });
    expect(own.state.phase).toBe("draining");
  });

  it("keeps following a turn across its own consecutive runs", () => {
    const first = reduceOmpTurn(begin(), { type: "agent-start", runId: 1 }).state;
    const continued = reduceOmpTurn(first, { type: "agent-end", terminal: false, runId: 1 }).state;
    const second = reduceOmpTurn(continued, { type: "agent-start", runId: 2 }).state;
    expect(second.runId).toBe(2);
    const draining = reduceOmpTurn(second, { type: "agent-end", terminal: true, runId: 2 }).state;
    expect(reduceOmpTurn(draining, { type: "drain-idle" }).outcome).toBe("completed");
  });
});
