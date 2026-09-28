// @vitest-environment jsdom

import {
  ConversationImportId,
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  SCIC_MEDIA_TYPE,
  ScientConversationImportError,
  ThreadId,
  type ScientConversationImportPreview,
  type ServerConfig,
  type ServerProvider,
} from "@t3tools/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const createConversationImportUpload = vi.fn();
const uploadConversationFile = vi.fn();
const previewConversationImport = vi.fn();
const confirmConversationImport = vi.fn();
const cancelConversationImport = vi.fn();
vi.mock("./client", () => ({
  createConversationImportUpload,
  uploadConversationFile,
  previewConversationImport,
  confirmConversationImport,
  cancelConversationImport,
}));
const toastAdd = vi.fn();
vi.mock("../../components/ui/toast", () => ({ toastManager: { add: toastAdd } }));
const navigate = vi.fn();
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => navigate }));

const local = EnvironmentId.make("4b1b7c1e-8d1f-4a5e-9b0e-0c9f5f1d2a3b");
const remote = EnvironmentId.make("9f0e1d2c-3b4a-4596-8778-695a4b3c2d1e");
const state = vi.hoisted(() => ({
  environmentIds: [] as EnvironmentId[],
  runtimeMode: "approval-required" as string,
}));

function provider(): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make("codex"),
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-09-28T00:00:00.000Z",
    models: [
      { slug: "gpt-5", name: "GPT-5", isCustom: false, isDefault: true, capabilities: null },
      { slug: "gpt-5-mini", name: "GPT-5 mini", isCustom: false, capabilities: null },
    ],
    slashCommands: [],
    skills: [],
  };
}

function config(): ServerConfig {
  return {
    providers: [provider()],
    settings: { ...DEFAULT_SERVER_SETTINGS, defaultRuntimeMode: state.runtimeMode },
  } as unknown as ServerConfig;
}

vi.mock("../../state/entities", () => ({
  useProjects: () => [
    {
      id: ProjectId.make("project-1"),
      environmentId: local,
      title: "Field study",
      defaultModelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-mini" },
    },
  ],
  useServerConfigs: () => new Map(state.environmentIds.map((id) => [id, config()])),
}));
vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({
    environments: [
      { environmentId: local, label: "Local" },
      { environmentId: remote, label: "Lab workstation" },
    ],
  }),
  usePrimaryEnvironmentId: () => local,
}));

const { ConversationImportDialogHost } = await import("./ConversationImportDialog");
const { dropConversationImportFile, requestConversationImport, useConversationImportRequests } =
  await import("./requests");

const importId = ConversationImportId.make("cimp_00000000-0000-4000-8000-000000000001");
const secondImportId = ConversationImportId.make("cimp_00000000-0000-4000-8000-000000000002");

function previewOf(
  overrides: Partial<ScientConversationImportPreview> = {},
): ScientConversationImportPreview {
  return {
    importId,
    kind: "scic",
    fileName: "field-notes.scic",
    package: { packageSha256: `sha256:${"a".repeat(64)}` },
    conversation: {
      title: "Field notes",
      createdAt: "2026-09-27T10:00:00.000Z",
      updatedAt: "2026-09-27T10:00:00.000Z",
      provider: "codex",
      model: "gpt-5",
    },
    counts: {
      messages: 1,
      attachments: 2,
      reasoning: 0,
      workLogEntries: 0,
      proposedPlans: 0,
      questionAnswers: 0,
    },
    omissions: [],
    warnings: [],
    markdownIssues: [],
    expiresAt: 0,
    ...overrides,
  } as unknown as ScientConversationImportPreview;
}

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.environmentIds = [local];
  state.runtimeMode = "approval-required";
  useConversationImportRequests.setState({ nextId: 0, queue: [], replaceable: true });
  for (const mock of [
    createConversationImportUpload,
    uploadConversationFile,
    previewConversationImport,
    confirmConversationImport,
    cancelConversationImport,
    toastAdd,
    navigate,
  ]) {
    mock.mockReset();
  }
  let uploads = 0;
  createConversationImportUpload.mockImplementation(async () => ({
    importId: uploads++ === 0 ? importId : secondImportId,
    url: "http://127.0.0.1/api/scient/conversation-import/v1/upload/token",
    relativeUrl: "/api/scient/conversation-import/v1/upload/token",
    expiresAt: 0,
  }));
  uploadConversationFile.mockResolvedValue(undefined);
  previewConversationImport.mockResolvedValue(previewOf());
  cancelConversationImport.mockResolvedValue({ _tag: "cancelled" });
  confirmConversationImport.mockResolvedValue({ threadId: ThreadId.make("thread-9") });
  navigate.mockResolvedValue(undefined);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  delete (window as { desktopBridge?: unknown }).desktopBridge;
  vi.unstubAllGlobals();
});

