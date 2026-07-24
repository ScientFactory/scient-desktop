// FILE: ConnectionRecoveryNotifications.browser.tsx
// Purpose: Browser integration coverage for connection recovery in the Activity Center store.
// Layer: Browser UI test

import "../index.css";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";

import {
  CONNECTION_DETAILS_DELAY_MS,
  CONNECTION_NOTICE_DELAY_MS,
} from "../connectionRecoveryNotice";
import { useActivityStore } from "../notifications/activityStore";
import { emitWsTransportState } from "../wsTransportEvents";
import { ConnectionRecoveryNotifications } from "./ConnectionRecoveryNotifications";

let activeHarnessCleanup: (() => Promise<void>) | null = null;

async function mountRecoveryHarness() {
  const host = document.createElement("div");
  document.body.append(host);
  const screen = await render(<ConnectionRecoveryNotifications />, { container: host });

  let cleanedUp = false;
  const cleanup = async () => {
    if (cleanedUp) return;
    cleanedUp = true;
    await screen.unmount();
    host.remove();
    if (activeHarnessCleanup === cleanup) activeHarnessCleanup = null;
  };
  activeHarnessCleanup = cleanup;
  return cleanup;
}

function connectionActivity() {
  return useActivityStore
    .getState()
    .items.find((item) => item.dedupeKey === "system:local-service-connection");
}

describe("connection recovery Activity integration", () => {
  beforeEach(() => {
    useActivityStore.getState().reset();
    emitWsTransportState("open");
  });

  afterEach(async () => {
    emitWsTransportState("open");
    await activeHarnessCleanup?.();
    useActivityStore.getState().reset();
    document.body.innerHTML = "";
  });

  it("stays silent for a brief reconnect", async () => {
    await mountRecoveryHarness();
    emitWsTransportState("reconnecting");
    await new Promise((resolve) => window.setTimeout(resolve, CONNECTION_NOTICE_DELAY_MS - 100));
    emitWsTransportState("open");

    expect(connectionActivity()).toBeUndefined();
  });

  it(
    "deduplicates sustained recovery progress and retains the recovered result",
    async () => {
      await mountRecoveryHarness();
      emitWsTransportState("reconnecting");

      await expect
        .poll(connectionActivity, { timeout: CONNECTION_NOTICE_DELAY_MS + 2_000 })
        .toMatchObject({ status: "in_progress", tone: "info", title: "Reconnecting to Scient" });

      await expect
        .poll(connectionActivity, { timeout: CONNECTION_DETAILS_DELAY_MS + 2_000 })
        .toMatchObject({
          status: "needs_attention",
          tone: "warning",
          destination: { type: "connection_diagnostics" },
        });
      expect(
        useActivityStore
          .getState()
          .items.filter((item) => item.dedupeKey === "system:local-service-connection"),
      ).toHaveLength(1);

      emitWsTransportState("open");
      await expect
        .poll(connectionActivity)
        .toMatchObject({ status: "recent", tone: "success", title: "Reconnected" });
    },
    CONNECTION_DETAILS_DELAY_MS + 5_000,
  );
});
