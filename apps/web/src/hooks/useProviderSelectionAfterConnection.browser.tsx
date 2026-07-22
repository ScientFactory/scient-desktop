import { type ModelSlug, type ProviderKind, type ServerProviderStatus } from "@synara/contracts";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";
import { useCallback, useMemo, useState } from "react";

import { ProviderModelPicker } from "../components/chat/ProviderModelPicker";
import type { ProviderModelOption } from "../providerModelOptions";
import { useProviderConnectionDialogStore } from "../providerConnectionDialogStore";
import { findProviderStatus } from "../lib/providerAvailability";
import {
  useApplyProviderSelectionAfterConnection,
  useProviderConnectionSelectionIntent,
} from "./useProviderSelectionAfterConnection";

const MODEL_OPTIONS: Record<ProviderKind, ReadonlyArray<ProviderModelOption>> = {
  codex: [{ slug: "gpt-5.5", name: "GPT-5.5" }],
  claudeAgent: [
    { slug: "claude-sonnet-5", name: "Claude Sonnet 5" },
    { slug: "claude-opus-5", name: "Claude Opus 5" },
  ],
  cursor: [{ slug: "auto", name: "Auto" }],
  antigravity: [{ slug: "Gemini 3.5 Flash", name: "Gemini 3.5 Flash" }],
  grok: [{ slug: "grok-build", name: "Grok" }],
  droid: [{ slug: "claude-opus-4-8", name: "Claude Opus 4.8" }],
  kilo: [{ slug: "kilo/kilo-auto/free", name: "Kilo Auto" }],
  opencode: [{ slug: "openai/gpt-5", name: "GPT-5" }],
  pi: [{ slug: "anthropic/claude-opus", name: "Claude Opus" }],
};

const CODEX_READY: ServerProviderStatus = {
  provider: "codex",
  status: "ready",
  available: true,
  authStatus: "authenticated",
  checkedAt: "2026-07-23T10:00:00.000Z",
};

const CLAUDE_UNAVAILABLE: ServerProviderStatus = {
  provider: "claudeAgent",
  status: "error",
  available: false,
  authStatus: "unauthenticated",
  checkedAt: "2026-07-23T10:00:00.000Z",
};

function SelectionHarness() {
  const [provider, setProvider] = useState<ProviderKind>("codex");
  const [model, setModel] = useState<ModelSlug>("gpt-5.5");
  const [lockedProvider, setLockedProvider] = useState<ProviderKind | null>(null);
  const [statuses, setStatuses] = useState<ServerProviderStatus[]>([
    CODEX_READY,
    CLAUDE_UNAVAILABLE,
  ]);
  const controller = useProviderConnectionSelectionIntent("thread-1");
  const preferredModelByProvider = useMemo(() => ({ claudeAgent: "claude-opus-5" }), []);
  const handleProviderModelChange = useCallback(
    (nextProvider: ProviderKind, nextModel: ModelSlug) => {
      setProvider(nextProvider);
      setModel(nextModel);
    },
    [],
  );
  const handleProviderConnectionRequested = useCallback(
    (requestedProvider: ProviderKind) => {
      controller.request(requestedProvider, findProviderStatus(statuses, requestedProvider));
    },
    [controller, statuses],
  );
  useApplyProviderSelectionAfterConnection({
    controller,
    scopeKey: "thread-1",
    lockedProvider,
    statuses,
    modelOptionsByProvider: MODEL_OPTIONS,
    preferredModelByProvider,
    onProviderModelChange: handleProviderModelChange,
  });

  const setClaudeConnection = (
    connectionStatus: "waiting_for_browser" | "connected" | "failed",
  ) => {
    setStatuses([
      CODEX_READY,
      {
        provider: "claudeAgent",
        status: connectionStatus === "connected" ? "ready" : "error",
        available: connectionStatus !== "failed",
        authStatus: connectionStatus === "connected" ? "authenticated" : "unauthenticated",
        checkedAt: "2026-07-23T10:00:02.000Z",
        connectionState: {
          operationId: "connect-claude-1",
          method: "claude_account",
          status: connectionStatus,
          startedAt: "2099-07-23T10:00:01.000Z",
          finishedAt:
            connectionStatus === "waiting_for_browser" ? null : "2099-07-23T10:00:02.000Z",
          message:
            connectionStatus === "connected"
              ? "Connected."
              : connectionStatus === "failed"
                ? "Sign in failed."
                : "Finish signing in.",
        },
      },
    ]);
  };

  return (
    <>
      <output aria-label="Selected provider and model">{`${provider}:${model}`}</output>
      <ProviderModelPicker
        provider={provider}
        model={model}
        lockedProvider={lockedProvider}
        providers={statuses}
        modelOptionsByProvider={MODEL_OPTIONS}
        onProviderModelChange={handleProviderModelChange}
        onProviderConnectionRequested={handleProviderConnectionRequested}
      />
      <button type="button" onClick={() => setClaudeConnection("waiting_for_browser")}>
        Start connection
      </button>
      <button type="button" onClick={() => setClaudeConnection("connected")}>
        Complete connection
      </button>
      <button type="button" onClick={() => setClaudeConnection("failed")}>
        Fail connection
      </button>
      <button type="button" onClick={() => setLockedProvider("codex")}>
        Start Codex thread
      </button>
    </>
  );
}

