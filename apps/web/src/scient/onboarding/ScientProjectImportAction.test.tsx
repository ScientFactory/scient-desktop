// @vitest-environment happy-dom
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { ScientProjectImportAction } from "./ScientProjectImportAction";

const mocks = vi.hoisted(() => ({
  access: "granted",
  importer: vi.fn(),
  openProject: vi.fn(),
  toast: vi.fn(),
}));
const environmentId = EnvironmentId.make("local");
const projectId = ProjectId.make("imported");
vi.mock("../../providerOperateAccess", () => ({ resolvePrimaryOperateAccess: () => mocks.access }));
vi.mock("../../environments/primary", () => ({
  usePrimarySessionState: () => ({ data: null, isPending: false, error: null }),
}));
vi.mock("../../state/environments", () => ({
  usePrimaryEnvironment: () => ({ environmentId, label: "Test machine" }),
}));
vi.mock("../../hooks/useHandleNewThread", () => ({ useNewThreadHandler: () => mocks.openProject }));
vi.mock("../../components/ui/toast", () => ({ toastManager: { add: mocks.toast } }));
vi.mock("../../components/ui/dialog", () => ({
  Dialog: ({
    children,
    onOpenChange,
  }: {
    children: ReactNode;
    onOpenChange: (open: boolean) => void;
  }) => (
    <section role="dialog">
      {children}
      <button onClick={() => onOpenChange(false)}>Dismiss</button>
    </section>
  ),
  DialogPopup: ({ children }: { children: ReactNode }) => children,
  DialogPanel: ({ children }: { children: ReactNode }) => children,
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
}));
vi.mock("../../components/onboarding/ProjectImportStep", () => ({
  ProjectImportStep: (props: unknown) => {
    mocks.importer(props);
    return <p>Import choices</p>;
  },
}));

let root: Root;
let container: HTMLDivElement;
const imported = vi.fn();
async function render() {
  await act(() => root.render(<ScientProjectImportAction onImported={imported} />));
}
async function click(label: string) {
  const button = [...container.querySelectorAll("button")].find(
    (item) => item.textContent === label,
  );
  expect(button).toBeDefined();
  await act(() => button!.click());
}
function importProps() {
  return mocks.importer.mock.lastCall![0] as {
    onDone: (projectRef?: {
      environmentId: EnvironmentId;
      projectId: ProjectId;
    }) => Promise<boolean>;
    onImportingChange: (busy: boolean) => void;
  };
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  mocks.access = "granted";
  mocks.openProject.mockResolvedValue({ threadId: "draft", draftId: "draft" });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
describe("optional project import entry point", () => {
  it("mounts no scanner until requested, and cancelling does not complete onboarding", async () => {
    await render();
    expect(mocks.importer).not.toHaveBeenCalled();
    await click("Import projects and conversations");
    await vi.waitFor(() => expect(mocks.importer).toHaveBeenCalled());
    await act(() => importProps().onDone());
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(imported).not.toHaveBeenCalled();
    expect(mocks.openProject).not.toHaveBeenCalled();
  });

  it("does not dismiss an active import or expose it to a read-only session", async () => {
    mocks.access = "denied";
    await render();
    expect(container.querySelector("button")?.disabled).toBe(true);
    await click("Import projects and conversations");
    expect(mocks.importer).not.toHaveBeenCalled();
    mocks.access = "granted";
    await render();
    await click("Import projects and conversations");
    await act(() => importProps().onImportingChange(true));
    await click("Dismiss");
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    await act(() => importProps().onImportingChange(false));
    await click("Dismiss");
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it("retains the import view when opening fails, then completes only after successful navigation", async () => {
    await render();
    await click("Import projects and conversations");
    mocks.openProject.mockRejectedValueOnce(new Error("offline"));
    let result = true;
    await act(async () => {
      result = await importProps().onDone({ environmentId, projectId });
    });
    expect(result).toBe(false);
    expect(imported).not.toHaveBeenCalled();
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    expect(mocks.toast).toHaveBeenCalledTimes(1);
    await act(async () => {
      result = await importProps().onDone({ environmentId, projectId });
    });
    expect(result).toBe(true);
    expect(imported).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });
});