async function flush() {
  for (let index = 0; index < 5; index += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

async function openWith(file: File, suspended = false) {
  await act(async () => root.render(<ConversationImportDialogHost suspended={suspended} />));
  await act(async () => requestConversationImport({ _tag: "browser-file", file }));
  await flush();
}

const scic = () => new File(["archive"], "field-notes.scic");
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
const button = (label: string) =>
  [...document.querySelectorAll("button")].find((candidate) => candidate.textContent === label);
const alerts = () =>
  [...document.querySelectorAll('[role="alert"]')].map((element) => element.textContent);

async function pressKey(target: HTMLElement, key: string) {
  await act(async () => {
    target.focus();
    target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
    target.dispatchEvent(new KeyboardEvent("keyup", { key, bubbles: true, cancelable: true }));
  });
}

describe("ConversationImportDialog", () => {
  it("checks a file as soon as it arrives and imports it with the project's model", async () => {
    await openWith(scic());

    expect(button("Preview")).toBeUndefined();
    expect(createConversationImportUpload).toHaveBeenCalledWith(
      local,
      "field-notes.scic",
      7,
      undefined,
    );
    expect(uploadConversationFile).toHaveBeenCalledOnce();
    expect(previewConversationImport).toHaveBeenCalledWith(local, importId);
    expect(dialog()?.textContent).toContain("Check what's in this file.");
    expect(dialog()?.textContent).toContain("1 message · 2 attachments · from Codex · GPT-5");
    expect(document.activeElement?.getAttribute("aria-label")).toBe("What's in this file");
    // One environment: nothing to choose, and no ID anywhere.
    expect(dialog()?.textContent).not.toContain("Destination");
    expect(dialog()?.textContent).not.toContain(local);
    expect(dialog()?.textContent).toContain("GPT-5 mini");
    expect(dialog()?.textContent).not.toContain("Supervised mode");

    await act(async () => button("Import")!.click());
    await flush();
    expect(confirmConversationImport).toHaveBeenCalledWith(local, {
      importId,
      packageSha256: `sha256:${"a".repeat(64)}`,
      destination: {
        projectId: "project-1",
        modelSelection: { instanceId: "codex", model: "gpt-5-mini" },
        runtimeMode: "approval-required",
        interactionMode: "default",
      },
    });
    expect(toastAdd).toHaveBeenCalledWith({
      type: "success",
      title: "Conversation imported",
      description: "Your next message continues it with GPT-5 mini.",
    });
    expect(navigate).toHaveBeenCalledOnce();
    expect(dialog()).toBeNull();
    expect(cancelConversationImport).not.toHaveBeenCalled();
  });

  it("names destination environments instead of showing their IDs", async () => {
    state.environmentIds = [local, remote];
    state.runtimeMode = "full-access";
    await openWith(scic());

    const trigger = dialog()?.querySelector('[data-slot="select-trigger"]');
    expect(dialog()?.textContent).toContain("Destination");
    expect(trigger?.textContent).toContain("This device");
    expect(dialog()?.textContent).not.toContain(local);
    expect(dialog()?.textContent).toContain(
      "Imported conversations start in Supervised mode, which asks before commands and file changes.",
    );
  });

  it("stops the upload and releases the staged import when cancelled", async () => {
    let signal: AbortSignal | undefined;
    uploadConversationFile.mockImplementation(
      (_url: string, _file: File, options: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          signal = options.signal;
          options.signal.addEventListener("abort", () =>
            reject(new DOMException("cancelled", "AbortError")),
          );
        }),
    );
    await openWith(scic());
    expect(document.querySelector('[role="status"]')?.textContent).toBe("Sending the file…");

    await act(async () => button("Cancel")!.click());
    await flush();
    expect(signal?.aborted).toBe(true);
    expect(cancelConversationImport).toHaveBeenCalledWith(local, importId);
    expect(dialog()).toBeNull();
    expect(alerts()).toEqual([]);
  });

  it("releases the staged import when Escape is pressed while checking", async () => {
    previewConversationImport.mockReturnValue(new Promise(() => {}));
    await openWith(scic());
    expect(document.querySelector('[role="status"]')?.textContent).toBe("Checking the file…");

    await pressKey(dialog()!, "Escape");
    await flush();
    expect(cancelConversationImport).toHaveBeenCalledWith(local, importId);
    expect(dialog()).toBeNull();
  });

  it("closes quietly when the desktop's send prompt is declined", async () => {
    const uploadOpenedConversationFile = vi
      .fn()
      .mockResolvedValue({ _tag: "failed", reason: "rejected" });
    Object.assign(window, { desktopBridge: { uploadOpenedConversationFile } });
    await act(async () => root.render(<ConversationImportDialogHost />));
    await act(async () =>
      requestConversationImport({
        _tag: "desktop-file",
        file: { token: "token-1", fileName: "field-notes.scic", sizeBytes: 7 },
      }),
    );
    await flush();

    expect(uploadOpenedConversationFile).toHaveBeenCalledOnce();
    expect(dialog()).toBeNull();
    expect(cancelConversationImport).toHaveBeenCalledWith(local, importId);
    expect(toastAdd).not.toHaveBeenCalled();
  });

  it("words other desktop failures plainly", async () => {
    Object.assign(window, {
      desktopBridge: {
        uploadOpenedConversationFile: vi
          .fn()
          .mockResolvedValue({ _tag: "failed", reason: "network-failed" }),
      },
    });
    await act(async () => root.render(<ConversationImportDialogHost />));
    await act(async () =>
      requestConversationImport({
        _tag: "desktop-file",
        file: { token: "token-1", fileName: "field-notes.scic", sizeBytes: 7 },
      }),
    );
    await flush();

    expect(alerts()).toEqual(["The file couldn't be sent. Check the connection and try again."]);
    expect(dialog()?.textContent).not.toContain("network-failed");
  });

  it("shows why a file was rejected without codes or entry paths, and can try again", async () => {
    previewConversationImport.mockRejectedValueOnce(
      new ScientConversationImportError({
        reason: "package-rejected",
        rejection: { reason: "corrupt-archive", entry: "attachments/../x" },
        message: "This file is damaged.",
      }),
    );
    await openWith(scic());
    expect(alerts()).toEqual(["This file is damaged."]);
    expect(dialog()?.textContent).not.toContain("corrupt-archive");
    expect(dialog()?.textContent).not.toContain("attachments/../x");
    expect(cancelConversationImport).toHaveBeenCalledWith(local, importId);

    await act(async () => button("Try again")!.click());
    await flush();
    expect(createConversationImportUpload).toHaveBeenCalledTimes(2);
    expect(alerts()).toEqual([]);
    expect(button("Import")?.disabled).toBe(false);
  });

  it("offers to start a conversation from a plain Markdown document", async () => {
    previewConversationImport.mockResolvedValue(
      previewOf({
        kind: "document",
        conversation: { ...previewOf().conversation, provider: null, model: null },
      }),
    );
    await openWith(new File(["# Notes"], "notes.md"));
    expect(dialog()?.querySelector("h2, [data-slot='dialog-title']")?.textContent).toBe(
      "Start a conversation from this document",
    );
    expect(button("Start conversation")?.disabled).toBe(false);
  });

  it("asks before importing only the readable messages, by keyboard", async () => {
    previewConversationImport.mockResolvedValueOnce(
      previewOf({
        kind: "markdown",
        markdownIssues: [
          {
            kind: "malformed-marker",
            startLine: 4,
            endLine: 4,
            detail: "The marker repeats an attribute.",
          },
        ],
      }),
    );
    await openWith(new File(["# Notes"], "notes.md"));
    expect(dialog()?.textContent).toContain("Some messages couldn't be read");
    expect(dialog()?.textContent).toContain("Line 4: The marker repeats an attribute.");
    expect(button("Import")?.disabled).toBe(true);

    await pressKey(document.querySelector<HTMLElement>('[role="checkbox"]')!, " ");
    expect(button("Import")?.disabled).toBe(false);

    await act(async () => button("Start with the whole file instead")!.click());
    await flush();
    expect(cancelConversationImport).toHaveBeenCalledWith(local, importId);
    expect(createConversationImportUpload).toHaveBeenLastCalledWith(
      local,
      "notes.md",
      7,
      "document",
    );
  });

  it("uses a file dropped on the open dialog instead of opening another", async () => {
    await openWith(scic());
    const second = new File(["another"], "second.scic");
    await act(async () => dropConversationImportFile(second));
    await flush();

    expect(useConversationImportRequests.getState().queue).toHaveLength(1);
    expect(cancelConversationImport).toHaveBeenCalledWith(local, importId);
    expect(createConversationImportUpload).toHaveBeenLastCalledWith(
      local,
      "second.scic",
      7,
      undefined,
    );
    expect(dialog()?.textContent).toContain("second.scic");
  });

  it("keeps connection details out of a failed import", async () => {
    confirmConversationImport.mockRejectedValueOnce(
      new Error("Remote environment endpoint http://127.0.0.1:4000/api timed out after 300000ms."),
    );
    await openWith(scic());
    await act(async () => button("Import")!.click());
    await flush();
    expect(alerts()).toEqual(["The conversation couldn't be imported. Try again."]);
    expect(dialog()).not.toBeNull();
    expect(button("Import")?.disabled).toBe(false);
  });

  it("shows where a dragged conversation file will go", async () => {
    await act(async () => root.render(<ConversationImportDialogHost />));
    const drag = (itemType: string) => {
      const event = new Event("dragenter", { bubbles: true, cancelable: true });
      Object.defineProperty(event, "dataTransfer", {
        value: { types: ["Files"], items: [{ kind: "file", type: itemType }], files: [] },
      });
      document.body.dispatchEvent(event);
    };
    const overlay = () => document.querySelector("[data-conversation-import-drop-overlay]");

    await act(async () => drag(SCIC_MEDIA_TYPE));
    expect(overlay()?.textContent).toBe("Drop to import conversation");
    await act(async () => window.dispatchEvent(new Event("dragend")));
    expect(overlay()).toBeNull();

    await act(async () => drag(""));
    expect(overlay()?.textContent).toBe("Drop to import conversationOther files attach as usual.");
    await act(async () => window.dispatchEvent(new Event("dragend")));
  });

  it("waits for first-run setup before opening", async () => {
    await openWith(scic(), true);
    expect(dialog()).toBeNull();
    expect(createConversationImportUpload).not.toHaveBeenCalled();
    expect(toastAdd).toHaveBeenCalledWith({
      type: "info",
      title: "Conversation file received",
      description: "It opens for import when setup is finished.",
    });

    await act(async () => root.render(<ConversationImportDialogHost />));
    await flush();
    expect(dialog()).not.toBeNull();
    expect(createConversationImportUpload).toHaveBeenCalledOnce();
  });
});
