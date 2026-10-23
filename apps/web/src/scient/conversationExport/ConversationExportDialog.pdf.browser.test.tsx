import { render as _fixtureRender, type Screen, act } from "../../../test/render";

import {
  EnvironmentId,
  ThreadId,
  type ScientConversationExportPreparation,
} from "@t3tools/contracts";

import { describe, expect, it, vi } from "vite-plus/test";

const { exportConversationPdf, navigate, toastAdd } = vi.hoisted(() => ({
  exportConversationPdf: vi.fn(),
  navigate: vi.fn(async () => undefined),
  toastAdd: vi.fn(),
}));
const prepareConversationExport = vi.fn();
vi.mock("./client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./client")>()),
  prepareConversationExport,
  exportConversation: vi.fn(),
  prepareConversationWordDiagrams: vi.fn(),
}));
vi.mock("../documentExport/conversationPdfExport", () => ({
  conversationPdfAvailability: () => ({ available: true }),
  exportConversationPdf,
}));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => navigate,
}));
vi.mock("../../components/ui/toast", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../components/ui/toast")>();
  return { ...actual, toastManager: { ...actual.toastManager, add: toastAdd } };
});

const { ConversationExportDialogHost, requestConversationExport } =
  await import("./ConversationExportDialog");

const threadRef = {
  environmentId: EnvironmentId.make("local"),
  threadId: ThreadId.make("thread-sidebar"),
};
const preparation: ScientConversationExportPreparation = {
  threadId: threadRef.threadId,
  title: "Study",
  formats: [
    { format: "markdown", available: true, unavailableReason: null },
    { format: "pdf", available: true, unavailableReason: null },
  ],
  messageCount: 0,
  attachmentCount: 0,
  workLogEntryCount: 0,
  reasoningCount: 0,
  runningTurnOmitted: false,
  messages: [],
};

async function _setupFixture0(_fixture: _Fixture) {
  prepareConversationExport.mockReset().mockResolvedValue(preparation);
  exportConversationPdf.mockReset();
  navigate.mockClear();
  toastAdd.mockClear();
  _fixture.container = document.createElement("div");
  document.body.append(_fixture.container);
  _fixture.root0 = _fixture.stack.use(
    await _fixtureRender(null, { container: _fixture.container, router: false }),
  );
}

async function _cleanupFixture1(_fixture: _Fixture) {
  await act(async () => await _fixture.root0.unmount());
  _fixture.container.remove();
  vi.unstubAllGlobals();
}

const button = (label: string) =>
  [...document.querySelectorAll("button")].find((element) => element.textContent === label)!;

async function exportAsPdf(_fixture: _Fixture) {
  await act(async () => await _fixture.root0.rerender(<ConversationExportDialogHost />));
  await act(async () => requestConversationExport(threadRef, "pdf"));
  await act(async () => {
    await Promise.resolve();
  });
  await act(async () => button("Save PDF").click());
}

describe("ConversationExportDialog PDF delivery", () => {
  it("saves the PDF, then Open shows it in the exported conversation", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const open = vi.fn();
    exportConversationPdf.mockResolvedValue({
      title: "Export saved",
      description: "/Users/someone/Study.pdf",
      warnings: [],
      open,
    });
    await exportAsPdf(_fixture);

    expect(exportConversationPdf).toHaveBeenCalledWith(
      expect.objectContaining({ threadRef, request: expect.objectContaining({ format: "pdf" }) }),
    );
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(toastAdd).toHaveBeenCalledOnce();
    const toast = toastAdd.mock.calls[0]![0];
    expect(toast).toMatchObject({
      type: "success",
      title: "Export saved",
      description: "/Users/someone/Study.pdf",
      actionProps: { children: "Open" },
    });
    expect(open).not.toHaveBeenCalled();
    toast.actionProps.onClick();
    expect(open).toHaveBeenCalledOnce();
    // A sidebar export's conversation may not be on screen; Open goes there.
    expect(navigate).toHaveBeenCalledWith({
      to: "/$environmentId/$threadId",
      params: { environmentId: threadRef.environmentId, threadId: threadRef.threadId },
    });
  });

  it("stays open without a notice when saving is cancelled", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    exportConversationPdf.mockResolvedValue(null);
    await exportAsPdf(_fixture);
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(toastAdd).not.toHaveBeenCalled();
    expect(button("Save PDF").disabled).toBe(false);
  });

  it("shows why the PDF could not be exported and stays open", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    exportConversationPdf.mockRejectedValue(new Error("The file could not be written."));
    await exportAsPdf(_fixture);
    expect(
      [...document.querySelectorAll('[role="alert"]')].map((alert) => alert.textContent),
    ).toContain("The file could not be written.");
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(toastAdd).not.toHaveBeenCalled();
  });
});

function _createFixture() {
  const stack = new AsyncDisposableStack();
  const cleanup = new AsyncDisposableStack();
  return {
    container: undefined! as HTMLDivElement,
    stack,
    cleanup,
    root0: undefined! as Screen,
    async [Symbol.asyncDispose]() {
      try {
        await cleanup.disposeAsync();
      } finally {
        await stack.disposeAsync();
      }
    },
  };
}
type _Fixture = ReturnType<typeof _createFixture>;
