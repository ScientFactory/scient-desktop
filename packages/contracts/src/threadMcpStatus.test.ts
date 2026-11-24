import { describe, expect, it } from "@effect/vitest";

import { ProviderThreadId } from "./baseSchemas.ts";
import {
  isLegacyMcpStartupNotice,
  isMcpSignInRequestNotice,
  isProminentThreadMcpIssue,
  requestedMcpSignInIsOpen,
  type ThreadMcpServerObservation,
} from "./threadMcpStatus.ts";

const server = (
  overrides: Partial<ThreadMcpServerObservation> = {},
): ThreadMcpServerObservation => ({
  id: "native:guru",
  name: "guru",
  displayName: "guru",
  source: "native",
  status: "needs-sign-in",
  observedAt: "2026-11-24T00:00:00.000Z",
  providerThreadId: ProviderThreadId.make("pt-1"),
  sessionActive: true,
  ...overrides,
});

const notice = (nativeId: string | null) => ({
  mcpSignIn: { server: "guru" },
  nativeItemRef: nativeId === null ? null : { nativeId },
});

describe("thread MCP status", () => {
  it("draws attention to broken servers, not to ones that only need a sign-in", () => {
    expect(isProminentThreadMcpIssue(server())).toBe(false);
    expect(isProminentThreadMcpIssue(server({ status: "unreachable" }))).toBe(true);
    expect(isProminentThreadMcpIssue(server({ source: "managed" }))).toBe(true);
    expect(
      isProminentThreadMcpIssue(server({ source: "native-plugin", status: "unreachable" })),
    ).toBe(false);
  });

  it("keeps a sign-in the agent asked for and hides old startup notices", () => {
    const requested = notice("mcp-sign-in-request:turn-1:guru");
    expect(isMcpSignInRequestNotice(requested)).toBe(true);
    expect(isLegacyMcpStartupNotice(requested)).toBe(false);
    for (const old of [notice("mcp-sign-in:turn-1:guru"), notice(null)]) {
      expect(isMcpSignInRequestNotice(old)).toBe(false);
      expect(isLegacyMcpStartupNotice(old)).toBe(true);
    }
    expect(
      isLegacyMcpStartupNotice({ nativeItemRef: { nativeId: "mcp-startup-failed:t:x" } }),
    ).toBe(true);
  });

  it("offers a requested sign-in only while its live session still needs it", () => {
    const request = { server: "guru", providerThreadId: "pt-1" };
    expect(requestedMcpSignInIsOpen({ servers: [server()] }, request)).toBe(true);
    for (const done of [
      server({ status: "ready" }),
      server({ status: "checking" }),
      server({ sessionActive: false }),
      server({ providerThreadId: ProviderThreadId.make("pt-2") }),
      server({ source: "managed" }),
    ]) {
      expect(requestedMcpSignInIsOpen({ servers: [done] }, request)).toBe(false);
    }
    expect(requestedMcpSignInIsOpen(undefined, request)).toBe(false);
  });
});
