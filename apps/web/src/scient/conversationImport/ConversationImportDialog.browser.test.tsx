import "../../index.css";

import {
  ConversationImportId,
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ServerConfig,
} from "@t3tools/contracts";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vitest/browser";

const client = vi.hoisted(() => ({
  createConversationImportUpload: vi.fn(),
  uploadConversationFile: vi.fn(),
  previewConversationImport: vi.fn(),
  confirmConversationImport: vi.fn(),
  cancelConversationImport: vi.fn(),
}));
vi.mock("./client", () => client);
vi.mock("../../components/ui/toast", () => ({ toastManager: { add: vi.fn() } }));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => async () => {} }));
vi.mock("../../hooks/useHandleNewThread", () => ({
  useHandleNewThread: () => ({
    activeDraftThread: null,
    activeThread: undefined,
    handleNewThread: async () => null,
  }),
}));

const local = EnvironmentId.make("local-environment");
const remote = EnvironmentId.make("remote-environment");
const codex = ProviderInstanceId.make("codex");

vi.mock("../../state/entities", async (importOriginal) => {
  const config = {
    providers: [
      {
        instanceId: codex,
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
      },
    ],
    settings: { ...DEFAULT_SERVER_SETTINGS, defaultRuntimeMode: "approval-required" },
  } as unknown as ServerConfig;
  const project = (id: string, environmentId: EnvironmentId, title: string, model: string) => ({
    id: ProjectId.make(id),
    environmentId,
    title,
    defaultModelSelection: { instanceId: codex, model },
  });
  const projects = [
    project("local-notes", local, "Local notes", "gpt-5"),
    project("field-study", remote, "Field study", "gpt-5"),
    project("survey", remote, "Survey", "gpt-5-mini"),
  ];
  const configs = new Map([
    [local, config],
    [remote, config],
  ]);
  return {
    ...(await importOriginal<object>()),
    useProjects: () => projects,
    useServerConfigs: () => configs,
    useThreadShells: () => [],
  };
});
vi.mock("../../state/environments", async (importOriginal) => {
  const environments = [
    { environmentId: local, label: "Local", connection: { phase: "connected" } },
    { environmentId: remote, label: "Lab workstation", connection: { phase: "connected" } },
  ];
  return {
    ...(await importOriginal<object>()),
    useEnvironments: () => ({ environments }),
    usePrimaryEnvironmentId: () => local,
  };
});

const { ConversationImportDialogHost } = await import("./ConversationImportDialog");
const { requestConversationImport, useConversationImportRequests } = await import("./requests");

let root: Root;
let host: HTMLDivElement;
let uploads = 0;

beforeEach(() => {
  useConversationImportRequests.setState({ nextId: 0, queue: [], replaceable: false });
  for (const mock of Object.values(client)) mock.mockReset();
  uploads = 0;
  client.createConversationImportUpload.mockImplementation(async () => {
    uploads += 1;
    return {
      importId: ConversationImportId.make(`cimp_00000000-0000-4000-8000-00000000000${uploads}`),
      url: "http://127.0.0.1/api/scient/conversation-import/v1/upload/token",
      relativeUrl: "/api/scient/conversation-import/v1/upload/token",
      expiresAt: 0,
    };
  });
  client.uploadConversationFile.mockResolvedValue(undefined);
  client.previewConversationImport.mockImplementation(async (_environmentId, importId) => ({
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
      messages: 3,
      attachments: 0,
      reasoning: 0,
      workLogEntries: 0,
      proposedPlans: 0,
      questionAnswers: 0,
    },
    omissions: [],
    warnings: [],
    markdownIssues: [],
    expiresAt: 0,
  }));
  client.cancelConversationImport.mockResolvedValue({ _tag: "cancelled" });
  client.confirmConversationImport.mockImplementation(async (_environmentId, request) => ({
    importId: request.importId,
    threadId: ThreadId.make("thread-1"),
    destination: request.destination,
    messageCount: 3,
    attachmentCount: 0,
  }));
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  root.unmount();
  host.remove();
});

const focusedLabel = () =>
  document.activeElement?.getAttribute("aria-label") ?? document.activeElement?.textContent ?? "";
const trigger = (label: string) =>
  [...document.querySelectorAll<HTMLElement>('[data-slot="select-trigger"]')].find(
    (element) =>
      document.getElementById(element.getAttribute("aria-labelledby") ?? "")?.textContent === label,
  );

/** Picks the option named `option` from the focused Select, by keyboard only. */
async function chooseByKeyboard(option: string, move: "{ArrowDown}" | "{ArrowUp}" = "{ArrowDown}") {
  const select = document.activeElement as HTMLElement;
  await userEvent.keyboard("{ArrowDown}");
  await expect.poll(() => select.getAttribute("aria-expanded")).toBe("true");
  for (let step = 0; step < 6; step += 1) {
    const highlighted = document.querySelector('[role="option"][data-highlighted]');
    if (highlighted?.textContent === option) break;
    await userEvent.keyboard(move);
  }
  expect(document.querySelector('[role="option"][data-highlighted]')?.textContent).toBe(option);
  await userEvent.keyboard("{Enter}");
  await expect.poll(() => select.getAttribute("aria-expanded")).toBe("false");
  await expect.poll(() => document.activeElement).toBe(select);
}

describe("ConversationImportDialog keyboard use", () => {
  it("picks a project and imports without a pointer", async () => {
    root.render(<ConversationImportDialogHost />);
    requestConversationImport({
      _tag: "browser-file",
      file: new File(["archive"], "field-notes.scic"),
    });

    // The finished check puts focus on Import, so Enter alone would import.
    await expect.poll(focusedLabel).toBe("Import");
    expect(trigger("Project")?.textContent).toContain("Local notes");

    await userEvent.keyboard("{Shift>}{Tab}{/Shift}");
    expect(focusedLabel()).toBe("Cancel");
    await userEvent.keyboard("{Shift>}{Tab}{/Shift}");
    expect(document.activeElement).toBe(trigger("Project"));
    // A project in another environment sends the file there instead.
    await chooseByKeyboard("Survey");
    await expect.poll(() => client.previewConversationImport.mock.calls.at(-1)?.[0]).toBe(remote);
    expect(client.cancelConversationImport).toHaveBeenCalledWith(
      local,
      "cimp_00000000-0000-4000-8000-000000000001",
    );
    expect(trigger("Project")?.textContent).toContain("Survey");
    // Choosing kept focus on the choice; the finished check did not move it.
    expect(document.activeElement).toBe(trigger("Project"));

    await userEvent.tab();
    await userEvent.tab();
    expect(focusedLabel()).toBe("Import");
    await expect.poll(() => (document.activeElement as HTMLButtonElement).disabled).toBe(false);
    await userEvent.keyboard("{Enter}");

    await expect.poll(() => client.confirmConversationImport.mock.calls.length).toBe(1);
    expect(client.confirmConversationImport.mock.calls[0]).toEqual([
      remote,
      expect.objectContaining({
        importId: "cimp_00000000-0000-4000-8000-000000000002",
        destination: {
          projectId: "survey",
          modelSelection: { instanceId: "codex", model: "gpt-5-mini" },
          runtimeMode: "approval-required",
          interactionMode: "default",
        },
      }),
    ]);
  });
});
