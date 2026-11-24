import {
  ConnectorId,
  EnvironmentId,
  IsoDateTime,
  NonNegativeInt,
  type ExtensionDeliveryReceipt,
  ProviderInstanceId,
  ProviderThreadId,
  ThreadId,
  type ThreadMcpStatusSnapshot,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { render } from "../../../test/render";

const state = vi.hoisted(() => ({
  receipt: undefined as ExtensionDeliveryReceipt | undefined,
  mcpStatus: null as ThreadMcpStatusSnapshot | null,
  receiptAtom: vi.fn((target: unknown) => target),
  mcpStatusAtom: vi.fn((target: unknown) => target),
}));

vi.mock("../../state/query", () => ({
  useEnvironmentQuery: () => ({ data: { receipt: state.receipt }, error: null }),
  useEnvironmentSubscription: () => ({ data: state.mcpStatus, error: null }),
  formatEnvironmentQueryError: () => "Error",
}));
vi.mock("../../state/environments", () => ({
  useEnvironmentHttpBaseUrl: () => "http://127.0.0.1:3773",
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: () => vi.fn(async () => ({ _tag: "Success", value: {} })),
}));
vi.mock("../../components/chat/McpSignInAction", () => ({
  McpSignInAction: ({ server }: { readonly server: string }) => (
    <button type="button" data-native-sign-in={server}>
      Sign in
    </button>
  ),
}));
vi.mock("./extensionsState", () => ({
  extensionsDeliveryReceipt: state.receiptAtom,
  threadMcpStatus: state.mcpStatusAtom,
  extensionsInventory: vi.fn((target: unknown) => target),
  startConnectorSignIn: { permissionAtom: () => Atom.make(true) },
  testConnector: { permissionAtom: () => Atom.make(true) },
}));

import { ExtensionsReceiptIndicator } from "./ExtensionsReceiptIndicator";
import { RequestedMcpSignInAction } from "./RequestedMcpSignIn";

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

function setup() {
  state.receipt = undefined;
  state.mcpStatus = null;
  state.receiptAtom.mockClear();
  state.mcpStatusAtom.mockClear();
}

describe("ExtensionsReceiptIndicator", () => {
  it("renders nothing until the thread has a receipt", async () => {
    setup();
    await using screen = await render(
      <ExtensionsReceiptIndicator environmentId={environmentId} threadId={threadId} />,
    );
    const { container } = screen;
    expect(container.innerHTML).toBe("");
    expect(state.receiptAtom).toHaveBeenCalledWith({ environmentId, input: { threadId } });

    state.receipt = receipt({ delivered: [], skipped: [] });
    await screen.rerender(
      <ExtensionsReceiptIndicator environmentId={environmentId} threadId={threadId} />,
    );
    expect(container.innerHTML).toBe("");
  });

  it("summarizes delivery and lists every skip with its reason", async () => {
    setup();
    state.receipt = receipt();
    await using screen = await render(
      <ExtensionsReceiptIndicator environmentId={environmentId} threadId={threadId} />,
    );
    const { container } = screen;
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
    const manage = document.querySelector<HTMLAnchorElement>(
      'a[href="/settings/extensions/installed?machine=local"]',
    );
    expect(manage?.textContent).toBe("Manage connected services");
    expect(new URL(manage!.href).searchParams.get("machine")).toBe("local");
    await userEvent.click(manage!);
    await vi.waitFor(() =>
      expect(screen.router?.state.location.href).toBe(
        "/settings/extensions/installed?machine=local",
      ),
    );
  });

  it("omits the skipped list when everything was delivered", async () => {
    setup();
    state.receipt = receipt({ skipped: [] });
    await using screen = await render(
      <ExtensionsReceiptIndicator environmentId={environmentId} threadId={threadId} />,
    );
    const { container } = screen;
    const trigger = container.querySelector<HTMLButtonElement>("[data-extensions-receipt]")!;
    expect(trigger.textContent).toBe("1");
    await userEvent.click(trigger);
    expect(document.querySelector('[aria-label="Delivered"]')).not.toBeNull();
    expect(document.querySelector('[aria-label="Skipped"]')).toBeNull();
  });

  it("counts a broken native server, and keeps servers that only need a sign-in in the quiet list", async () => {
    setup();
    state.mcpStatus = {
      threadId,
      revision: NonNegativeInt.make(1),
      providerInstanceId: ProviderInstanceId.make("codex"),
      providerThreadId: ProviderThreadId.make("pt-1"),
      sessionActive: true,
      servers: [
        {
          id: "native:zotero",
          name: "zotero",
          displayName: "zotero",
          source: "native",
          status: "unreachable",
          observedAt: IsoDateTime.make("2026-11-23T00:00:00.000Z"),
          detail: "It did not start.",
          sessionActive: true,
        },
        {
          id: "native:linear",
          name: "linear",
          displayName: "linear",
          source: "native",
          status: "needs-sign-in",
          observedAt: IsoDateTime.make("2026-11-23T00:00:00.000Z"),
          action: "sign-in",
          providerThreadId: ProviderThreadId.make("pt-1"),
          sessionActive: true,
        },
        {
          id: "native-plugin:plugin:design:figma",
          name: "plugin:design:figma",
          displayName: "plugin:design:figma",
          source: "native-plugin",
          status: "needs-sign-in",
          observedAt: IsoDateTime.make("2026-11-23T00:00:00.000Z"),
          action: "sign-in",
          providerThreadId: ProviderThreadId.make("pt-1"),
          sessionActive: true,
        },
      ],
    };
    await using screen = await render(
      <ExtensionsReceiptIndicator environmentId={environmentId} threadId={threadId} />,
    );
    const trigger = screen.container.querySelector<HTMLButtonElement>("[data-extensions-receipt]")!;
    expect(trigger.getAttribute("aria-label")).toBe(
      "Connected services: 0 ready, 1 need attention",
    );
    await userEvent.click(trigger);
    const attention = document.querySelector('[aria-label="Needs attention"]')?.textContent;
    expect(attention).toContain("zotero");
    expect(attention).not.toContain("linear");
    expect(document.querySelector('[aria-label="Agent MCP servers"]')).toBeNull();
    // Servers that only need a sign-in are counted once, not listed one by one.
    const ambient = document.querySelector<HTMLElement>("[data-ambient-mcp-issues]");
    expect(ambient?.textContent).toContain("2");
    // Opening the list names each server and offers its sign-in.
    await userEvent.click(ambient!.querySelector("button")!);
    expect(document.querySelector('[data-native-sign-in="linear"]')).not.toBeNull();
    expect(document.querySelector('[data-native-sign-in="plugin:design:figma"]')).not.toBeNull();
  });
});

describe("RequestedMcpSignInAction", () => {
  const snapshot = (
    server: Partial<ThreadMcpStatusSnapshot["servers"][number]> = {},
  ): ThreadMcpStatusSnapshot => ({
    threadId,
    revision: NonNegativeInt.make(1),
    providerInstanceId: ProviderInstanceId.make("claudeAgent"),
    providerThreadId: ProviderThreadId.make("pt-1"),
    sessionActive: true,
    servers: [
      {
        id: "native:guru",
        name: "guru",
        displayName: "guru",
        source: "native",
        status: "needs-sign-in",
        observedAt: IsoDateTime.make("2026-11-24T00:00:00.000Z"),
        providerThreadId: ProviderThreadId.make("pt-1"),
        sessionActive: true,
        ...server,
      },
    ],
  });
  const action = () => (
    <RequestedMcpSignInAction
      environmentId={environmentId}
      threadId={threadId}
      providerThreadId={ProviderThreadId.make("pt-1")}
      server="guru"
      noticeAt={0}
    />
  );

  it("offers the sign-in only while the chat's live session still needs it", async () => {
    setup();
    state.mcpStatus = snapshot();
    await using screen = await render(action());
    expect(screen.container.querySelector('[data-native-sign-in="guru"]')).not.toBeNull();
    expect(state.mcpStatusAtom).toHaveBeenCalledWith({ environmentId, input: { threadId } });

    // Signed in anywhere, on this device or another, the request row keeps no button.
    state.mcpStatus = snapshot({ status: "ready" });
    await screen.rerender(action());
    expect(screen.container.querySelector("[data-native-sign-in]")).toBeNull();

    // A later session owns the server now: this older request no longer targets it.
    state.mcpStatus = snapshot({ providerThreadId: ProviderThreadId.make("pt-2") });
    await screen.rerender(action());
    expect(screen.container.querySelector("[data-native-sign-in]")).toBeNull();
  });
});
