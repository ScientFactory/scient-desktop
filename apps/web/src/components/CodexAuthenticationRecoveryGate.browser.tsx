import { EventId } from "@synara/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { useProviderConnectionDialogStore } from "~/providerConnectionDialogStore";
import { CodexAuthenticationRecoveryGate } from "./CodexAuthenticationRecoveryGate";

const authenticationEventId = EventId.makeUnsafe("activity-codex-authentication-error");

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
    const renderGate = () =>
      render(
        <CodexAuthenticationRecoveryGate
          provider="codex"
          sessionStatus="error"
          sessionLastErrorEventId={authenticationEventId}
          sessionLastErrorClass="authentication_error"
          providerStatus={standardCodexStatus}
        />,
      );
    const screen = await renderGate();

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

    useProviderConnectionDialogStore.getState().setOpen(false);
    const remountedScreen = await renderGate();
    try {
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(useProviderConnectionDialogStore.getState().isOpen).toBe(false);
    } finally {
      await remountedScreen.unmount();
    }
  });

  it("never reopens an already handled recovery event after many newer events", async () => {
    const retainedEventId = EventId.makeUnsafe("retained-authentication-error");
    const gate = (eventId: string) => (
      <CodexAuthenticationRecoveryGate
        provider="codex"
        sessionStatus="error"
        sessionLastErrorEventId={eventId}
        sessionLastErrorClass="authentication_error"
        providerStatus={standardCodexStatus}
      />
    );
    const screen = await render(gate(retainedEventId));

    try {
      await vi.waitFor(() => expect(useProviderConnectionDialogStore.getState().isOpen).toBe(true));
      for (let index = 0; index < 51; index += 1) {
        useProviderConnectionDialogStore.getState().setOpen(false);
        await screen.rerender(gate(`newer-authentication-error-${index}`));
        await vi.waitFor(() =>
          expect(useProviderConnectionDialogStore.getState().isOpen).toBe(true),
        );
      }

      useProviderConnectionDialogStore.getState().setOpen(false);
      await screen.rerender(gate(retainedEventId));
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(useProviderConnectionDialogStore.getState().isOpen).toBe(false);
    } finally {
      await screen.unmount();
    }
  });
});
