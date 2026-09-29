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
  type ScientConversationImportConfirmRequest,
  type ScientConversationImportPreview,
  type ServerConfig,
  type ServerProvider,
} from "@t3tools/contracts";
import { act, useMemo, useSyncExternalStore } from "react";
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
  offline: [] as EnvironmentId[],
  projectModel: "codex/gpt-5-mini",
  providers: "ready" as "ready" | "none" | "codex-and-claude",
  currentProject: null as { environmentId: string; projectId: string } | null,
  /** The model of the conversation in view, if any. */
  viewedModel: null as { instanceId: string; model: string } | null,
}));
const connected = vi.hoisted(() => ({ listeners: new Set<() => void>() }));
function setConnectedEnvironments(ids: EnvironmentId[]) {
  state.environmentIds = ids;
  for (const listener of connected.listeners) listener();
}
function setOffline(ids: EnvironmentId[]) {
  state.offline = ids;
  for (const listener of connected.listeners) listener();
}

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

function claudeProvider(): ServerProvider {
  return {
    ...provider(),
    instanceId: ProviderInstanceId.make("claudeAgent"),
    driver: ProviderDriverKind.make("claudeAgent"),
    models: [
      {
        slug: "claude-opus",
        name: "Claude Opus",
        isCustom: false,
        isDefault: true,
        capabilities: null,
      },
    ],
  };
}

function config(): ServerConfig {
  return {
    providers:
      state.providers === "none"
        ? []
        : state.providers === "codex-and-claude"
          ? [provider(), claudeProvider()]
          : [provider()],
    settings: DEFAULT_SERVER_SETTINGS,
  } as unknown as ServerConfig;
}

vi.mock("../../hooks/useHandleNewThread", () => ({
  useHandleNewThread: () => ({
    activeDraftThread: null,
    activeThread:
      state.currentProject === null
        ? undefined
        : {
            environmentId: state.currentProject.environmentId,
            projectId: state.currentProject.projectId,
          },
    handleNewThread: async () => null,
    routeDraftId: null,
    routeThreadRef:
      state.viewedModel === null ? null : { environmentId: local, threadId: "viewed-thread" },
  }),
}));

vi.mock("../../state/entities", () => ({
  useProjects: () => [
    {
      id: ProjectId.make("project-1"),
      environmentId: local,
      title: "Field study",
      defaultModelSelection: {
        instanceId: ProviderInstanceId.make(state.projectModel.split("/")[0]!),
        model: state.projectModel.split("/")[1]!,
      },
    },
    {
      id: ProjectId.make("project-2"),
      environmentId: local,
      title: "Lab notes",
      defaultModelSelection: null,
    },
    {
      id: ProjectId.make("project-3"),
      environmentId: remote,
      title: "Survey",
      defaultModelSelection: null,
    },
  ],
  useThreadShells: () => [],
  readThreadShell: () =>
    state.viewedModel === null
      ? null
      : {
          modelSelection: {
            instanceId: ProviderInstanceId.make(state.viewedModel.instanceId),
            model: state.viewedModel.model,
          },
        },
  // Connected environments are a subscription, as the real atom is.
  useServerConfigs: () => {
    const ids = useSyncExternalStore(
      (listener) => {
        connected.listeners.add(listener);
        return () => connected.listeners.delete(listener);
      },
      () => state.environmentIds,
    );
    return useMemo(() => new Map(ids.map((id) => [id, config()])), [ids]);
  },
}));
vi.mock("../../state/environments", () => ({
  // Connection state is a subscription too; a dropped environment keeps its config.
  useEnvironments: () => {
    const offline = useSyncExternalStore(
      (listener) => {
        connected.listeners.add(listener);
        return () => connected.listeners.delete(listener);
      },
      () => state.offline,
    );
    const environments = useMemo(
      () =>
        [
          { environmentId: local, label: "Local" },
          { environmentId: remote, label: "Lab workstation" },
        ].map((environment) => ({
          ...environment,
          connection: {
            phase: offline.includes(environment.environmentId) ? "reconnecting" : "connected",
          },
        })),
      [offline],
    );
    return { environments };
  },
  usePrimaryEnvironmentId: () => local,
}));

const { ConversationImportDialogHost } = await import("./ConversationImportDialog");
const {
  dropConversationImportFile,
  replaceConversationImportSource,
  requestConversationImport,
  useConversationImportRequests,
} = await import("./requests");

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

