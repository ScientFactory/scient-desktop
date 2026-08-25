import { afterEach, describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";

import {
  clearAllMcpProviderSessions,
  readMcpProviderSession,
  setMcpProviderSession,
} from "./McpProviderSession.ts";

describe("McpProviderSession", () => {
  afterEach(clearAllMcpProviderSessions);

  it("keeps the stored capability manifest isolated from callers", () => {
    const threadId = ThreadId.make("thread-awareness");
    const inputCapabilities = new Set(["preview"] as const);
    setMcpProviderSession({
      environmentId: EnvironmentId.make("environment-awareness"),
      threadId,
      providerSessionId: "provider-session-awareness",
      providerInstanceId: ProviderInstanceId.make("codex"),
      endpoint: "http://127.0.0.1:43123/mcp",
      authorizationHeader: "Bearer test",
      capabilities: inputCapabilities,
    });

    inputCapabilities.clear();
    const firstRead = readMcpProviderSession(threadId);
    expect(firstRead).toBeDefined();
    if (!firstRead) throw new Error("Expected the provider session to be stored");
    expect(firstRead.capabilities).toEqual(new Set(["preview"]));

    (firstRead.capabilities as Set<string>).add("sources:write");
    expect(readMcpProviderSession(threadId)?.capabilities).toEqual(new Set(["preview"]));
  });
});