describe("provider selection after connection browser journey", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    useProviderConnectionDialogStore.getState().setOpen(false);
  });

  it("selects the requested provider and its prior model after background verification", async () => {
    const screen = await render(<SelectionHarness />);
    try {
      await page.getByRole("button", { name: "GPT-5.5" }).click();
      await page.getByRole("menuitem", { name: /Claude.*Set up/u }).click();
      await page.getByRole("button", { name: "Start connection" }).click();
      useProviderConnectionDialogStore.getState().setOpen(false);
      await page.getByRole("button", { name: "Complete connection" }).click();

      await expect
        .element(page.getByLabelText("Selected provider and model"))
        .toHaveTextContent("claudeAgent:claude-opus-5");
    } finally {
      await screen.unmount();
    }
  });

  it("clears the pending selection when the connection fails", async () => {
    const screen = await render(<SelectionHarness />);
    try {
      await page.getByRole("button", { name: "GPT-5.5" }).click();
      await page.getByRole("menuitem", { name: /Claude.*Set up/u }).click();
      await page.getByRole("button", { name: "Start connection" }).click();
      await page.getByRole("button", { name: "Fail connection" }).click();
      await page.getByRole("button", { name: "Complete connection" }).click();
      await expect
        .element(page.getByLabelText("Selected provider and model"))
        .toHaveTextContent("codex:gpt-5.5");
    } finally {
      await screen.unmount();
    }
  });

  it("clears the selection intent when setup is dismissed before an operation starts", async () => {
    const screen = await render(<SelectionHarness />);
    try {
      await page.getByRole("button", { name: "GPT-5.5" }).click();
      await page.getByRole("menuitem", { name: /Claude.*Set up/u }).click();
      useProviderConnectionDialogStore.getState().setOpen(false);
      await page.getByRole("button", { name: "Complete connection" }).click();

      await expect
        .element(page.getByLabelText("Selected provider and model"))
        .toHaveTextContent("codex:gpt-5.5");
    } finally {
      await screen.unmount();
    }
  });

  it("does not override a composer that becomes provider-locked during connection", async () => {
    const screen = await render(<SelectionHarness />);
    try {
      await page.getByRole("button", { name: "GPT-5.5" }).click();
      await page.getByRole("menuitem", { name: /Claude.*Set up/u }).click();
      await page.getByRole("button", { name: "Start connection" }).click();
      await page.getByRole("button", { name: "Start Codex thread" }).click();
      await page.getByRole("button", { name: "Complete connection" }).click();
      await expect
        .element(page.getByLabelText("Selected provider and model"))
        .toHaveTextContent("codex:gpt-5.5");
    } finally {
      await screen.unmount();
    }
  });
});
