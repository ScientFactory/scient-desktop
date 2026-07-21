import { EventId, type OrchestrationThreadActivity } from "@synara/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { useProviderConnectionDialogStore } from "~/providerConnectionDialogStore";
import { CodexAuthenticationRecoveryGate } from "./CodexAuthenticationRecoveryGate";

const authenticationActivity = {
  id: EventId.makeUnsafe("activity-codex-authentication-error"),
  createdAt: "2026-07-21T10:00:00.000Z",
  tone: "error",
  kind: "runtime.error",
  summary: "Authentication required",
  payload: { message: "Authentication required", class: "authentication_error" },
  turnId: null,
} satisfies OrchestrationThreadActivity;

const standardCodexStatus = {
  provider: "codex",
  status: "ready",
  available: true,
  authStatus: "authenticated",
  requiresProviderAccount: true,
  checkedAt: "2026-07-21T10:00:00.000Z",
} as const;

describe("CodexAuthenticationRecoveryGate", () => {
  afterEach(() => {
    useProviderConnectionDialogStore.getState().setOpen(false);
  });

  it("opens the dedicated recovery flow for a projected Codex auth failure", async () => {
    const screen = await render(
      <CodexAuthenticationRecoveryGate
        provider="codex"
        sessionStatus="error"
        activities={[authenticationActivity]}
        providerStatus={standardCodexStatus}
      />,
    );

    try {
      await vi.waitFor(() => {
        expect(useProviderConnectionDialogStore.getState()).toMatchObject({
          isOpen: true,
          provider: "codex",
          source: "runtime_authentication_error",
        });
      });
    } finally {
      await screen.unmount();
    }
  });
});
