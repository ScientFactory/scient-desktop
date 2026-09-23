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

  it("keeps cancellation distinct until it is confirmed", () => {
    const running = reduceOmpTurn(begin(), { type: "agent-start" }).state;
    const requested = reduceOmpTurn(running, { type: "cancel-requested" });
    expect(requested.outcome).toBeUndefined();
    expect(requested.state.cancelRequested).toBe(true);
    const draining = reduceOmpTurn(requested.state, { type: "agent-end", terminal: true }).state;
    expect(reduceOmpTurn(draining, { type: "drain-idle" }).outcome).toBe("interrupted");
  });

  it("keeps an unconfirmed idle check uncertain", () => {
    const running = reduceOmpTurn(begin(), { type: "agent-start" }).state;
    const draining = reduceOmpTurn(running, { type: "agent-end", terminal: true }).state;
    expect(reduceOmpTurn(draining, { type: "unconfirmed" }).outcome).toBe("unknown");
    expect(reduceOmpTurn(initialOmpTurnState, { type: "unconfirmed" }).outcome).toBeUndefined();
  });
});
