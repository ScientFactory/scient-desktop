import {
  ComputeLanguageId,
  ComputeSessionId,
  EnvironmentId,
  type ComputeLanguageRuntimeInspection,
} from "@t3tools/contracts";
import type { ComponentProps, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  languages: [] as ComputeLanguageRuntimeInspection[],
  buttons: [] as Array<ComponentProps<"button">>,
  start: vi.fn(),
  submit: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock("~/state/compute", () => ({
  computeEnvironment: {
    sessions: () => "sessions",
    events: () => "events",
    runtimes: () => "runtimes",
    startSession: "start",
    submitExecution: "submit",
    refreshRuntimes: "refresh",
    stopSession: "stop",
  },
}));
vi.mock("~/state/query", () => ({
  useEnvironmentQuery: (query: string) => ({
    data: query === "runtimes" ? { languages: mocks.languages } : query === "sessions" ? [] : null,
    isPending: false,
    error: null,
    refresh: vi.fn(),
  }),
}));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: (command: string) =>
    command === "start" ? mocks.start : command === "submit" ? mocks.submit : mocks.refresh,
}));
vi.mock("~/components/ui/button", () => ({
  Button: (props: ComponentProps<"button">) => {
    mocks.buttons.push(props);
    return <button disabled={props.disabled}>{props.children}</button>;
  },
}));
vi.mock("~/components/ui/alert-dialog", () => ({
  AlertDialog: () => null,
  AlertDialogClose: () => null,
  AlertDialogDescription: () => null,
  AlertDialogFooter: () => null,
  AlertDialogHeader: () => null,
  AlertDialogPopup: () => null,
  AlertDialogTitle: () => null,
}));
vi.mock("~/components/ui/menu", () => ({
  Menu: ({ children }: { children: ReactNode }) => <>{children}</>,
  MenuTrigger: () => null,
  MenuPopup: () => null,
  MenuItem: () => null,
  MenuSeparator: () => null,
}));

import { PythonFileComputeActions } from "./PythonFileComputeActions";

function runtime(
  source: "managed" | "path",
  ready = true,
): ComputeLanguageRuntimeInspection["runtimes"][number] {
  const profile = {
    languageId: ComputeLanguageId.make("python"),
    executable: `/${source}/python`,
    languageVersion: "3.12.13",
    architecture: null,
    displayName: "Python",
    source,
  };
  return {
    profile,
    verification: {
      profile,
      readiness: ready ? "ready" : "missing-requirement",
      missingRequirements: ready ? [] : ["ipykernel"],
      message: null,
      packages: [],
    },
    toolkits: [],
  };
}
function render(candidates = [runtime("managed")]) {
  mocks.languages = [
    {
      descriptor: {
        languageId: ComputeLanguageId.make("python"),
        displayName: "Python",
        sourceExtensions: [".py"],
        capabilities: [],
      },
      enabled: true,
      configuredExecutable: null,
      managedRuntime: null,
      toolkits: [],
      runtimes: candidates,
    },
  ];
  renderToStaticMarkup(
    <PythonFileComputeActions
      environmentId={EnvironmentId.make("remote-server")}
      cwd="/project"
      relativePath="test.py"
      contents="print(1)"
      sourceRevision="revision-1"
      sourcePending={false}
      selection={null}
      editorSelection={null}
      onExecutionSubmitted={vi.fn()}
    />,
  );
  return mocks.buttons.find((button) => button["aria-label"] === "Run file")!;
}

describe("Python file run actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.buttons = [];
    mocks.start.mockResolvedValue({
      _tag: "Success",
      value: { sessionId: ComputeSessionId.make("new-session"), generation: 1 },
    });
    mocks.submit.mockResolvedValue({ _tag: "Success", value: {} });
  });

  it("resolves the current default on the correct server instead of pinning a cached executable", async () => {
    const button = render();
    expect(button.disabled).toBe(false);
    // Invoke the real event handler without launching a browser or executing Python.
    button.onClick?.({} as Parameters<NonNullable<typeof button.onClick>>[0]);
    await vi.waitFor(() => expect(mocks.submit).toHaveBeenCalledOnce());
    expect(mocks.start).toHaveBeenCalledWith({
      environmentId: "remote-server",
      input: {
        cwd: "/project",
        sessionId: expect.any(String),
        languageId: "python",
        executable: null,
      },
    });
    expect(mocks.submit.mock.calls[0]?.[0].input).toMatchObject({
      sessionId: "new-session",
      code: "print(1)",
    });
  });

  it("disables ordinary Run when selected managed Python is unusable despite another ready Python", () => {
    expect(render([runtime("managed", false), runtime("path")]).disabled).toBe(true);
    expect(mocks.start).not.toHaveBeenCalled();
  });
});
