import {
  ConnectorId,
  EnvironmentId,
  type ExtensionDeliveryReceipt,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

const state = vi.hoisted(() => ({
  receipt: undefined as ExtensionDeliveryReceipt | undefined,
  receiptAtom: vi.fn((target: unknown) => target),
}));

vi.mock("../../state/query", () => ({
  useEnvironmentQuery: () => ({ data: { receipt: state.receipt }, error: null }),
}));
vi.mock("./extensionsState", () => ({ extensionsDeliveryReceipt: state.receiptAtom }));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, children, ...props }: { to: string; children: React.ReactNode }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}));

import { ExtensionsReceiptIndicator } from "./ExtensionsReceiptIndicator";

const environmentId = EnvironmentId.make("local");
const threadId = ThreadId.make("thread-1");

function entry(id: string, displayName: string, serverName: string) {
  return {
    kind: "connector" as const,
    connectorId: ConnectorId.make(`con_${id}`),
    displayName,
    serverName,
  };
}

function receipt(overrides: Partial<ExtensionDeliveryReceipt> = {}): ExtensionDeliveryReceipt {
  return {
    threadId,
    providerInstanceId: ProviderInstanceId.make("codex"),
    providerSessionId: "session-1",
    issuedAt: "2026-10-21T00:00:00.000Z",
    delivered: [entry("linear0001", "Linear", "linear")],
    skipped: [
      { entry: entry("notion0001", "Notion", "notion"), reason: "needs-auth" },
      { entry: entry("github0001", "GitHub", "github"), reason: "name-collision" },
      { entry: entry("hfhub00001", "Hugging Face", "hf"), reason: "transport-unsupported" },
      { entry: entry("sentry0001", "Sentry", "sentry"), reason: "project-deselected" },
    ],
    ...overrides,
  };
}

let root: Root;
let container: HTMLDivElement;

async function render() {
  await act(async () =>
    root.render(<ExtensionsReceiptIndicator environmentId={environmentId} threadId={threadId} />),
  );
}

describe("ExtensionsReceiptIndicator", () => {
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    state.receipt = undefined;
    state.receiptAtom.mockClear();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it("renders nothing until the thread has a receipt", async () => {
    await render();
    expect(container.innerHTML).toBe("");
    expect(state.receiptAtom).toHaveBeenCalledWith({ environmentId, input: { threadId } });

    state.receipt = receipt({ delivered: [], skipped: [] });
    await render();
    expect(container.innerHTML).toBe("");
  });

  it("summarizes delivery and lists every skip with its reason", async () => {
    state.receipt = receipt();
    await render();
    const trigger = container.querySelector<HTMLButtonElement>("[data-extensions-receipt]")!;
    expect(trigger.getAttribute("aria-label")).toBe("Connected services: 1 delivered, 4 skipped");
    expect(trigger.textContent).toBe("1· 4 skipped");

    await userEvent.click(trigger);
    const delivered = document.querySelector('[aria-label="Delivered"]')!;
    expect(delivered.textContent).toContain("Linear");
    expect(delivered.textContent).toContain("linear");
    const skipped = [...document.querySelectorAll<HTMLElement>("[data-skip-reason]")].map(
      (item) => [item.dataset.skipReason, item.textContent],
    );
    expect(skipped).toEqual([
      ["needs-auth", "NotionNeeds sign-in"],
      ["name-collision", "GitHubName taken by the agent's own server"],
      ["transport-unsupported", "Hugging FaceNot supported by this agent"],
      ["project-deselected", "SentryOff for this project"],
    ]);
    expect(document.querySelector('a[href="/settings/extensions"]')).not.toBeNull();
  });

  it("omits the skipped list when everything was delivered", async () => {
    state.receipt = receipt({ skipped: [] });
    await render();
    const trigger = container.querySelector<HTMLButtonElement>("[data-extensions-receipt]")!;
    expect(trigger.textContent).toBe("1");
    await userEvent.click(trigger);
    expect(document.querySelector('[aria-label="Delivered"]')).not.toBeNull();
    expect(document.querySelector('[aria-label="Skipped"]')).toBeNull();
  });
});
