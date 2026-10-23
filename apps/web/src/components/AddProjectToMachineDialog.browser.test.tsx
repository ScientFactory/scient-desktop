import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { useSyncExternalStore } from "react";

import { act, render } from "../../test/render";
import {
  AddProjectToMachineDialogHost,
  openAddProjectToMachine,
} from "./AddProjectToMachineDialog";
import "../index.css";

const mocks = vi.hoisted(() => ({
  root: "/source/repo",
  pending: false,
  listeners: new Set<() => void>(),
  subscribe: (listener: () => void): (() => void) => {
    mocks.listeners.add(listener);
    return () => {
      mocks.listeners.delete(listener);
    };
  },
  clone: vi.fn(async (_request: unknown) => {}),
  newThread: vi.fn(async () => {}),
}));
const source = EnvironmentId.make("consent-source");
const targetA = EnvironmentId.make("consent-target-a");
const targetB = EnvironmentId.make("consent-target-b");
const projectId = ProjectId.make("consent-project");
const request = (environmentId = source, targetEnvironmentId = targetA) => ({
  projectRef: scopeProjectRef(environmentId, projectId),
  targetEnvironmentId,
});

vi.mock(import("../state/entities"), async (original) => ({
  ...(await original()),
  useProject: ((ref: { environmentId: EnvironmentId }) => {
    const root = useSyncExternalStore(mocks.subscribe, () => mocks.root);
    return {
      environmentId: ref.environmentId,
      workspaceRoot: root,
      title: "Consent fixture",
      repositoryIdentity: {
        rootPath: root,
        locator: { remoteUrl: "https://example.invalid/team/repo.git" },
      },
    };
  }) as never,
}));
vi.mock(import("../hooks/useAddProjectTargets"), async (original) => ({
  ...(await original()),
  useAddProjectTargets: (() => [
    { environmentId: targetA, label: "Machine A", machine: "linux" },
    { environmentId: targetB, label: "Machine B", machine: "linux" },
  ]) as never,
}));
vi.mock(import("../hooks/useLogicalProjectEnvironments"), async (original) => ({
  ...(await original()),
  useLogicalProjectEnvironments: (() => []) as never,
}));
vi.mock(import("../hooks/useHandleNewThread"), async (original) => ({
  ...(await original()),
  useNewThreadHandler: (() => mocks.newThread) as never,
}));
vi.mock(import("../state/environments"), async (original) => ({
  ...(await original()),
  useEnvironments: (() => ({
    environments: [source, targetA, targetB].map((environmentId) => ({
      environmentId,
      label: environmentId === source ? "Source" : "Target",
      serverConfig: {
        environment: { capabilities: { ignoredFileListing: true }, platform: { machine: "linux" } },
        settings: { addProjectBaseDirectory: "/projects" },
      },
    })),
  })) as never,
}));
vi.mock(import("../state/query"), async (original) => ({
  ...(await original()),
  useEnvironmentQuery: (() => {
    const pending = useSyncExternalStore(mocks.subscribe, () => mocks.pending);
    return {
      data: pending
        ? null
        : {
            files: [
              { path: ".env", byteLength: 7 },
              { path: ".envrc", byteLength: 9 },
              { path: "ordinary.log", byteLength: 12 },
              { path: "oversized.env", byteLength: 1_048_577 },
            ],
            truncated: false,
          },
      error: null,
      isSuccess: !pending,
    };
  }) as never,
}));
vi.mock(import("../lib/addProjectToMachine"), async (original) => ({
  ...(await original()),
  addProjectToMachine: mocks.clone as never,
}));

function setup(pending = false) {
  mocks.root = "/source/repo";
  mocks.pending = pending;
  mocks.clone.mockReset().mockResolvedValue();
  mocks.newThread.mockClear();
  openAddProjectToMachine(request());
}
const envFile = () => page.getByRole("checkbox", { name: /^\.env 7/ });
async function update(values: { root?: string; pending?: boolean }) {
  await act(() => {
    Object.assign(mocks, values);
    mocks.listeners.forEach((listener) => listener());
  });
}

it("copies no ignored files by default and submits only explicit, size-bounded consent", async () => {
  setup();
  await using _screen = await render(<AddProjectToMachineDialogHost />);
  const checkboxes = [...document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
  expect(checkboxes).toHaveLength(4);
  expect(checkboxes.every((checkbox) => !checkbox.checked)).toBe(true);
  await expect.element(page.getByRole("checkbox", { name: /^oversized\.env/ })).toBeDisabled();
  await envFile().click();
  await page.getByRole("button", { name: "Clone to Machine A" }).click();
  await vi.waitFor(() => expect(mocks.clone).toHaveBeenCalledOnce());
  expect(mocks.clone).toHaveBeenCalledWith(
    expect.objectContaining({
      source: { environmentId: source, cwd: "/source/repo" },
      target: { environmentId: targetA, label: "Machine A" },
      files: [".env"],
    }),
  );
});

it("does not carry credential-file consent across folders, targets, source roots or requests", async () => {
  setup();
  await using _screen = await render(<AddProjectToMachineDialogHost />);
  await envFile().click();
  await page.getByRole("textbox", { name: "Folder on Machine A" }).fill("/elsewhere/repo");
  await expect.element(envFile()).not.toBeChecked();

  await envFile().click();
  await page.getByRole("combobox", { name: "Machine to add the project to" }).click();
  await page.getByRole("option", { name: "Machine B" }).click();
  await expect.element(envFile()).not.toBeChecked();

  await envFile().click();
  await update({ root: "/another/source/repo" });
  await expect.element(envFile()).not.toBeChecked();

  await envFile().click();
  await act(() => openAddProjectToMachine(request(targetB)));
  await expect.element(envFile()).not.toBeChecked();
  expect(mocks.clone).not.toHaveBeenCalled();
});

it("waits for the file choices and does not let an old clone dismiss a new request", async () => {
  setup(true);
  await using _screen = await render(<AddProjectToMachineDialogHost />);
  await expect.element(page.getByRole("button", { name: "Clone to Machine A" })).toBeDisabled();
  await update({ pending: false });
  let finish!: () => void;
  mocks.clone.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  await page.getByRole("button", { name: "Clone to Machine A" }).click();
  await vi.waitFor(() => expect(mocks.clone).toHaveBeenCalledOnce());
  expect(mocks.clone).toHaveBeenCalledWith(expect.objectContaining({ files: [] }));
  await act(() => openAddProjectToMachine(request(source, targetB)));
  await act(() => finish());
  await expect.element(page.getByRole("button", { name: "Clone to Machine B" })).toBeEnabled();
  expect(mocks.newThread).not.toHaveBeenCalled();
});