function committedResult(request: ScientConversationImportConfirmRequest) {
  return {
    importId: request.importId,
    threadId: ThreadId.make("thread-9"),
    destination: request.destination,
    messageCount: 1,
    attachmentCount: 2,
  };
}

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.environmentIds = [local];
  state.offline = [];
  state.projectModel = "codex/gpt-5-mini";
  state.providers = "ready";
  state.currentProject = null;
  state.viewedModel = null;
  useConversationImportRequests.setState({ nextId: 0, queue: [], replaceable: false });
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
  confirmConversationImport.mockImplementation(async (_environmentId, request) =>
    committedResult(request),
  );
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
const opened = { token: "token-1", fileName: "field-notes.scic", sizeBytes: 7 };
const opened2 = { token: "token-2", fileName: "more-notes.scic", sizeBytes: 7 };
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
const button = (label: string) =>
  [...document.querySelectorAll("button")].find((candidate) => candidate.textContent === label);
const alerts = () =>
  [...document.querySelectorAll('[role="alert"]')].map((element) => element.textContent);
const title = () => dialog()?.querySelector("[data-slot='dialog-title']")?.textContent;
const statusText = () => document.querySelector('p[role="status"]')?.textContent;

/**
 * A desktop that keeps the real contract: each upload is an attempt; a cancel
 * stops that attempt only (or keeps it from starting); a release forgets the
 * file. Uploads wait until settled or cancelled while `holding`.
 */
function fakeDesktop() {
  type Request = { readonly token: string; readonly attemptId: string; readonly url: string };
  const cancelledResult = { _tag: "failed", reason: "cancelled" } as const;
  const released = new Set<string>();
  const cancelled = new Set<string>();
  const inFlight = new Map<string, (result: unknown) => void>();
  const desktop = {
    holding: true,
    uploads: [] as Request[],
    bridge: {
      uploadOpenedConversationFile: vi.fn(async (request: Request) => {
        desktop.uploads.push(request);
        if (released.has(request.token)) return { _tag: "failed", reason: "file-unavailable" };
        if (cancelled.delete(request.attemptId)) return cancelledResult;
        if (!desktop.holding) return { _tag: "uploaded" };
        return new Promise((resolve) => inFlight.set(request.attemptId, resolve));
      }),
      cancelOpenedConversationFileUpload: vi.fn(
        async (request: { readonly token: string; readonly attemptId: string }) => {
          const settle = inFlight.get(request.attemptId);
          if (settle === undefined) cancelled.add(request.attemptId);
          inFlight.delete(request.attemptId);
          settle?.(cancelledResult);
        },
      ),
      releaseOpenedConversationFile: vi.fn(async (request: { readonly token: string }) => {
        released.add(request.token);
        for (const settle of inFlight.values()) settle(cancelledResult);
        inFlight.clear();
      }),
    },
  };
  Object.assign(window, { desktopBridge: desktop.bridge });
  return desktop;
}

async function chooseProject(label: string) {
  const trigger = dialog()!.querySelector<HTMLElement>('[data-slot="select-trigger"]')!;
  await act(async () => trigger.click());
  const item = [...document.querySelectorAll<HTMLElement>('[data-slot="select-item"]')].find(
    (candidate) => candidate.textContent === label,
  );
  expect(item, label).toBeDefined();
  await act(async () => {
    item!.click();
    await Promise.resolve();
  });
  await flush();
}

async function pressKey(target: HTMLElement, key: string) {
  await act(async () => {
    target.focus();
    target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
    target.dispatchEvent(new KeyboardEvent("keyup", { key, bubbles: true, cancelable: true }));
  });
}

const visibleButtons = () =>
  [...dialog()!.querySelectorAll("button")]
    .filter((candidate) => !candidate.closest("[data-slot='select-trigger']"))
    .map((candidate) => candidate.textContent);

