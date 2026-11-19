import type { OrchestrationV2TurnItem } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { providerErrorPresentation } from "../../session-logic";
import { customEndpointFailureNote } from "./customEndpointFailureNote";

type ErrorItem = Extract<OrchestrationV2TurnItem, { readonly type: "error" }>;

const failure = (customEndpoint?: ErrorItem["failure"]["customEndpoint"]) => ({
  class: "provider_error" as const,
  message: "API Error: 404 model not found",
  code: "api_error_404",
  retryable: null,
  ...(customEndpoint ? { customEndpoint } : {}),
});

describe("customEndpointFailureNote", () => {
  it("says where the request went and where that was set", () => {
    expect(
      customEndpointFailureNote(
        failure({ origin: "http://127.0.0.1:3456", source: "claude-settings" }),
      ),
    ).toBe(
      "This request went to http://127.0.0.1:3456, not to Anthropic. It is set by ANTHROPIC_BASE_URL in Claude's settings.json.",
    );
    expect(
      customEndpointFailureNote(
        failure({ origin: "https://proxy.example", source: "environment" }),
      ),
    ).toBe(
      "This request went to https://proxy.example, not to Anthropic. It is set by the ANTHROPIC_BASE_URL environment variable, in this provider's settings or on this computer.",
    );
    expect(customEndpointFailureNote(failure())).toBeNull();
  });

  it("follows the provider's message in the work log", () => {
    const item = {
      type: "error",
      status: "failed",
      failure: failure({ origin: "https://proxy.example", source: "environment" }),
    } as unknown as ErrorItem;
    expect(providerErrorPresentation(item).detail).toBe(
      "API Error: 404 model not found\n\nThis request went to https://proxy.example, not to Anthropic. It is set by the ANTHROPIC_BASE_URL environment variable, in this provider's settings or on this computer.",
    );
    expect(
      providerErrorPresentation({ ...item, failure: failure() } as unknown as ErrorItem).detail,
    ).toBe("API Error: 404 model not found");
  });
});
