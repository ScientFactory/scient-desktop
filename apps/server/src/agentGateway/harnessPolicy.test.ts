import { describe, expect, it } from "vitest";

import {
  SYNARA_HARNESS_POLICY_MARKER,
  providerHasSynaraGatewayControl,
  renderSynaraHarnessPolicy,
  takeSynaraHarnessPolicyForProviderSession,
  takeSynaraHarnessPolicyForSession,
  takeSynaraHarnessPolicyTextPartForProviderSession,
  type SynaraHarnessPolicyDeliveryState,
} from "./harnessPolicy.ts";

describe("renderSynaraHarnessPolicy", () => {
  it("includes the marker and read-tool/untrusted-data guidance when control is available", () => {
    const policy = renderSynaraHarnessPolicy({ gatewayControlAvailable: true });
    expect(policy).toContain(SYNARA_HARNESS_POLICY_MARKER);
    expect(policy).toContain("scient_context");
    expect(policy).toContain("scient_list_projects");
    expect(policy).toContain("scient_list_threads");
    expect(policy).toContain("scient_read_thread");
    expect(policy).toContain("scient_wait_for_threads");
    expect(policy).toContain("untrusted data");
  });

  it("describes the drive tools and their guardrails when control is available", () => {
    const policy = renderSynaraHarnessPolicy({ gatewayControlAvailable: true });
    expect(policy).toContain("scient_send_message");
    expect(policy).toContain("scient_interrupt_thread");
    // The active-turn and privilege guardrails must be stated to the model.
    expect(policy).toContain("while your own turn is active");
    expect(policy).toContain("higher-privilege");
  });

  it("states control is unavailable and does not claim tool access when unavailable", () => {
    const policy = renderSynaraHarnessPolicy({ gatewayControlAvailable: false });
    expect(policy).toContain(SYNARA_HARNESS_POLICY_MARKER);
    expect(policy).toContain("Scient MCP control is unavailable in this provider session.");
    expect(policy).not.toContain("scient_context");
    expect(policy).not.toContain("scient_read_thread");
    expect(policy).not.toContain("scient_send_message");
    expect(policy).not.toContain("scient_interrupt_thread");
  });
});

describe("providerHasSynaraGatewayControl", () => {
  it("returns true for claudeAgent with an available scoped connection", () => {
    expect(
      providerHasSynaraGatewayControl({
        provider: "claudeAgent",
        scopedGatewayConnectionAvailable: true,
      }),
    ).toBe(true);
  });

  it("returns false for claudeAgent when the scoped connection is unavailable", () => {
    expect(
      providerHasSynaraGatewayControl({
        provider: "claudeAgent",
        scopedGatewayConnectionAvailable: false,
      }),
    ).toBe(false);
  });

  it("returns false for codex even with an available scoped connection (not wired this slice)", () => {
    expect(
      providerHasSynaraGatewayControl({
        provider: "codex",
        scopedGatewayConnectionAvailable: true,
      }),
    ).toBe(false);
  });
});

describe("takeSynaraHarnessPolicyForSession", () => {
  it("returns the wrapped policy on first call and sets harnessPolicyDelivered", () => {
    const state: SynaraHarnessPolicyDeliveryState = {};
    const result = takeSynaraHarnessPolicyForSession(state, { gatewayControlAvailable: true });
    expect(typeof result).toBe("string");
    expect(result).not.toBeNull();
    expect(result?.startsWith("<scient_host_context>")).toBe(true);
    expect(result?.endsWith("</scient_host_context>")).toBe(true);
    expect(state.harnessPolicyDelivered).toBe(true);
  });

  it("returns null on the second call", () => {
    const state: SynaraHarnessPolicyDeliveryState = {};
    takeSynaraHarnessPolicyForSession(state, { gatewayControlAvailable: true });
    const second = takeSynaraHarnessPolicyForSession(state, { gatewayControlAvailable: true });
    expect(second).toBeNull();
  });
});

describe("takeSynaraHarnessPolicyForProviderSession", () => {
  it("returns content on first call for claudeAgent with an available connection, then null", () => {
    const state: SynaraHarnessPolicyDeliveryState = {};
    const first = takeSynaraHarnessPolicyForProviderSession(state, {
      provider: "claudeAgent",
      scopedGatewayConnectionAvailable: true,
    });
    expect(first).not.toBeNull();
    expect(first).toContain(SYNARA_HARNESS_POLICY_MARKER);

    const second = takeSynaraHarnessPolicyForProviderSession(state, {
      provider: "claudeAgent",
      scopedGatewayConnectionAvailable: true,
    });
    expect(second).toBeNull();
  });

  it("uses the identity-only policy text for a non-wired provider", () => {
    const state: SynaraHarnessPolicyDeliveryState = {};
    const result = takeSynaraHarnessPolicyForProviderSession(state, {
      provider: "codex",
      scopedGatewayConnectionAvailable: true,
    });
    expect(result).not.toBeNull();
    expect(result).toContain("Scient MCP control is unavailable in this provider session.");
    expect(result).not.toContain("scient_read_thread");
  });
});

describe("takeSynaraHarnessPolicyTextPartForProviderSession", () => {
  it("returns a TextPart on first call for claudeAgent with an available connection, then null", () => {
    const state: SynaraHarnessPolicyDeliveryState = {};
    const first = takeSynaraHarnessPolicyTextPartForProviderSession(state, {
      provider: "claudeAgent",
      scopedGatewayConnectionAvailable: true,
    });
    expect(first).not.toBeNull();
    expect(first?.type).toBe("text");
    expect(typeof first?.text).toBe("string");
    expect(first?.text).toContain(SYNARA_HARNESS_POLICY_MARKER);

    const second = takeSynaraHarnessPolicyTextPartForProviderSession(state, {
      provider: "claudeAgent",
      scopedGatewayConnectionAvailable: true,
    });
    expect(second).toBeNull();
  });

  it("uses the identity-only policy text for a non-wired provider", () => {
    const state: SynaraHarnessPolicyDeliveryState = {};
    const result = takeSynaraHarnessPolicyTextPartForProviderSession(state, {
      provider: "codex",
      scopedGatewayConnectionAvailable: true,
    });
    expect(result).not.toBeNull();
    expect(result?.type).toBe("text");
    expect(result?.text).toContain("Scient MCP control is unavailable in this provider session.");
  });
});