describe("ConversationImportDialog", () => {
  it("shows only the title, the project, Cancel and Import", async () => {
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
    expect(title()).toBe("Import “Field notes”");
    expect(dialog()!.querySelectorAll('[data-slot="select-trigger"]')).toHaveLength(1);
    expect(dialog()!.querySelector('[data-slot="select-trigger"]')?.textContent).toContain(
      "Field study",
    );
    expect(visibleButtons()).toEqual(["Cancel", "Import"]);
    expect(alerts()).toEqual([]);
    const text = dialog()!.textContent ?? "";
    for (const removed of [
      "Check what's in this file",
      "message",
      "Codex",
      "GPT-5",
      "confirm who made this file",
      "Not included",
      "Supervised",
      "Destination",
      "Choose another file",
    ]) {
      expect(text).not.toContain(removed);
    }
    // The check is done: Import takes focus, so Enter imports.
    expect(document.activeElement).toBe(button("Import"));
  });

  it("imports on the model a new chat in that project would use, then opens it", async () => {
    await openWith(scic());
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
    expect(toastAdd).toHaveBeenCalledWith({ type: "success", title: "Conversation imported" });
    expect(navigate).toHaveBeenCalledWith({
      to: "/$environmentId/$threadId",
      params: expect.objectContaining({ threadId: "thread-9" }),
    });
    expect(dialog()).toBeNull();
    expect(cancelConversationImport).not.toHaveBeenCalled();
  });

  it("follows the chosen project's default model", async () => {
    await openWith(scic());
    await chooseProject("Lab notes");
    await act(async () => button("Import")!.click());
    await flush();
    // Lab notes sets no default: a new chat there opens on the provider's own.
    expect(confirmConversationImport).toHaveBeenCalledWith(
      local,
      expect.objectContaining({
        destination: expect.objectContaining({
          projectId: "project-2",
          modelSelection: { instanceId: "codex", model: "gpt-5" },
        }),
      }),
    );
  });

  it("carries the model of the conversation in view, as a new chat would", async () => {
    state.providers = "codex-and-claude";
    state.viewedModel = { instanceId: "claudeAgent", model: "claude-opus" };
    await openWith(scic());
    await chooseProject("Lab notes");
    await act(async () => button("Import")!.click());
    await flush();
    // Lab notes and the environment set no default: the viewed Claude chat decides.
    expect(confirmConversationImport).toHaveBeenCalledWith(
      local,
      expect.objectContaining({
        destination: expect.objectContaining({
          projectId: "project-2",
          modelSelection: { instanceId: "claudeAgent", model: "claude-opus" },
        }),
      }),
    );
  });

  it("defaults to the project in view", async () => {
    state.currentProject = { environmentId: local, projectId: "project-2" };
    await openWith(scic());
    expect(dialog()!.querySelector('[data-slot="select-trigger"]')?.textContent).toContain(
      "Lab notes",
    );
  });

  it("disables Import when no model is available", async () => {
    state.providers = "none";
    await openWith(scic());
    expect(alerts()).toEqual(["No model is available. Connect a provider to import."]);
    expect(button("Import")?.disabled).toBe(true);
    await act(async () => button("Import")!.click());
    expect(confirmConversationImport).not.toHaveBeenCalled();
  });

  it("spins the Import button while the file is sent and checked", async () => {
    previewConversationImport.mockReturnValue(new Promise(() => {}));
    await openWith(scic());
    expect(title()).toBe("Import “field-notes.scic”");
    expect(statusText()).toBe("Checking the file…");
    const importButton = button("Import")!;
    expect(importButton.disabled).toBe(true);
    expect(importButton.getAttribute("aria-busy")).toBe("true");
    expect(importButton.querySelector("svg")).not.toBeNull();
  });

  it("groups projects by environment only when several environments have some", async () => {
    state.environmentIds = [local, remote];
    await openWith(scic());
    const trigger = dialog()!.querySelector<HTMLElement>('[data-slot="select-trigger"]')!;
    await act(async () => trigger.click());
    const labels = [...document.querySelectorAll("[data-slot='select-item']")].map(
      (item) => item.textContent,
    );
    expect(labels).toEqual(["Field study", "Lab notes", "Survey"]);
    expect(document.body.textContent).toContain("This device");
    expect(document.body.textContent).toContain("Lab workstation");
    expect(document.body.textContent).not.toContain(local);
  });

  it("stops, and never sends the file elsewhere, when the destination disappears", async () => {
    state.environmentIds = [local, remote];
    previewConversationImport.mockReturnValue(new Promise(() => {}));
    await openWith(scic());
    expect(statusText()).toBe("Checking the file…");

    await act(async () => setConnectedEnvironments([remote]));
    await flush();

    expect(createConversationImportUpload).toHaveBeenCalledOnce();
    expect(uploadConversationFile).toHaveBeenCalledOnce();
    expect(cancelConversationImport).toHaveBeenCalledWith(local, importId);
    expect(alerts()).toEqual([
      "That project's environment is no longer available. Choose another project.",
    ]);
    expect(button("Try again")).toBeUndefined();
    expect(button("Import")?.disabled).toBe(true);

    // It stays stopped when the remaining environments change again.
    await act(async () => setConnectedEnvironments([remote, EnvironmentId.make("third")]));
    await flush();
    expect(createConversationImportUpload).toHaveBeenCalledOnce();
  });

  it("stops when the destination's connection drops, and resends only on Try again", async () => {
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
    expect(statusText()).toBe("Sending the file…");

    // The config stays cached while the connection is down.
    await act(async () => setOffline([local]));
    await flush();
    expect(signal?.aborted).toBe(true);
    expect(cancelConversationImport).toHaveBeenCalledWith(local, importId);
    const lost = "Lost the connection to This device. Choose another project or try again.";
    expect(alerts()).toEqual([lost]);
    expect(button("Try again")).toBeUndefined();

    // Reconnecting offers Try again but does not resend by itself.
    uploadConversationFile.mockResolvedValue(undefined);
    await act(async () => setOffline([]));
    await flush();
    expect(createConversationImportUpload).toHaveBeenCalledOnce();
    expect(alerts()).toEqual([lost]);

    await act(async () => button("Try again")!.click());
    await flush();
    expect(createConversationImportUpload).toHaveBeenCalledTimes(2);
    expect(createConversationImportUpload).toHaveBeenLastCalledWith(
      local,
      "field-notes.scic",
      7,
      undefined,
    );
    expect(alerts()).toEqual([]);
    expect(button("Import")?.disabled).toBe(false);
  });

  it("stops a finished check when the destination's connection drops", async () => {
    await openWith(scic());
    expect(button("Import")?.disabled).toBe(false);
    await act(async () => setOffline([local]));
    await flush();
    expect(cancelConversationImport).toHaveBeenCalledWith(local, importId);
    expect(button("Import")?.disabled).toBe(true);
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
    expect(statusText()).toBe("Sending the file…");

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
    expect(statusText()).toBe("Checking the file…");

    await pressKey(dialog()!, "Escape");
    await flush();
    expect(cancelConversationImport).toHaveBeenCalledWith(local, importId);
    expect(dialog()).toBeNull();
  });
  it("closes quietly when the desktop's send prompt is declined", async () => {
    const uploadOpenedConversationFile = vi
      .fn()
      .mockResolvedValue({ _tag: "failed", reason: "declined" });
    Object.assign(window, { desktopBridge: { uploadOpenedConversationFile } });
    await act(async () => root.render(<ConversationImportDialogHost />));
    await act(async () => requestConversationImport({ _tag: "desktop-file", file: opened }));
    await flush();

    expect(uploadOpenedConversationFile).toHaveBeenCalledOnce();
    expect(dialog()).toBeNull();
    expect(cancelConversationImport).toHaveBeenCalledWith(local, importId);
    expect(toastAdd).not.toHaveBeenCalled();
  });

  it("stops a desktop upload on Cancel before releasing the staged import", async () => {
    const calls: string[] = [];
    let settle: (result: unknown) => void = () => {};
    const uploadOpenedConversationFile = vi.fn(
      (_request: { readonly token: string; readonly attemptId: string }) =>
        new Promise((resolve) => {
          settle = resolve;
        }),
    );
    const cancelOpenedConversationFileUpload = vi.fn(async () => {
      calls.push("desktop");
      settle({ _tag: "failed", reason: "cancelled" });
    });
    cancelConversationImport.mockImplementation(async () => {
      calls.push("server");
      return { _tag: "cancelled" };
    });
    Object.assign(window, {
      desktopBridge: { uploadOpenedConversationFile, cancelOpenedConversationFileUpload },
    });
    await act(async () => root.render(<ConversationImportDialogHost />));
    await act(async () => requestConversationImport({ _tag: "desktop-file", file: opened }));
    await flush();
    expect(uploadOpenedConversationFile).toHaveBeenCalledOnce();

    await act(async () => button("Cancel")!.click());
    await flush();
    expect(cancelOpenedConversationFileUpload).toHaveBeenCalledWith({
      token: "token-1",
      attemptId: uploadOpenedConversationFile.mock.calls[0]![0].attemptId,
    });
    expect(cancelConversationImport).toHaveBeenCalledWith(local, importId);
    expect(calls).toEqual(["desktop", "server"]);
    expect(dialog()).toBeNull();
    expect(toastAdd).not.toHaveBeenCalled();
  });

  it("sends an opened file again when the destination changes during its upload", async () => {
    state.environmentIds = [local, remote];
    const desktop = fakeDesktop();
    await act(async () => root.render(<ConversationImportDialogHost />));
    await act(async () => requestConversationImport({ _tag: "desktop-file", file: opened }));
    await flush();
    expect(desktop.uploads).toHaveLength(1);
    expect(statusText()).toBe("Sending the file…");

    desktop.holding = false;
    await chooseProject("Survey");

    const [first, second] = desktop.uploads;
    expect(desktop.uploads).toHaveLength(2);
    expect(desktop.bridge.cancelOpenedConversationFileUpload).toHaveBeenCalledWith({
      token: "token-1",
      attemptId: first!.attemptId,
    });
    expect(cancelConversationImport).toHaveBeenCalledWith(local, importId);
    expect(second!.token).toBe("token-1");
    expect(second!.attemptId).not.toBe(first!.attemptId);
    expect(createConversationImportUpload).toHaveBeenLastCalledWith(
      remote,
      "field-notes.scic",
      7,
      undefined,
    );
    expect(previewConversationImport).toHaveBeenCalledWith(remote, secondImportId);
    expect(title()).toBe("Import “Field notes”");
    expect(alerts()).toEqual([]);
    expect(desktop.bridge.releaseOpenedConversationFile).not.toHaveBeenCalled();
  });

  it("sends an opened file again on Try again after the connection comes back", async () => {
    const desktop = fakeDesktop();
    await act(async () => root.render(<ConversationImportDialogHost />));
    await act(async () => requestConversationImport({ _tag: "desktop-file", file: opened }));
    await flush();
    expect(desktop.uploads).toHaveLength(1);

    await act(async () => setOffline([local]));
    await flush();
    expect(desktop.bridge.cancelOpenedConversationFileUpload).toHaveBeenCalledOnce();
    expect(alerts()).toEqual([
      "Lost the connection to This device. Choose another project or try again.",
    ]);

    desktop.holding = false;
    await act(async () => setOffline([]));
    await flush();
    expect(desktop.uploads).toHaveLength(1);
    await act(async () => button("Try again")!.click());
    await flush();

    expect(desktop.uploads).toHaveLength(2);
    expect(desktop.uploads[1]!.attemptId).not.toBe(desktop.uploads[0]!.attemptId);
    expect(previewConversationImport).toHaveBeenCalledWith(local, secondImportId);
    expect(dialog()).not.toBeNull();
    expect(alerts()).toEqual([]);
    expect(button("Import")?.disabled).toBe(false);
  });

  it("gives up an opened file when its dialog closes or another file replaces it", async () => {
    const desktop = fakeDesktop();
    desktop.holding = false;
    await act(async () => root.render(<ConversationImportDialogHost />));
    await act(async () => requestConversationImport({ _tag: "desktop-file", file: opened }));
    await flush();
    expect(button("Import")?.disabled).toBe(false);
    expect(desktop.bridge.releaseOpenedConversationFile).not.toHaveBeenCalled();

    await act(async () => dropConversationImportFile(scic()));
    await flush();
    expect(desktop.bridge.releaseOpenedConversationFile).toHaveBeenCalledWith({
      token: "token-1",
    });

    await act(async () => requestConversationImport({ _tag: "desktop-file", file: opened2 }));
    await act(async () => button("Cancel")!.click());
    await flush();
    // The next queued file opens; closing it gives it up too.
    expect(desktop.bridge.releaseOpenedConversationFile).toHaveBeenCalledTimes(1);
    await act(async () => button("Cancel")!.click());
    await flush();
    expect(desktop.bridge.releaseOpenedConversationFile).toHaveBeenLastCalledWith({
      token: "token-2",
    });
    expect(dialog()).toBeNull();
  });

  it("never starts a queued desktop upload once its attempt is cancelled", async () => {
    let settleFirst: (result: unknown) => void = () => {};
    const uploadOpenedConversationFile = vi.fn(
      () =>
        new Promise((resolve) => {
          settleFirst = resolve;
        }),
    );
    // This desktop cannot stop a stream early; the next upload waits for it.
    Object.assign(window, { desktopBridge: { uploadOpenedConversationFile } });
    await act(async () => root.render(<ConversationImportDialogHost />));
    await act(async () => requestConversationImport({ _tag: "desktop-file", file: opened }));
    await flush();
    await act(async () =>
      replaceConversationImportSource({
        _tag: "desktop-file",
        file: { token: "token-2", fileName: "other.scic", sizeBytes: 7 },
      }),
    );
    await flush();
    expect(createConversationImportUpload).toHaveBeenCalledTimes(2);

    await act(async () => button("Cancel")!.click());
    await act(async () => settleFirst({ _tag: "failed", reason: "cancelled" }));
    await flush();
    expect(uploadOpenedConversationFile).toHaveBeenCalledOnce();
    expect(cancelConversationImport).toHaveBeenCalledWith(local, secondImportId);
    expect(dialog()).toBeNull();
  });

  it("says plainly when the destination refuses a desktop upload", async () => {
    Object.assign(window, {
      desktopBridge: {
        uploadOpenedConversationFile: vi
          .fn()
          .mockResolvedValue({ _tag: "failed", reason: "rejected" }),
      },
    });
    await act(async () => root.render(<ConversationImportDialogHost />));
    await act(async () => requestConversationImport({ _tag: "desktop-file", file: opened }));
    await flush();
    expect(alerts()).toEqual(["The destination didn't accept the file. Try again."]);
    expect(dialog()?.textContent).not.toContain("rejected");
  });

  it.each(["file-unavailable", "file-changed"])(
    "asks for the file to be opened again, with only Cancel, when the desktop answers %s",
    async (reason) => {
      Object.assign(window, {
        desktopBridge: {
          uploadOpenedConversationFile: vi.fn().mockResolvedValue({ _tag: "failed", reason }),
        },
      });
      await act(async () => root.render(<ConversationImportDialogHost />));
      await act(async () => requestConversationImport({ _tag: "desktop-file", file: opened }));
      await flush();

      expect(alerts()).toEqual(["Open the file again to import it."]);
      expect(visibleButtons()).toEqual(["Cancel"]);
      expect(dialog()?.textContent).not.toContain(reason);
    },
  );

  it("words other desktop failures plainly", async () => {
    Object.assign(window, {
      desktopBridge: {
        uploadOpenedConversationFile: vi
          .fn()
          .mockResolvedValue({ _tag: "failed", reason: "network-failed" }),
      },
    });
    await act(async () => root.render(<ConversationImportDialogHost />));
    await act(async () => requestConversationImport({ _tag: "desktop-file", file: opened }));
    await flush();

    expect(alerts()).toEqual(["The file couldn't be sent. Check the connection and try again."]);
    expect(dialog()?.textContent).not.toContain("network-failed");
  });

  it("shows one plain line, and only Cancel, for a file that cannot be read", async () => {
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
    expect(dialog()!.querySelector('[data-slot="select-trigger"]')).toBeNull();
    expect(visibleButtons()).toEqual(["Cancel"]);
    expect(cancelConversationImport).toHaveBeenCalledWith(local, importId);
  });

  it("says plainly that a file couldn't be read when there is no specific reason", async () => {
    previewConversationImport.mockRejectedValueOnce(
      new ScientConversationImportError({
        reason: "package-rejected",
        rejection: { reason: "unsafe-path", entry: null },
        message: "Rejected: unsafe-path",
      }),
    );
    await openWith(scic());
    expect(alerts()).toEqual(["This file can't be imported. It didn't pass Scient's checks."]);
    expect(visibleButtons()).toEqual(["Cancel"]);
  });

  it("offers Try again after a failure that sending again can fix", async () => {
    previewConversationImport.mockRejectedValueOnce(
      new ScientConversationImportError({
        reason: "staging-full",
        rejection: null,
        message: "There is not enough room for this import right now. Try again later.",
      }),
    );
    await openWith(scic());
    expect(alerts()).toEqual([
      "There is not enough room for this import right now. Try again later.",
    ]);
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
    expect(title()).toBe("Start a conversation from notes.md");
    expect(visibleButtons()).toEqual(["Cancel", "Start"]);
    expect(button("Start")?.disabled).toBe(false);
  });

  it("offers one compact choice when some messages couldn't be read", async () => {
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
    expect(dialog()?.textContent).toContain("Some messages couldn't be read.");
    expect(dialog()?.textContent).not.toContain("Line 4");
    expect(visibleButtons()).toEqual([
      "Import readable messages",
      "Start with the whole file",
      "Cancel",
    ]);

    await act(async () => button("Start with the whole file")!.click());
    await flush();
    expect(cancelConversationImport).toHaveBeenCalledWith(local, importId);
    expect(createConversationImportUpload).toHaveBeenLastCalledWith(
      local,
      "notes.md",
      7,
      "document",
    );
  });

  it("imports the readable messages when asked", async () => {
    previewConversationImport.mockResolvedValueOnce(
      previewOf({
        kind: "markdown",
        markdownIssues: [
          { kind: "malformed-marker", startLine: 4, endLine: 4, detail: "Bad marker." },
        ],
      }),
    );
    await openWith(new File(["# Notes"], "notes.md"));
    await act(async () => button("Import readable messages")!.click());
    await flush();
    expect(confirmConversationImport).toHaveBeenCalledWith(
      local,
      expect.objectContaining({ importId, acknowledgeMarkdownIssues: true }),
    );
    expect(dialog()).toBeNull();
  });

  it("offers the whole file as a document when a Markdown transcript is too long", async () => {
    const tooLong =
      "This conversation is too long to import: it has 5,001 messages and other items, and Scient imports up to 5,000 at once. Import it as a document instead.";
    previewConversationImport.mockRejectedValueOnce(
      new ScientConversationImportError({
        reason: "package-too-large",
        rejection: null,
        message: tooLong,
      }),
    );
    previewConversationImport.mockResolvedValueOnce(
      previewOf({
        importId: secondImportId,
        kind: "document",
        conversation: { ...previewOf().conversation, provider: null, model: null },
      }),
    );
    await openWith(new File(["# Notes"], "notes.md"));
    expect(alerts()).toEqual([tooLong]);
    expect(button("Try again")).toBeUndefined();

    await act(async () => button("Start with the whole file")!.click());
    await flush();
    expect(createConversationImportUpload).toHaveBeenLastCalledWith(
      local,
      "notes.md",
      7,
      "document",
    );
    expect(alerts()).toEqual([]);
    await act(async () => button("Start")!.click());
    await flush();
    expect(confirmConversationImport).toHaveBeenCalledWith(
      local,
      expect.objectContaining({ importId: secondImportId }),
    );
    expect(toastAdd).toHaveBeenCalledWith({ type: "success", title: "Conversation imported" });
  });

  it("offers no document choice when a file is refused for its size", async () => {
    createConversationImportUpload.mockRejectedValueOnce(
      new ScientConversationImportError({
        reason: "package-too-large",
        rejection: null,
        message: "This file is larger than Scient can import.",
      }),
    );
    await openWith(new File(["# Notes"], "notes.md"));
    expect(alerts()).toEqual(["This file is larger than Scient can import."]);
    expect(button("Start with the whole file")).toBeUndefined();
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
    expect(title()).toBe("Import “Field notes”");
  });

  it("treats an unanswered confirm as unknown, without connection details", async () => {
    confirmConversationImport.mockRejectedValueOnce(
      new Error("Remote environment endpoint http://127.0.0.1:4000/api timed out after 300000ms."),
    );
    await openWith(scic());
    await act(async () => button("Import")!.click());
    await flush();
    expect(alerts()).toEqual(["Scient couldn't tell whether the import finished."]);
    expect(dialog()?.textContent).not.toContain("127.0.0.1");
    expect(cancelConversationImport).not.toHaveBeenCalled();

    await act(async () => button("Check again")!.click());
    await flush();
    expect(confirmConversationImport).toHaveBeenCalledTimes(2);
    expect(confirmConversationImport.mock.calls[1]?.[1]).toEqual(
      confirmConversationImport.mock.calls[0]?.[1],
    );
    expect(dialog()).toBeNull();
    expect(navigate).toHaveBeenCalledOnce();
  });

  it("learns after reconnecting that an import sent before a drop committed", async () => {
    state.environmentIds = [local, remote];
    confirmConversationImport.mockReturnValueOnce(new Promise(() => {}));
    await openWith(scic());
    await act(async () => button("Import")!.click());
    await flush();

    await act(async () => setOffline([local]));
    await flush();
    expect(alerts()).toEqual([
      "Lost the connection while importing. Scient will check whether the import finished when the connection returns.",
    ]);
    expect(
      dialog()!.querySelector('[data-slot="select-trigger"]')?.hasAttribute("data-disabled"),
    ).toBe(true);
    expect(cancelConversationImport).not.toHaveBeenCalled();
    expect(createConversationImportUpload).toHaveBeenCalledOnce();

    await act(async () => setOffline([]));
    await flush();
    expect(confirmConversationImport).toHaveBeenCalledTimes(2);
    expect(confirmConversationImport.mock.calls[1]).toEqual(
      confirmConversationImport.mock.calls[0],
    );
    expect(toastAdd).toHaveBeenCalledWith(
      expect.objectContaining({ type: "success", title: "Conversation imported" }),
    );
    expect(navigate).toHaveBeenCalledOnce();
    expect(dialog()).toBeNull();
    expect(createConversationImportUpload).toHaveBeenCalledOnce();
    expect(cancelConversationImport).not.toHaveBeenCalled();
  });

  it("tries the same staged import again when the lost confirm did not commit", async () => {
    confirmConversationImport.mockReturnValueOnce(new Promise(() => {}));
    confirmConversationImport.mockRejectedValueOnce(
      new ScientConversationImportError({
        reason: "import-failed",
        rejection: null,
        message: "The import was interrupted. Scient will finish cleaning up; try again later.",
      }),
    );
    await openWith(scic());
    await act(async () => button("Import")!.click());
    await flush();
    await act(async () => setOffline([local]));
    await flush();
    await act(async () => setOffline([]));
    await flush();

    expect(alerts()).toEqual([
      "The import was interrupted. Scient will finish cleaning up; try again later.",
    ]);
    await act(async () => button("Try again")!.click());
    await flush();
    expect(confirmConversationImport).toHaveBeenCalledTimes(3);
    expect(confirmConversationImport.mock.calls[2]?.[1]).toMatchObject({ importId });
    expect(createConversationImportUpload).toHaveBeenCalledOnce();
    expect(cancelConversationImport).not.toHaveBeenCalled();
    expect(dialog()).toBeNull();
  });

  it("finishes with the committed thread when a reconnected confirm finds it already imported", async () => {
    confirmConversationImport.mockReturnValueOnce(new Promise(() => {}));
    confirmConversationImport.mockRejectedValueOnce(
      new ScientConversationImportError({
        reason: "already-imported",
        rejection: null,
        message: "This conversation was already imported to another project or model.",
      }),
    );
    cancelConversationImport.mockImplementation(async () => ({
      _tag: "already-imported",
      result: {
        ...committedResult(confirmConversationImport.mock.calls[0]![1]),
        threadId: ThreadId.make("thread-committed"),
        destination: {
          ...confirmConversationImport.mock.calls[0]![1].destination,
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
        },
      },
    }));
    await openWith(scic());
    await act(async () => button("Import")!.click());
    await flush();
    await act(async () => setOffline([local]));
    await flush();
    await act(async () => setOffline([]));
    await flush();

    expect(cancelConversationImport).toHaveBeenCalledWith(local, importId);
    expect(toastAdd).toHaveBeenCalledWith({ type: "success", title: "Conversation imported" });
    expect(navigate).toHaveBeenCalledWith({
      to: "/$environmentId/$threadId",
      params: expect.objectContaining({ threadId: "thread-committed" }),
    });
    expect(dialog()).toBeNull();
    expect(createConversationImportUpload).toHaveBeenCalledOnce();
    expect(button("Try again")).toBeUndefined();
  });

  it("reports an import that finished after all when the dialog is closed", async () => {
    confirmConversationImport.mockRejectedValueOnce(
      new ScientConversationImportError({
        reason: "import-failed",
        rejection: null,
        message: "The import was interrupted. Scient will finish cleaning up; try again later.",
      }),
    );
    cancelConversationImport.mockImplementation(async () => ({
      _tag: "already-imported",
      result: committedResult(confirmConversationImport.mock.calls[0]![1]),
    }));
    await openWith(scic());
    await act(async () => button("Import")!.click());
    await flush();
    await act(async () => button("Cancel")!.click());
    await flush();

    expect(cancelConversationImport).toHaveBeenCalledWith(local, importId);
    expect(toastAdd).toHaveBeenCalledWith({
      type: "success",
      title: "Conversation imported",
      description: "The import finished after all. It's in your conversations.",
    });
    expect(createConversationImportUpload).toHaveBeenCalledOnce();
  });

  it("sends the file again only when the server no longer has the staged import", async () => {
    confirmConversationImport.mockRejectedValueOnce(new Error("socket closed"));
    confirmConversationImport.mockRejectedValueOnce(
      new ScientConversationImportError({
        reason: "import-not-found",
        rejection: null,
        message: "This import is no longer available.",
      }),
    );
    await openWith(scic());
    await act(async () => button("Import")!.click());
    await flush();
    await act(async () => button("Check again")!.click());
    await flush();
    expect(alerts()).toEqual(["The import didn't finish. Send the file again to import it."]);

    await act(async () => button("Try again")!.click());
    await flush();
    expect(createConversationImportUpload).toHaveBeenCalledTimes(2);
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

  it("opens every file dropped during setup in turn", async () => {
    await openWith(scic(), true);
    await act(async () => dropConversationImportFile(new File(["b"], "second.scic")));
    expect(useConversationImportRequests.getState().queue).toHaveLength(2);

    await act(async () => root.render(<ConversationImportDialogHost />));
    await flush();
    expect(createConversationImportUpload).toHaveBeenLastCalledWith(
      local,
      "field-notes.scic",
      7,
      undefined,
    );
    await act(async () => button("Cancel")!.click());
    await flush();
    expect(dialog()).not.toBeNull();
    expect(createConversationImportUpload).toHaveBeenLastCalledWith(
      local,
      "second.scic",
      1,
      undefined,
    );
  });

  it("checks a file chosen with the picker straight away", async () => {
    await act(async () => root.render(<ConversationImportDialogHost />));
    await act(async () => requestConversationImport());
    await flush();
    expect(createConversationImportUpload).not.toHaveBeenCalled();
    expect(visibleButtons()).toEqual(["Choose file…", "Cancel"]);

    const input = dialog()!.querySelector<HTMLInputElement>('input[type="file"]')!;
    expect(input.accept).toBe(".scic,.md");
    const chosen = scic();
    Object.defineProperty(input, "files", { configurable: true, value: [chosen] });
    await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));
    await flush();

    expect(createConversationImportUpload).toHaveBeenCalledWith(
      local,
      "field-notes.scic",
      7,
      undefined,
    );
    expect(uploadConversationFile.mock.calls[0]?.[1]).toBe(chosen);
    expect(title()).toBe("Import “Field notes”");
    expect(document.activeElement).toBe(button("Import"));
  });
});
