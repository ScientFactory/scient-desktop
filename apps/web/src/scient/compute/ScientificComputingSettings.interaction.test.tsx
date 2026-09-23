// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  ComputeLanguageId,
  ComputeToolkitId,
  EnvironmentId,
  type ComputeLanguageRuntimeInventory,
  type ComputeManagedRuntimeStatus,
  type ScientificComputingLanguageSettings,
} from "@t3tools/contracts";

const mocks = vi.hoisted(() => ({
  preferences: {} as Record<string, ScientificComputingLanguageSettings>,
  languages: [] as ComputeLanguageRuntimeInventory[],
  statuses: {} as Record<string, ComputeManagedRuntimeStatus | null>,
  queryErrors: {} as Record<string, string | null>,
  inventoryPending: false,
  revision: 0,
  listeners: new Set<() => void>(),
  saveFails: false,
  releaseFails: false,
  calls: [] as string[],
  update: vi.fn(),
  manage: vi.fn(),
  verify: vi.fn(),
  cancel: vi.fn(),
}));
function notify() {
  mocks.revision++;
  for (const listener of mocks.listeners) listener();
}
vi.mock("@t3tools/client-runtime/state/runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@t3tools/client-runtime/state/runtime")>()),
  squashAtomCommandFailure: (result: { cause: Error }) => result.cause,
}));
vi.mock("~/state/environments", () => ({
  usePrimaryEnvironmentId: () => "local",
  useEnvironment: (id: string) => ({ environmentId: id, label: id }),
}));
vi.mock("~/components/settings/settingsLayout", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/components/settings/settingsLayout")>()),
  SettingsPageContainer: ({ children }: { children: ReactNode }) => <main>{children}</main>,
}));
vi.mock("~/hooks/useSettings", async () => {
  const { useSyncExternalStore } = await import("react");
  return {
    usePrimarySettingsAvailable: () => true,
    useEnvironmentSettings: () => {
      useSyncExternalStore(
        (listener) => {
          mocks.listeners.add(listener);
          return () => {
            mocks.listeners.delete(listener);
          };
        },
        () => mocks.revision,
      );
      return { schemaVersion: 1, languages: mocks.preferences };
    },
  };
});
vi.mock("~/state/server", () => ({ serverEnvironment: { updateSettings: "update" } }));
vi.mock("~/state/compute", () => ({
  computeEnvironment: {
    runtimeInventory: () => ({ kind: "inventory" }),
    managedRuntime: ({ input }: { input: { languageId: string } }) => ({
      kind: "managed",
      languageId: input.languageId,
    }),
    manageRuntime: "manage",
    verifyRuntime: "verify",
    refreshRuntimeInventory: "refresh",
    cancelManagedRuntime: "cancel",
  },
}));
vi.mock("~/state/query", async () => {
  const { useSyncExternalStore } = await import("react");
  return {
    useEnvironmentQuery: (atom: { kind: string; languageId?: string } | null) => {
      useSyncExternalStore(
        (listener) => {
          mocks.listeners.add(listener);
          return () => {
            mocks.listeners.delete(listener);
          };
        },
        () => mocks.revision,
      );
      return {
        data:
          atom?.kind === "inventory"
            ? mocks.inventoryPending
              ? null
              : { languages: mocks.languages }
            : atom?.languageId
              ? (mocks.statuses[atom.languageId] ?? null)
              : null,
        isPending: atom?.kind === "inventory" && mocks.inventoryPending,
        isSuccess: atom?.kind !== "inventory" || !mocks.inventoryPending,
        error: atom?.languageId ? (mocks.queryErrors[atom.languageId] ?? null) : null,
        refresh: vi.fn(),
      };
    },
  };
});
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: (atom: string) =>
    atom === "update"
      ? mocks.update
      : atom === "manage"
        ? mocks.manage
        : atom === "verify"
          ? mocks.verify
          : atom === "cancel"
            ? mocks.cancel
            : vi.fn(async () => ({ _tag: "Success", value: null })),
}));
import { ScientificComputingSettings } from "./ScientificComputingSettings";
import pythonLogo from "~/assets/compute/python.svg";
import matlabLogo from "~/assets/compute/matlab.svg";
import octaveLogo from "~/assets/compute/octave.svg";
import wolframLogo from "~/assets/compute/wolfram.svg";

const managedPath = "/scient/python";
const systemPath = "/system/python";
const automaticRuntimeOption = "scient-runtime:automatic";
function expectCompactAction(node: HTMLButtonElement) {
  expect(node).toHaveAttribute("data-slot", "button");
  expect(node).toHaveAttribute("data-size", "xs");
  expect(node.classList.contains("bg-primary")).toBe(false);
}
const status = (): ComputeManagedRuntimeStatus => ({
  installed: true,
  selection: "managed",
  updateAvailable: false,
  runtimeVersion: "3.12.13",
  toolkitRevision: null,
  generationId: "g1",
  operation: null,
  failureMessage: null,
});
function python(): ComputeLanguageRuntimeInventory {
  return {
    descriptor: {
      languageId: ComputeLanguageId.make("python"),
      displayName: "Python",
      sourceExtensions: [".py"],
      capabilities: [],
    },
    enabled: true,
    configuredExecutable: null,
    managedRuntime: status(),
    toolkits: [],
    failureMessage: null,
    installations: [
      { executable: managedPath, source: "managed", version: "3.12.13", problem: null },
      { executable: systemPath, source: "path", version: null, problem: null },
    ],
  };
}

const pythonToolkits = () =>
  [
    {
      toolkitId: ComputeToolkitId.make("python-data-and-figures"),
      languageId: ComputeLanguageId.make("python"),
      displayName: "Scientific Python",
      summary: "Data and figures.",
      required: true,
      packageRequirements: [{ name: "numpy", displayName: "NumPy", minimumVersion: null }],
    },
    {
      toolkitId: ComputeToolkitId.make("python-image-analysis"),
      languageId: ComputeLanguageId.make("python"),
      displayName: "Image analysis",
      summary: "Scientific images.",
      required: false,
      packageRequirements: [
        { name: "scikit-image", displayName: "scikit-image", minimumVersion: null },
      ],
    },
  ] as ComputeLanguageRuntimeInventory["toolkits"];

describe("Scientific Computing settings interactions", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    mocks.preferences = { python: { enabled: true, executable: "" } };
    mocks.languages = [python()];
    mocks.statuses = { python: status() };
    mocks.queryErrors = {};
    mocks.inventoryPending = false;
    mocks.saveFails = false;
    mocks.releaseFails = false;
    mocks.calls = [];
    mocks.update.mockReset().mockImplementation(async ({ environmentId, input }) => {
      expect(environmentId).toBe("remote");
      mocks.calls.push("save");
      if (mocks.saveFails) return { _tag: "Failure", cause: new Error("Save rejected") };
      mocks.preferences = { ...mocks.preferences, ...input.patch.scientificComputing.languages };
      notify();
      return { _tag: "Success", value: null };
    });
    mocks.manage.mockReset().mockImplementation(async ({ environmentId, input }) => {
      expect(environmentId).toBe("remote");
      mocks.calls.push(input.action);
      if (mocks.releaseFails) return { _tag: "Failure", cause: new Error("Busy operation") };
      const current = mocks.statuses[input.languageId];
      if (current && input.action === "remove") {
        mocks.statuses = {
          ...mocks.statuses,
          [input.languageId]: {
            ...current,
            installed: false,
            selection: "existing",
            runtimeVersion: null,
            toolkitRevision: null,
            generationId: null,
          },
        };
      } else if (current && ["use-managed", "use-existing"].includes(input.action))
        mocks.statuses = {
          ...mocks.statuses,
          [input.languageId]: {
            ...current,
            selection: input.action === "use-managed" ? "managed" : "existing",
          },
        };
      notify();
      return { _tag: "Success", value: mocks.statuses[input.languageId] };
    });
    mocks.verify.mockReset();
    mocks.cancel.mockReset().mockResolvedValue({ _tag: "Success", value: null });
    window.localStorage.clear();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(() => root.unmount());
    vi.useRealTimers();
    container.remove();
    vi.unstubAllGlobals();
  });
  const render = async () => {
    await act(() =>
      root.render(<ScientificComputingSettings environmentId={EnvironmentId.make("remote")} />),
    );
  };
  const runtimeSelect = (languageName = "Python") => {
    const match = container.querySelector<HTMLElement>(
      `[data-slot="select-trigger"][aria-label="Choose ${languageName} runtime"]`,
    );
    expect(match, `Choose ${languageName} runtime`).toBeDefined();
    return match!;
  };
  const runtimeValue = (languageName = "Python") =>
    runtimeSelect(languageName).getAttribute("data-compute-runtime");
  const chooseRuntime = async (path: string, languageName = "Python") => {
    const picker = runtimeSelect(languageName);
    await act(() => picker.click());
    const item = [...document.querySelectorAll<HTMLElement>('[data-slot="select-item"]')].find(
      (node) => node.getAttribute("data-compute-runtime") === path,
    );
    expect(item, `runtime option ${path}`).toBeDefined();
    await act(async () => {
      item!.click();
      await Promise.resolve();
      await Promise.resolve();
    });
  };
  const button = (label: string, scope: ParentNode = container) => {
    const match = [...scope.querySelectorAll<HTMLButtonElement>("button")].find(
      (node) => node.textContent?.trim() === label,
    );
    expect(match, label).toBeDefined();
    return match!;
  };
  const click = async (label: string, scope?: ParentNode) => {
    if (label === "Test") {
      await act(() =>
        container
          .querySelector<HTMLButtonElement>('[aria-label="More Python runtime actions"]')!
          .click(),
      );
      await act(() => menuItem("Test").click());
      return;
    }
    await act(async () => {
      button(label, scope).click();
      await Promise.resolve();
    });
  };
  const openMaintenance = async (languageName: string) => {
    const trigger = container.querySelector<HTMLButtonElement>(
      `[aria-label="More ${languageName} actions"]`,
    );
    expect(trigger, `More ${languageName} actions`).toBeDefined();
    await act(async () => trigger!.click());
  };
  const menuItem = (label: string) => {
    const match = [...document.querySelectorAll<HTMLElement>('[data-slot="menu-item"]')].find(
      (node) => node.textContent?.trim() === label,
    );
    expect(match, label).toBeDefined();
    return match!;
  };
  const clickMenuItem = async (label: string) => {
    await act(async () => menuItem(label).click());
  };

  const installationRow = (executable: string) => {
    const control = [
      ...container.querySelectorAll<HTMLElement>("[data-compute-installation]"),
    ].find((node) => node.dataset.computeInstallation === executable);
    expect(control, executable).toBeDefined();
    return control!.closest<HTMLElement>("[data-slot=settings-row]")!;
  };
  const openInstallation = async (executable: string) => {
    await act(() =>
      installationRow(executable)
        .querySelector<HTMLButtonElement>("[data-slot=menu-trigger]")!
        .click(),
    );
  };

  it("lists every actual installation and keeps custom entry outside the picker", async () => {
    mocks.languages = [
      {
        ...python(),
        installations: [
          ...python().installations,
          { executable: "/opt/other/python", source: "path", version: null, problem: null },
          {
            executable: "/project/.venv/bin/python",
            source: "project",
            version: "3.13.1",
            problem: null,
          },
        ],
      },
    ];
    await render();
    expect(container.querySelectorAll("[data-compute-installation]")).toHaveLength(4);
    expect(installationRow(systemPath).textContent).toContain("System installation");
    expect(installationRow(systemPath).textContent).not.toContain("Default");
    expect(installationRow(managedPath).textContent).toContain("Default");
    expect(installationRow(managedPath).textContent).not.toContain("not selected");
    await act(() => runtimeSelect().click());
    expect(document.querySelectorAll("[data-slot=select-item]")).toHaveLength(5);
    expect(
      [...document.querySelectorAll("[data-slot=select-item]")].some((item) =>
        item.textContent?.includes("Custom executable"),
      ),
    ).toBe(false);
    expect(mocks.verify).not.toHaveBeenCalled();
  });

  it("tests a non-default installation read-only and shares its observed version with the picker", async () => {
    mocks.verify.mockImplementation(async ({ input }) => ({
      _tag: "Success",
      value: {
        profile: { executable: input.executable, languageVersion: "3.14.6" },
        readiness: "ready",
        connection: "verified",
      },
    }));
    await render();
    expect(installationRow(systemPath).textContent).toContain("Version not checked");
    await openInstallation(systemPath);
    expect(menuItem("Copy path")).toBeDefined();
    expect(
      [...document.querySelectorAll("[data-slot=menu-item]")].map((item) =>
        item.textContent?.trim(),
      ),
    ).toEqual(["Test", "Copy path"]);
    await clickMenuItem("Test");
    expect(mocks.verify).toHaveBeenCalledWith({
      environmentId: "remote",
      input: { cwd: null, languageId: "python", executable: systemPath },
    });
    expect(installationRow(systemPath).textContent).toContain("3.14.6");
    expect(installationRow(systemPath).textContent).toContain("Test passed");
    expect(runtimeValue()).toBe(managedPath);
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.manage).not.toHaveBeenCalled();
    await act(() => runtimeSelect().click());
    expect(
      [...document.querySelectorAll("[data-slot=select-item]")].find(
        (item) => item.getAttribute("data-compute-runtime") === systemPath,
      )?.textContent,
    ).toContain("3.14.6");
  });

  it("copies the installation path through the shared clipboard without changing selection", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const spy = vi.spyOn(navigator.clipboard, "writeText").mockImplementation(writeText);
    try {
      await render();
      await openInstallation(systemPath);
      await clickMenuItem("Copy path");
      expect(writeText).toHaveBeenCalledWith(systemPath);
      expect(mocks.update).not.toHaveBeenCalled();
      expect(mocks.manage).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("keeps an unavailable custom installation visible and forgets only its saved reference", async () => {
    const path = "/missing/python";
    mocks.preferences.python = { enabled: true, executable: path };
    mocks.statuses.python = { ...status(), selection: "existing" };
    mocks.languages = [
      {
        ...python(),
        configuredExecutable: path,
        installations: [
          {
            executable: path,
            source: "configured",
            configured: true,
            version: null,
            problem: "Executable not found",
          },
          ...python().installations,
        ],
      },
    ];
    await render();
    expect(runtimeValue()).toBe(path);
    expect(installationRow(path).textContent).toContain("Executable not found");
    await openInstallation(path);
    await clickMenuItem("Forget path");
    expect(mocks.preferences.python?.executable).toBe("");
    expect(mocks.calls).toEqual(["save"]);
    expect(mocks.verify).not.toHaveBeenCalled();
  });

  it("keeps the custom draft and previous default when saving fails", async () => {
    mocks.saveFails = true;
    await render();
    await click("Custom executable");
    const input = container.querySelector<HTMLInputElement>(
      'input[aria-label="Python executable path"]',
    )!;
    await act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
        input,
        "/new/python",
      );
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click("Custom executable");
    await click("Custom executable");
    expect(
      container.querySelector<HTMLInputElement>('input[aria-label="Python executable path"]')!
        .value,
    ).toBe("/new/python");
    expect(mocks.update).not.toHaveBeenCalled();
    await act(() =>
      container
        .querySelector("form")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
    );
    expect(
      container.querySelector<HTMLInputElement>('input[aria-label="Python executable path"]')!
        .value,
    ).toBe("/new/python");
    expect(mocks.preferences.python?.executable).toBe("");
    expect(runtimeValue()).toBe(managedPath);
    expect(mocks.manage).not.toHaveBeenCalled();
  });

  it("identifies Automatic's resolved source without treating it as another installation", async () => {
    mocks.statuses.python = { ...status(), selection: "existing" };
    await render();
    expect(runtimeSelect().textContent).toContain("Automatic · System");
    expect(installationRow(systemPath).textContent).toContain("Default");
    expect(installationRow(managedPath).textContent).not.toContain("Default");
    expect(container.querySelector("#python-runtime")!.textContent).not.toContain("Test");
  });

  it("does not turn a MATLAB installation test into a helper retarget or a default change", async () => {
    const selected = "/MATLAB-A/bin/matlab";
    const other = "/MATLAB-B/bin/matlab";
    const helper = { ...status(), installationExecutable: selected };
    mocks.preferences = { matlab: { enabled: true, executable: selected } };
    mocks.statuses = { matlab: helper };
    mocks.languages = [
      {
        ...python(),
        descriptor: {
          ...python().descriptor,
          languageId: ComputeLanguageId.make("matlab"),
          displayName: "MATLAB",
        },
        configuredExecutable: selected,
        managedRuntime: helper,
        installations: [
          {
            executable: selected,
            source: "conventional",
            configured: true,
            version: "R2026a",
            problem: null,
          },
          { executable: other, source: "conventional", version: "R2025b", problem: null },
        ],
      },
    ];
    mocks.verify.mockResolvedValue({
      _tag: "Success",
      value: { readiness: "ready", connection: "verified" },
    });
    await render();
    await openInstallation(other);
    await clickMenuItem("Test");
    expect(mocks.verify).toHaveBeenCalledWith({
      environmentId: "remote",
      input: { cwd: null, languageId: "matlab", executable: other },
    });
    expect(runtimeValue("MATLAB")).toBe(selected);
    expect(mocks.manage).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
    expect(container.querySelector("#matlab-managed-runtime")!.textContent).toContain(
      "MATLAB connection",
    );
    expect(container.querySelector("#matlab-managed-runtime")!.textContent).not.toContain(
      "Default",
    );
  });

  it("ignores an external runtime test's late metadata after refresh", async () => {
    let finish!: (result: unknown) => void;
    mocks.verify.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await render();
    await openInstallation(systemPath);
    await clickMenuItem("Test");
    await act(() =>
      container
        .querySelector<HTMLButtonElement>('[aria-label="Refresh scientific runtimes"]')!
        .click(),
    );
    await act(async () =>
      finish({
        _tag: "Success",
        value: {
          readiness: "ready",
          connection: "verified",
          profile: { executable: systemPath, languageVersion: "3.14.6" },
        },
      }),
    );
    expect(installationRow(systemPath).textContent).toContain("Version not checked");
    expect(installationRow(systemPath).textContent).not.toContain("Test passed");
    expect(container.textContent).not.toContain("3.14.6");
  });

  it("separates the default policy from installation-local actions without a heading strip", async () => {
    await render();
    expect(container.querySelectorAll("[data-compute-installation]")).toHaveLength(2);
    expect(container.textContent).not.toContain("Installations");
    expect(container.textContent).toContain("Default runtime");
    expect(container.querySelector("[data-compute-summary] button")).toBeNull();
    expect(
      [...container.querySelectorAll("button")].some(
        (node) => node.textContent?.trim() === "Details",
      ),
    ).toBe(false);
    expect(container.textContent).not.toContain("More scientific tools are coming soon");
    expect(container.textContent).toContain("Default runtime");
    expect(container.textContent).toContain("3.12.13");
    expect(container.textContent).toContain("Scient-managed");
    expect(container.querySelectorAll("h3")).toHaveLength(4);
    expect(runtimeValue()).toBe(managedPath);
    expect(
      container
        .querySelector<HTMLButtonElement>('[aria-label="More Python runtime actions"]')!
        .hasAttribute("title"),
    ).toBe(false);
    expect(container.textContent).not.toContain(managedPath);
    expect(container.querySelector("select")).toBeNull();
    expect(
      container.querySelector<HTMLButtonElement>('[aria-label="More Python runtime actions"]')!,
    ).toBeDefined();
    expect(container.querySelector('[aria-label="More Python runtime actions"]')).not.toBeNull();
    expect(container.textContent).not.toContain("Rebuild managed Python");
    expect(container.textContent).not.toContain("Remove managed Python");
    await openMaintenance("Python runtime");
    expect(menuItem("Rebuild").getAttribute("aria-label")).toBe("Rebuild managed Python");
    expect(menuItem("Remove").getAttribute("aria-label")).toBe("Remove managed Python");
  });
  it("renders language rows immediately without offering setup before inventory arrives", async () => {
    mocks.inventoryPending = true;
    await render();
    expect(container.querySelector("h3")?.textContent).toContain("Python");
    expect(container.textContent).toContain("Checking");
    expect(
      [...container.querySelectorAll("button")].some(
        (node) => node.textContent?.trim() === "Set up Python" && !node.disabled,
      ),
    ).toBe(false);
    await act(() => {
      mocks.inventoryPending = false;
      notify();
    });
    expect(container.textContent).toContain("3.12.13");
  });

  it("sets up managed Python beside a working system runtime without switching it", async () => {
    const uninstalled = {
      ...status(),
      installed: false,
      selection: "existing" as const,
      generationId: null,
      runtimeVersion: null,
      toolkitIds: [],
    };
    mocks.preferences.python = { enabled: true, executable: systemPath };
    mocks.statuses.python = uninstalled;
    mocks.languages = [
      {
        ...python(),
        configuredExecutable: systemPath,
        managedRuntime: uninstalled,
        installations: [
          { executable: systemPath, source: "path", version: "3.12.13", problem: null },
        ],
        toolkits: pythonToolkits(),
      },
    ];
    await render();
    const imageToolkit = container.querySelector<HTMLButtonElement>(
      '[aria-label="Download Image analysis"]',
    );
    expect(imageToolkit?.disabled).toBe(true);
    expectCompactAction(button("Set up"));
    await click("Set up");
    expect(mocks.manage).toHaveBeenLastCalledWith({
      environmentId: "remote",
      input: {
        languageId: "python",
        action: "install",
        toolkitIds: ["python-data-and-figures"],
        selectionAfterInstall: "existing",
      },
    });
    expect(mocks.calls).toEqual(["install"]);
    expect(mocks.preferences.python?.executable).toBe(systemPath);
  });

  it("uses the Skills disclosure strip outside its panel, with independent enablement", async () => {
    const matlabPath = "/MATLAB/bin/matlab";
    mocks.preferences = {
      python: { enabled: true, executable: "" },
      matlab: { enabled: true, executable: matlabPath },
    };
    mocks.statuses = { python: status(), matlab: null };
    mocks.languages = [
      python(),
      {
        ...python(),
        descriptor: {
          ...python().descriptor,
          languageId: ComputeLanguageId.make("matlab"),
          displayName: "MATLAB",
          sourceExtensions: [".m"],
        },
        managedRuntime: null,
        configuredExecutable: matlabPath,
        installations: [
          { executable: matlabPath, source: "conventional", version: "R2026a", problem: null },
        ],
      },
    ];
    await render();
    expect(container.querySelector("h2")?.textContent).toContain("Scientific Computing");
    expect(container.textContent).not.toContain("Python & MATLAB");
    expect(container.textContent).not.toContain("Advanced");
    const rows = container.querySelectorAll("[data-slot=settings-row]");
    expect(rows).toHaveLength(4);
    const card = container.querySelector("div.rounded-xl.border");
    expect(card).not.toBeNull();
    expect(card?.className).toContain("bg-card/40");
    expect(card?.querySelectorAll("[data-slot=settings-row]")).toHaveLength(4);
    expect(container.querySelectorAll("[data-compute-installation]")).toHaveLength(2);
    expect(container.querySelector("#python-managed-runtime")?.textContent).toContain("3.12.13");
    expect(container.querySelector("[data-compute-summary='matlab']")).toBeNull();
    const strip = container.querySelector('[aria-label="Scientific computing languages"]')!;
    expect(strip.className).toContain("settings-source-strip");
    expect(card?.contains(strip)).toBe(false);
    const pythonTrigger = strip.querySelector<HTMLButtonElement>(
      "#scientific-computing-python-trigger",
    )!;
    const matlabTrigger = strip.querySelector<HTMLButtonElement>(
      "#scientific-computing-matlab-trigger",
    )!;
    expect(pythonTrigger.getAttribute("aria-expanded")).toBe("true");
    expect(matlabTrigger.getAttribute("aria-expanded")).toBe("false");
    for (const [trigger, language] of [
      [pythonTrigger, "python"],
      [matlabTrigger, "matlab"],
    ] as const) {
      const logo = trigger.querySelector("img")!;
      expect(logo.getAttribute("src")).toBe(language === "python" ? pythonLogo : matlabLogo);
      expect(logo.alt).toBe("");
      expect(logo.width).toBe(24);
      expect(logo.height).toBe(24);
      expect(logo.className).toContain("object-contain");
    }
    expect(pythonTrigger.tabIndex).toBe(0);
    expect(matlabTrigger.tabIndex).toBe(0);
    expect(container.querySelector('[aria-label="Enable Python"]')?.getAttribute("data-size")).toBe(
      "default",
    );
    await act(() => pythonTrigger.click());
    expect(pythonTrigger.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector<HTMLElement>("#scientific-computing-python")?.hidden).toBe(true);
    expect(mocks.calls).toEqual([]);
    await act(() =>
      container.querySelector<HTMLButtonElement>("#scientific-computing-matlab-trigger")!.click(),
    );
    expect(
      container
        .querySelector("#scientific-computing-matlab-trigger")!
        .getAttribute("aria-expanded"),
    ).toBe("true");
    expect(container.querySelector<HTMLElement>("#scientific-computing-matlab")?.hidden).toBe(
      false,
    );
    expect(container.querySelector("#matlab-installation-0")?.textContent).toContain("R2026a");
    expect(mocks.calls).toEqual([]);
  });

  it("shows only Coming soon for preview languages without changing runtime settings", async () => {
    await render();
    for (const [id, logo] of [
      ["julia", "brand"],
      ["r", "brand"],
      ["rust", "brand"],
      ["spss", "brand"],
      ["sql", "symbol"],
      ["octave", octaveLogo],
      ["wolfram", wolframLogo],
      ["stata", "symbol"],
    ] as const) {
      const trigger = container.querySelector<HTMLButtonElement>(
        `#scientific-computing-${id}-trigger`,
      )!;
      expect(trigger.textContent).toContain("Coming soon");
      if (logo === "symbol") {
        expect(trigger.querySelector("img")).toBeNull();
        expect(trigger.querySelector(`[data-language-icon='${id}']`)).not.toBeNull();
      } else {
        const image = trigger.querySelector("img");
        expect(image).not.toBeNull();
        if (logo !== "brand") expect(image?.getAttribute("src")).toBe(logo);
      }
      await act(() => trigger.click());
      const panel = container.querySelector<HTMLElement>(`#scientific-computing-${id}`)!;
      expect(panel.hidden).toBe(false);
      expect(panel.textContent).toBe("Coming soon");
      expect(panel.querySelector("button, input, select")).toBeNull();
      expect(container.querySelector("[data-compute-summary]")).toBeNull();
      await act(() =>
        container.querySelector<HTMLButtonElement>(`#scientific-computing-${id}-trigger`)!.click(),
      );
      expect(container.querySelector<HTMLElement>(`#scientific-computing-${id}`)!.hidden).toBe(
        true,
      );
      await act(() =>
        container.querySelector<HTMLButtonElement>(`#scientific-computing-${id}-trigger`)!.click(),
      );
      expect(container.querySelector<HTMLElement>(`#scientific-computing-${id}`)!.hidden).toBe(
        false,
      );
    }
    expect(mocks.calls).toEqual([]);
    expect(mocks.verify).not.toHaveBeenCalled();
    expect(mocks.manage).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
    await act(() =>
      container.querySelector<HTMLButtonElement>("#scientific-computing-python-trigger")!.click(),
    );
    expect(container.querySelector("[data-compute-summary='python']")).not.toBeNull();
  });

  it("renders Python Toolkits in a separate card that follows the language disclosure", async () => {
    const installed = status();
    const toolkits = pythonToolkits();
    mocks.statuses.python = installed;
    mocks.languages = [{ ...python(), managedRuntime: installed, toolkits }];
    await render();

    const runtimePanel = container.querySelector<HTMLElement>("#scientific-computing-python")!;
    const toolkitSection = container.querySelector<HTMLElement>("#scientific-computing-toolkits")!;
    const toolkitCard = toolkitSection.querySelector<HTMLElement>("[data-source-panel]")!;
    expect(runtimePanel.contains(toolkitSection)).toBe(false);
    expect(runtimePanel.querySelectorAll("[data-slot=settings-row]")).toHaveLength(4);
    expect(toolkitSection.querySelector("h2")?.textContent).toBe("Toolkits");
    expect(toolkitCard.querySelectorAll("[data-slot=settings-row]")).toHaveLength(toolkits.length);

    const pythonTrigger = container.querySelector<HTMLButtonElement>(
      "#scientific-computing-python-trigger",
    )!;
    await act(() => pythonTrigger.click());
    expect(runtimePanel.hidden).toBe(true);
    expect(toolkitSection.hidden).toBe(true);
    await act(() => pythonTrigger.click());
    expect(runtimePanel.hidden).toBe(false);
    expect(toolkitSection.hidden).toBe(false);
  });

  it("downloads each Toolkit immediately without changing runtime selection", async () => {
    const installed = {
      ...status(),
      selection: "existing" as const,
      toolkitIds: [ComputeToolkitId.make("python-data-and-figures")],
    };
    mocks.statuses.python = installed;
    mocks.languages = [{ ...python(), managedRuntime: installed, toolkits: pythonToolkits() }];
    await render();
    expect(container.textContent).not.toContain("Apply changes");
    expect(container.textContent).not.toContain("Discard");
    expect(container.querySelector('[aria-label="Include Image analysis"]')).toBeNull();
    await click("Download");
    expect(mocks.manage).toHaveBeenLastCalledWith({
      environmentId: "remote",
      input: {
        languageId: "python",
        action: "update",
        toolkitIds: ["python-data-and-figures", "python-image-analysis"],
      },
    });
    expect(mocks.statuses.python?.selection).toBe("existing");
    expect(mocks.update).not.toHaveBeenCalled();
    expect(button("Download")).toBeDefined();
  });

  it("removes only the selected Toolkit and keeps all other installed Toolkit ids", async () => {
    const installed = {
      ...status(),
      toolkitIds: ["python-data-and-figures", "python-image-analysis", "python-other"].map((id) =>
        ComputeToolkitId.make(id),
      ),
    };
    mocks.statuses.python = installed;
    mocks.languages = [{ ...python(), managedRuntime: installed, toolkits: pythonToolkits() }];
    await render();
    await act(() =>
      container.querySelector<HTMLButtonElement>('[aria-label="Manage Image analysis"]')!.click(),
    );
    await act(() => menuItem("Remove").click());
    expect(mocks.manage).toHaveBeenLastCalledWith({
      environmentId: "remote",
      input: {
        languageId: "python",
        action: "update",
        toolkitIds: ["python-data-and-figures", "python-other"],
      },
    });
    expect(container.textContent).toContain("Installed");
  });

  it("retries the same per-Toolkit request after a command failure", async () => {
    const installed = {
      ...status(),
      toolkitIds: [ComputeToolkitId.make("python-data-and-figures")],
    };
    mocks.statuses.python = installed;
    mocks.languages = [{ ...python(), managedRuntime: installed, toolkits: pythonToolkits() }];
    mocks.releaseFails = true;
    await render();
    await click("Download");
    expect(container.querySelectorAll('[data-compute-notice="block"]')).toHaveLength(1);
    expect(button("Retry")).toBeDefined();
    mocks.releaseFails = false;
    await act(() => {
      mocks.statuses.python = {
        ...installed,
        toolkitIds: [...installed.toolkitIds, ComputeToolkitId.make("python-other")],
      };
      notify();
    });
    await click("Retry");
    expect(mocks.manage).toHaveBeenLastCalledWith({
      environmentId: "remote",
      input: {
        languageId: "python",
        action: "update",
        toolkitIds: ["python-data-and-figures", "python-other", "python-image-analysis"],
      },
    });
  });

  it.each(["complete", "cancel"] as const)(
    "keeps one Toolkit progress notice across language switches until server %s",
    async (finish) => {
      const installed = {
        ...status(),
        toolkitIds: [ComputeToolkitId.make("python-data-and-figures")],
      };
      mocks.statuses.python = installed;
      mocks.languages = [
        { ...python(), managedRuntime: installed, toolkits: pythonToolkits() },
        {
          ...python(),
          descriptor: {
            ...python().descriptor,
            languageId: ComputeLanguageId.make("matlab"),
            displayName: "MATLAB",
          },
          managedRuntime: null,
          toolkits: [],
          installations: [],
        },
      ];
      mocks.manage.mockImplementation(async () => {
        mocks.statuses.python = {
          ...installed,
          operation: {
            operationId: "toolkit-download",
            action: "update",
            phase: "downloading",
            startedAt: "2026-09-16T00:00:00.000Z",
            downloadedBytes: 1,
            totalBytes: 10,
          },
        };
        notify();
        return { _tag: "Success", value: mocks.statuses.python };
      });
      await render();
      await click("Download");
      expect(container.querySelectorAll('[data-compute-notice="toolbar"]')).toHaveLength(1);
      expect(button("Cancel")).toBeDefined();
      await act(() =>
        container.querySelector<HTMLButtonElement>("#scientific-computing-matlab-trigger")!.click(),
      );
      await act(() =>
        container.querySelector<HTMLButtonElement>("#scientific-computing-python-trigger")!.click(),
      );
      expect(container.querySelectorAll('[data-compute-notice="toolbar"]')).toHaveLength(1);
      expect(container.querySelectorAll('[data-compute-notice="toolbar"]')).toHaveLength(1);
      expect(container.querySelector('[aria-label="Download Image analysis"]')).toBeNull();
      if (finish === "cancel") {
        await click("Cancel");
        expect(mocks.cancel).toHaveBeenCalledWith({
          environmentId: "remote",
          input: { languageId: "python" },
        });
        expect(container.querySelectorAll('[data-compute-notice="toolbar"]')).toHaveLength(1);
      }
      await act(() => {
        mocks.statuses.python =
          finish === "cancel"
            ? installed
            : {
                ...installed,
                generationId: "g2",
                toolkitIds: [
                  ...installed.toolkitIds,
                  ComputeToolkitId.make("python-image-analysis"),
                ],
              };
        notify();
      });
      expect(container.querySelectorAll('[data-compute-notice="toolbar"]')).toHaveLength(0);
      if (finish === "cancel") expect(button("Download").disabled).toBe(false);
      else expect(container.querySelector('[aria-label="Manage Image analysis"]')).not.toBeNull();
      expect(mocks.manage).toHaveBeenCalledOnce();
    },
  );

  it("serializes rapid Toolkit clicks before the command receipt arrives", async () => {
    const installed = {
      ...status(),
      toolkitIds: [ComputeToolkitId.make("python-data-and-figures")],
    };
    mocks.statuses.python = installed;
    mocks.languages = [{ ...python(), managedRuntime: installed, toolkits: pythonToolkits() }];
    let release!: () => void;
    mocks.manage.mockImplementation(async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { _tag: "Success", value: installed };
    });
    await render();
    await act(() => {
      const download = button("Download");
      download.click();
      download.click();
    });
    expect(mocks.manage).toHaveBeenCalledOnce();
    await act(async () => {
      release();
      await Promise.resolve();
    });
    expect(button("Download").disabled).toBe(false);
  });

  it("keeps progress inline and accepts another Toolkit while a build is running", async () => {
    const kits = pythonToolkits();
    const image = kits[1]!;
    const second = {
      ...image,
      toolkitId: ComputeToolkitId.make("python-large-data"),
      displayName: "Large data",
    };
    const installed: ComputeManagedRuntimeStatus = {
      ...status(),
      toolkitIds: [kits[0]!.toolkitId],
      toolkitChanges: [
        { toolkitId: image.toolkitId, install: true, state: "running", error: null },
      ],
      operation: {
        operationId: "build",
        action: "update",
        phase: "installing-packages",
        startedAt: "2026-09-16T00:00:00.000Z",
        downloadedBytes: null,
        totalBytes: null,
      },
    };
    mocks.statuses.python = installed;
    mocks.languages = [{ ...python(), managedRuntime: installed, toolkits: [...kits, second] }];
    await render();
    expect(container.querySelectorAll('[data-compute-notice="block"]')).toHaveLength(0);
    expect(
      container.querySelectorAll('[role="status"][aria-label="Image analysis: Installing…"]'),
    ).toHaveLength(1);
    expect(button("Download").disabled).toBe(false);
    await click("Download");
    expect(mocks.manage).toHaveBeenLastCalledWith({
      environmentId: "remote",
      input: {
        languageId: "python",
        action: "update",
        toolkitChange: { toolkitId: second.toolkitId, action: "install" },
      },
    });
    let finishCancellation!: () => void;
    mocks.manage.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishCancellation = () =>
            resolve({ _tag: "Success", value: { ...installed, toolkitChanges: [] } });
        }),
    );
    const cancelToolkit = container.querySelector<HTMLButtonElement>(
      '[aria-label="Cancel Image analysis"]',
    )!;
    const previousCalls = mocks.manage.mock.calls.length;
    await act(() => {
      cancelToolkit.click();
      cancelToolkit.click();
    });
    expect(mocks.manage).toHaveBeenCalledTimes(previousCalls + 1);
    expect(cancelToolkit.disabled).toBe(true);
    expect(
      container.querySelector('[role="status"][aria-label="Image analysis: Cancelling…"]'),
    ).not.toBeNull();
    expect(mocks.manage).toHaveBeenLastCalledWith({
      environmentId: "remote",
      input: {
        languageId: "python",
        action: "update",
        toolkitChange: { toolkitId: image.toolkitId, action: "cancel" },
      },
    });
    expect(mocks.cancel).not.toHaveBeenCalled();
    await act(() => finishCancellation());
    expect(container.querySelector('[aria-label="Cancel Image analysis"]')).toBeNull();
    expect(container.textContent).toContain("Cancelling…");
    expect(button("Cancel").disabled).toBe(true);
    await act(() => {
      mocks.statuses.python = { ...installed, toolkitChanges: [], operation: null };
      notify();
    });
    expect(container.textContent).not.toContain("Cancelling…");
  });

  it("shows server-owned queued and failed rows on first mount and retries the exact intent", async () => {
    const kits = pythonToolkits();
    const image = kits[1]!;
    const installed: ComputeManagedRuntimeStatus = {
      ...status(),
      toolkitIds: [kits[0]!.toolkitId],
      toolkitChanges: [{ toolkitId: image.toolkitId, install: true, state: "queued", error: null }],
    };
    mocks.statuses.python = installed;
    mocks.languages = [{ ...python(), managedRuntime: installed, toolkits: kits }];
    await render();
    expect(container.textContent).toContain("Queued");
    await act(() => {
      mocks.statuses.python = {
        ...installed,
        toolkitChanges: [
          { toolkitId: image.toolkitId, install: true, state: "failed", error: "Download failed" },
        ],
      };
      notify();
    });
    await click("Retry");
    expect(mocks.manage).toHaveBeenLastCalledWith({
      environmentId: "remote",
      input: {
        languageId: "python",
        action: "update",
        toolkitChange: { toolkitId: image.toolkitId, action: "install" },
      },
    });
  });

  it("accepts rapid different Toolkit clicks without losing or duplicating requests", async () => {
    const kits = pythonToolkits();
    const second = {
      ...kits[1]!,
      toolkitId: ComputeToolkitId.make("python-large-data"),
      displayName: "Large data",
    };
    const installed: ComputeManagedRuntimeStatus = {
      ...status(),
      toolkitIds: [kits[0]!.toolkitId],
      toolkitChanges: [],
    };
    mocks.statuses.python = installed;
    mocks.languages = [{ ...python(), managedRuntime: installed, toolkits: [...kits, second] }];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    mocks.manage.mockImplementation(async () => {
      await gate;
      return { _tag: "Success", value: installed };
    });
    await render();
    await act(() => {
      const first = container.querySelector<HTMLButtonElement>(
        '[aria-label="Download Image analysis"]',
      )!;
      first.click();
      first.click();
      container.querySelector<HTMLButtonElement>('[aria-label="Download Large data"]')!.click();
    });
    expect(mocks.manage).toHaveBeenCalledTimes(2);
    await act(async () => {
      release();
      await gate;
    });
    expect(
      mocks.manage.mock.calls.map(([request]) => request.input.toolkitChange.toolkitId),
    ).toEqual([kits[1]!.toolkitId, second.toolkitId]);
  });

  it("observes setup completion while collapsed and reopens without repeating setup", async () => {
    mocks.statuses.python = {
      ...status(),
      operation: {
        operationId: "python-setup",
        action: "install",
        phase: "verifying",
        startedAt: "2026-09-16T00:00:00.000Z",
        downloadedBytes: null,
        totalBytes: null,
      },
    };
    await render();
    const trigger = container.querySelector<HTMLButtonElement>(
      "#scientific-computing-python-trigger",
    )!;
    await act(() => trigger.click());
    await act(() => {
      mocks.statuses.python = { ...status(), runtimeVersion: "3.12.14", generationId: "g2" };
      notify();
    });
    expect(container.querySelector<HTMLElement>("#scientific-computing-python")?.hidden).toBe(true);
    await act(() => trigger.click());
    expect(container.textContent).toContain("3.12.14");
    expect(mocks.manage).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("shows an inline spinner and clears only successful feedback after four seconds", async () => {
    let finish!: (result: unknown) => void;
    mocks.verify.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await render();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await openInstallation(systemPath);
    await clickMenuItem("Test");
    const row = installationRow(systemPath);
    expect(row.querySelector('[role="status"]')?.textContent).toBe("Testing…");
    expect(row.querySelector('[role="status"] svg')?.classList.contains("animate-spin")).toBe(true);
    await act(async () =>
      finish({
        _tag: "Success",
        value: {
          readiness: "ready",
          connection: "verified",
          profile: { executable: systemPath, languageVersion: "3.14.6" },
        },
      }),
    );
    expect(row.querySelector('[role="status"].text-success')?.textContent).toBe("Test passed");
    expect(row.querySelector('[role="status"] svg')?.getAttribute("aria-hidden")).toBe("true");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_999);
    });
    expect(row.textContent).toContain("Test passed");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(row.textContent).not.toContain("Test passed");
    expect(row.textContent).toContain("3.14.6");
    expect(runtimeValue()).toBe(managedPath);
    await act(() => runtimeSelect().click());
    expect(
      [...document.querySelectorAll("[data-slot=select-item]")].find(
        (item) => item.getAttribute("data-compute-runtime") === systemPath,
      )?.textContent,
    ).toContain("3.14.6");
  });

  it("gives each successful retest its own feedback duration", async () => {
    mocks.verify.mockResolvedValue({
      _tag: "Success",
      value: { readiness: "ready", connection: "verified" },
    });
    await render();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await click("Test");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    await click("Test");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(container.textContent).toContain("Test passed");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    expect(container.textContent).not.toContain("Test passed");
    expect(mocks.verify).toHaveBeenCalledTimes(2);
  });

  it("does not expire failed feedback and keeps its retry available", async () => {
    mocks.verify.mockRejectedValueOnce(new Error("Connection lost"));
    await render();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await click("Test");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(button("Test failed").getAttribute("aria-label")).toContain("Connection lost");
    expect(button("Test failed").disabled).toBe(false);
    mocks.verify.mockResolvedValueOnce({
      _tag: "Success",
      value: { readiness: "ready", connection: "verified" },
    });
    await click("Test failed");
    expect(container.textContent).toContain("Test passed");
    expect(container.textContent).not.toContain("Test failed");
  });

  it("treats Test passed as a started-and-closed session, not a metadata probe", async () => {
    mocks.verify.mockImplementation(async ({ environmentId, input }) => {
      expect(environmentId).toBe("remote");
      mocks.calls.push("verify");
      return {
        _tag: "Success",
        value: {
          profile: {
            languageId: input.languageId,
            source: "managed",
            executable: input.executable,
            languageVersion: "3.12.13",
            architecture: null,
            displayName: "Python",
          },
          readiness: "ready",
          connection: "verified",
          missingRequirements: [],
          packages: [],
          message: "Connection verified. The test session was closed.",
        },
      };
    });
    await render();
    await click("Test");
    expect(mocks.calls).toEqual(["verify"]);
    expect(container.querySelector('[role="status"].text-success')?.textContent).toBe(
      "Test passed",
    );
    expect(mocks.manage).not.toHaveBeenCalled();
    await act(() => {
      mocks.statuses.python = { ...status() };
      notify();
    });
    expect(container.querySelector('[role="status"].text-success')?.textContent).toBe(
      "Test passed",
    );
    await act(() =>
      container
        .querySelector<HTMLButtonElement>('[aria-label="Refresh scientific runtimes"]')!
        .click(),
    );
    expect(container.textContent).not.toContain("Test passed");
    expect(
      container.querySelector<HTMLButtonElement>('[aria-label="More Python runtime actions"]')!,
    ).toBeDefined();
    expect(mocks.verify).toHaveBeenCalledOnce();
    await click("Test");
    expect(container.querySelector('[role="status"].text-success')?.textContent).toBe(
      "Test passed",
    );
    await act(() => {
      mocks.statuses.python = { ...status(), generationId: "replacement-helper" };
      notify();
    });
    expect(container.textContent).not.toContain("Test passed");
    await act(() => {
      mocks.statuses.python = status();
      notify();
    });
    expect(container.textContent).not.toContain("Test passed");
  });

  it("ignores a late test reply after the selected runtime changes and returns", async () => {
    let finish!: (result: unknown) => void;
    mocks.verify.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await render();
    await click("Test");
    await act(() => {
      mocks.statuses.python = { ...status(), generationId: "replacement" };
      notify();
    });
    await act(() => {
      mocks.statuses.python = status();
      notify();
    });
    await act(async () => {
      finish({ _tag: "Success", value: { readiness: "ready", connection: "verified" } });
    });
    expect(container.textContent).not.toContain("Test passed");
    expect(
      container.querySelector<HTMLButtonElement>('[aria-label="More Python runtime actions"]')!
        .disabled,
    ).toBe(false);
  });

  it("recovers from a rejected verification request", async () => {
    mocks.verify.mockRejectedValueOnce(new Error("Connection lost"));
    await render();
    await click("Test");
    expect(button("Test failed").getAttribute("aria-label")).toContain("Connection lost");
    expect(button("Test failed").disabled).toBe(false);
  });

  it("does not treat a Python probe as Test passed or send people to Repair", async () => {
    mocks.verify.mockImplementation(async () => ({
      _tag: "Success",
      value: {
        profile: {
          languageId: "python",
          source: "managed",
          executable: managedPath,
          languageVersion: "3.12.13",
          architecture: null,
          displayName: "Python",
        },
        readiness: "ready",
        missingRequirements: [],
        packages: [],
        message: null,
      },
    }));
    await render();
    await click("Test");
    expect(container.textContent).not.toContain("Test passed");
    expect(button("Test failed").getAttribute("aria-label")).toContain(
      "did not start a test session",
    );
    expect(mocks.manage).not.toHaveBeenCalled();
  });

  it("promotes a helper failure to the MATLAB summary with one recovery action", async () => {
    const matlab = "/MATLAB/bin/matlab";
    const helper = {
      ...status(),
      displayName: "MATLAB connection helper",
      installationExecutable: matlab,
      failureMessage: "ENOENT: uv.lock",
    };
    mocks.preferences = { matlab: { enabled: true, executable: matlab } };
    mocks.statuses = { matlab: helper };
    mocks.languages = [
      {
        ...python(),
        descriptor: {
          ...python().descriptor,
          languageId: ComputeLanguageId.make("matlab"),
          displayName: "MATLAB",
        },
        managedRuntime: helper,
        configuredExecutable: matlab,
        installations: [
          { executable: matlab, source: "conventional", version: "R2026a", problem: null },
        ],
      },
    ];
    await render();
    const summary = container.querySelector("[data-compute-summary='matlab']");
    expect(summary?.textContent).toContain("MATLAB connection failed");
    expect(container.textContent).toContain("ENOENT");
    expect(summary?.textContent).not.toContain("R2026a");
    expect(button("Repair connection")).not.toBeNull();
    expect(container.textContent?.match(/ENOENT/gu)).toHaveLength(1);
    expect(
      container.querySelector("[data-compute-recovery='matlab'] [data-compute-notice]"),
    ).toBeNull();
    expect(container.querySelector("[data-compute-notice]")).not.toBeNull();
  });

  it("replaces the MATLAB installation summary when connection setup fails immediately", async () => {
    const matlab = "/MATLAB/bin/matlab";
    const helper = {
      ...status(),
      installed: false,
      selection: "existing" as const,
      displayName: "MATLAB connection helper",
      installationExecutable: matlab,
    };
    mocks.preferences = { matlab: { enabled: true, executable: matlab } };
    mocks.statuses = { matlab: helper };
    mocks.languages = [
      {
        ...python(),
        descriptor: {
          ...python().descriptor,
          languageId: ComputeLanguageId.make("matlab"),
          displayName: "MATLAB",
        },
        managedRuntime: helper,
        configuredExecutable: matlab,
        installations: [
          { executable: matlab, source: "conventional", version: "R2026a", problem: null },
        ],
      },
    ];
    mocks.releaseFails = true;
    await render();
    expectCompactAction(button("Connect MATLAB"));
    await click("Connect MATLAB");
    expect(container.textContent).toContain("MATLAB connection failed");
    expect(container.textContent).toContain("Busy operation");
    expect(button("Repair connection")).not.toBeNull();
    expectCompactAction(button("Repair connection"));
  });

  it("reports a MATLAB status-query failure without mislabeling the connection", async () => {
    const matlab = "/MATLAB/bin/matlab";
    const helper = {
      ...status(),
      displayName: "MATLAB connection helper",
      installationExecutable: matlab,
    };
    mocks.preferences = { matlab: { enabled: true, executable: matlab } };
    mocks.statuses = { matlab: helper };
    mocks.queryErrors = { matlab: "Status request timed out" };
    mocks.languages = [
      {
        ...python(),
        descriptor: {
          ...python().descriptor,
          languageId: ComputeLanguageId.make("matlab"),
          displayName: "MATLAB",
        },
        managedRuntime: helper,
        configuredExecutable: matlab,
        installations: [
          { executable: matlab, source: "conventional", version: "R2026a", problem: null },
        ],
      },
    ];
    await render();
    expect(container.querySelector("#matlab-installation-0")?.textContent).toContain("R2026a");
    expect(container.textContent).toContain("MATLAB status unavailable");
    expect(container.textContent).not.toContain("MATLAB connection failed");
    expect(() => button("Repair connection")).toThrow();
  });

  it.each(["install", "repair", "remove"] as const)(
    "keeps connection-helper %s progress inline and Enable available",
    async (action) => {
      const matlab = "/MATLAB/bin/matlab";
      const helper = {
        ...status(),
        displayName: "MATLAB connection helper",
        installationExecutable: matlab,
        operation: {
          operationId: "helper-operation",
          action,
          phase: action === "remove" ? ("removing" as const) : ("installing-packages" as const),
          startedAt: "2026-09-14T12:00:00.000Z",
          downloadedBytes: null,
          totalBytes: null,
        },
      };
      mocks.preferences = { matlab: { enabled: true, executable: matlab } };
      mocks.statuses = { matlab: helper };
      mocks.languages = [
        {
          ...python(),
          descriptor: {
            ...python().descriptor,
            languageId: ComputeLanguageId.make("matlab"),
            displayName: "MATLAB",
          },
          managedRuntime: helper,
          configuredExecutable: matlab,
          installations: [
            { executable: matlab, source: "conventional", version: "R2026a", problem: null },
          ],
        },
      ];
      await render();
      expect(
        container.textContent?.match(/(?:Preparing|Removing) MATLAB connection/gu),
      ).toHaveLength(1);
      const managedRow = container.querySelector("#matlab-managed-runtime")!;
      expect(
        managedRow.querySelectorAll('[data-compute-notice="toolbar"] [role="status"]'),
      ).toHaveLength(1);
      expect(managedRow.querySelector('[data-compute-notice="block"]')).toBeNull();
      expect(container.textContent).not.toContain("Installing private Python");
      expect(
        container.querySelector('[aria-label="Enable MATLAB"]')?.closest("[data-compute-recovery]"),
      ).toBeNull();
    },
  );

  it("returns directly to Connect MATLAB after its helper is removed", async () => {
    const matlab = "/MATLAB/bin/matlab";
    const helper = {
      ...status(),
      displayName: "MATLAB connection helper",
      installationExecutable: matlab,
    };
    mocks.preferences = { matlab: { enabled: true, executable: matlab } };
    mocks.statuses = { matlab: helper };
    mocks.languages = [
      {
        ...python(),
        descriptor: {
          ...python().descriptor,
          languageId: ComputeLanguageId.make("matlab"),
          displayName: "MATLAB",
        },
        managedRuntime: helper,
        configuredExecutable: matlab,
        installations: [
          { executable: matlab, source: "conventional", version: "R2026a", problem: null },
        ],
      },
    ];
    await render();
    await openMaintenance("MATLAB connection");
    await clickMenuItem("Remove");
    await click("Remove", document.querySelector<HTMLElement>('[role="alertdialog"]')!);
    await vi.waitFor(() => expect(button("Connect MATLAB")).toBeDefined());
    expect(mocks.calls).toEqual(["remove"]);
    expect(container.textContent?.match(/Preparing MATLAB connection/gu)).toBeNull();
  });

  it("surfaces one update action for an older selected managed toolkit", async () => {
    mocks.statuses.python = { ...status(), updateAvailable: true };
    mocks.languages = [{ ...python(), managedRuntime: mocks.statuses.python }];
    await render();
    expect(container.querySelector("[data-compute-summary='python']")?.textContent).toContain(
      "Toolkit update available",
    );
    expect(
      [...container.querySelectorAll("button")].filter(
        (candidate) => candidate.textContent?.trim() === "Update",
      ),
    ).toHaveLength(1);
    await click("Update");
    expect(mocks.calls).toEqual(["update"]);
  });

  it.each([
    ["python", "managed", true],
    ["python", "existing", true],
    ["python", "existing", false],
    ["matlab", "managed", true],
    ["matlab", "existing", true],
    ["matlab", "existing", false],
  ] as const)(
    "keeps %s updates on the managed row (%s, enabled=%s)",
    async (languageId, selection, enabled) => {
      const matlab = "/MATLAB/bin/matlab";
      const current = {
        ...status(),
        selection,
        updateAvailable: true,
        ...(languageId === "matlab"
          ? { displayName: "MATLAB connection helper", installationExecutable: matlab }
          : {}),
      };
      mocks.preferences = {
        [languageId]: { enabled, executable: languageId === "matlab" ? matlab : systemPath },
      };
      mocks.statuses = { [languageId]: current };
      mocks.languages = [
        {
          ...python(),
          enabled,
          descriptor: {
            ...python().descriptor,
            languageId: ComputeLanguageId.make(languageId),
            displayName: languageId === "matlab" ? "MATLAB" : "Python",
          },
          managedRuntime: current,
          ...(languageId === "matlab"
            ? {
                configuredExecutable: matlab,
                installations: [
                  {
                    executable: matlab,
                    source: "conventional" as const,
                    version: "R2026a",
                    problem: null,
                  },
                ],
              }
            : {}),
        },
      ];
      await render();
      const row = () => container.querySelector(`#${languageId}-managed-runtime`)!;
      expectCompactAction(button("Update", row()));
      expect(button("Update", row()).classList.contains("text-primary")).toBe(true);
      await openMaintenance(languageId === "matlab" ? "MATLAB connection" : "Python runtime");
      expect(
        [...document.querySelectorAll('[data-slot="menu-item"]')].some((item) =>
          item.textContent?.includes("Update"),
        ),
      ).toBe(false);
      // Close the menu before exercising the ordinary row action.
      await act(() =>
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
      );
      await click("Update", row());
      expect(mocks.manage).toHaveBeenCalledWith(
        expect.objectContaining({
          input: expect.objectContaining({ languageId, action: "update" }),
        }),
      );
      await act(() => {
        mocks.statuses[languageId] = {
          ...current,
          operation: {
            operationId: "managed-update",
            action: "update",
            phase: "verifying",
            startedAt: "2026-09-17T00:00:00.000Z",
            downloadedBytes: null,
            totalBytes: null,
          },
        };
        notify();
      });
      expect(row().querySelectorAll('[role="status"]')).toHaveLength(1);
      expect(row().querySelector('[data-compute-notice="toolbar"] [role="status"]')).not.toBeNull();
      expect(row().querySelector('[data-compute-notice="block"] [role="status"]')).toBeNull();
      let acknowledgeCancellation!: () => void;
      mocks.cancel.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            acknowledgeCancellation = () =>
              resolve({ _tag: "Success", value: mocks.statuses[languageId] });
          }),
      );
      const cancelButton = button("Cancel", row());
      await act(() => {
        cancelButton.click();
        cancelButton.click();
      });
      expect(mocks.cancel).toHaveBeenCalledWith(expect.objectContaining({ input: { languageId } }));
      expect(mocks.cancel).toHaveBeenCalledOnce();
      expect(cancelButton.disabled).toBe(true);
      expect(row().textContent).toContain("Cancelling…");
      await act(() => acknowledgeCancellation());
      expect(row().textContent).toContain("Cancelling…");
      expect(button("Cancel", row()).disabled).toBe(true);
      await act(() => {
        mocks.statuses[languageId] = { ...current, updateAvailable: false, generationId: "g2" };
        notify();
      });
      expect(
        [...row().querySelectorAll("button")].some((node) => node.textContent?.trim() === "Update"),
      ).toBe(false);
      expect(row().querySelector('[role="status"]')).toBeNull();
    },
  );

  it("restores cancellation after a failed request and does not mark later operations as cancelling", async () => {
    const running: ComputeManagedRuntimeStatus = {
      ...status(),
      operation: {
        operationId: "first-build",
        action: "update",
        phase: "verifying",
        startedAt: "2026-09-17T00:00:00.000Z",
        downloadedBytes: null,
        totalBytes: null,
      },
    };
    mocks.statuses.python = running;
    mocks.languages = [{ ...python(), managedRuntime: running }];
    mocks.cancel.mockResolvedValueOnce({
      _tag: "Failure",
      cause: new Error("Cancellation request failed"),
    });
    await render();
    await click("Cancel");
    expect(container.textContent).not.toContain("Cancelling…");
    expect(button("Cancel").disabled).toBe(false);
    expect(container.textContent).toContain("Cancellation failed");
    await click("Cancel");
    expect(mocks.cancel).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain("Cancelling…");
    await act(() => {
      mocks.statuses.python = {
        ...running,
        operation: { ...running.operation!, operationId: "second-build" },
      };
      notify();
    });
    expect(container.textContent).not.toContain("Cancelling…");
    expect(button("Cancel").disabled).toBe(false);
    await click("Cancel");
    expect(mocks.cancel).toHaveBeenCalledTimes(3);
  });

  it("selects system Python by saving first and releasing managed precedence exactly once", async () => {
    await render();
    await chooseRuntime(systemPath);
    await chooseRuntime(systemPath);
    expect(mocks.calls).toEqual(["save", "use-existing"]);
    expect(mocks.preferences.python?.executable).toBe(systemPath);
    expect(runtimeValue()).toBe(systemPath);
    expect(mocks.verify).not.toHaveBeenCalled();
  });

  it("keeps enablement and runtime selection usable while packages are being prepared", async () => {
    mocks.statuses.python = {
      ...status(),
      toolkitChanges: [],
      operation: {
        operationId: "background-update",
        action: "update",
        phase: "installing-packages",
        startedAt: "2026-09-16T00:00:00.000Z",
        downloadedBytes: null,
        totalBytes: null,
      },
    };
    mocks.languages = [{ ...python(), managedRuntime: mocks.statuses.python }];
    await render();
    const toggle = container.querySelector<HTMLButtonElement>('[aria-label="Enable Python"]')!;
    expect(toggle.hasAttribute("data-disabled")).toBe(false);
    await chooseRuntime(systemPath);
    expect(mocks.calls).toEqual(["save", "use-existing"]);
    expect(runtimeValue()).toBe(systemPath);
    await act(() => container.querySelector<HTMLElement>('[aria-label="Enable Python"]')!.click());
    expect(mocks.preferences.python?.enabled).toBe(false);
  });

  it("does not switch or release managed Python when saving fails", async () => {
    mocks.saveFails = true;
    await render();
    await chooseRuntime(systemPath);
    expect(mocks.calls).toEqual(["save"]);
    expect(runtimeValue()).toBe(managedPath);
    expect(container.textContent).toContain("Settings were not saved");
  });

  it("keeps the real managed default when release fails and allows retry", async () => {
    mocks.releaseFails = true;
    await render();
    await chooseRuntime(systemPath);
    expect(runtimeValue()).toBe(managedPath);
    expect(container.textContent).toContain("still selected");
    mocks.releaseFails = false;
    await chooseRuntime(systemPath);
    expect(runtimeValue()).toBe(systemPath);
    expect(container.textContent).not.toContain("still selected");
  });

  it("resets automatic discovery without leaving managed precedence active", async () => {
    mocks.preferences.python = { enabled: true, executable: "/old/python" };
    await render();
    await chooseRuntime(automaticRuntimeOption);
    expect(mocks.calls).toEqual(["save", "use-existing"]);
    expect(mocks.preferences.python?.executable).toBe("");
    expect(runtimeValue()).toBe(systemPath);
  });

  it("does not save a custom path on blur or Cancel; saves only on explicit submission", async () => {
    await render();
    await click("Custom executable");
    const input = container.querySelector<HTMLInputElement>(
      'input[aria-label="Python executable path"]',
    )!;
    await act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
        input,
        "/custom/python",
      );
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      input.blur();
    });
    expect(mocks.update).not.toHaveBeenCalled();
    await click("Cancel");
    expect(mocks.update).not.toHaveBeenCalled();
    await click("Custom executable");
    const next = container.querySelector<HTMLInputElement>(
      'input[aria-label="Python executable path"]',
    )!;
    await act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
        next,
        "/custom/python",
      );
      next.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(() =>
      container
        .querySelector("form")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
    );
    expect(mocks.preferences.python?.executable).toBe("/custom/python");
    expect(mocks.calls).toEqual(["save", "use-existing"]);
  });

  it("keeps disabled managed Python removable without falsely saying it needs repair", async () => {
    mocks.preferences.python = { enabled: false, executable: "" };
    mocks.languages = [{ ...python(), enabled: false, installations: [] }];
    await render();
    expect(container.textContent).not.toContain("needs repair");
    await openMaintenance("Python runtime");
    expect(menuItem("Remove").getAttribute("data-disabled")).toBeNull();
    expect(mocks.manage).not.toHaveBeenCalled();
  });

  it("ties helper maintenance to the selected MATLAB, not an inventory of rows", async () => {
    const a = "/MATLAB-A/bin/matlab";
    const b = "/MATLAB-B/bin/matlab";
    const helper = {
      ...status(),
      displayName: "MATLAB connection helper",
      installationExecutable: a,
    };
    mocks.preferences = { matlab: { enabled: true, executable: b } };
    mocks.statuses = { matlab: helper };
    mocks.languages = [
      {
        ...python(),
        descriptor: {
          ...python().descriptor,
          languageId: ComputeLanguageId.make("matlab"),
          displayName: "MATLAB",
        },
        managedRuntime: helper,
        configuredExecutable: b,
        installations: [
          { executable: a, source: "conventional", version: "R2025b", problem: null },
          {
            executable: b,
            source: "conventional",
            version: "R2026a",
            problem: null,
            configured: true,
          },
        ],
      },
    ];
    await render();
    expect(container.textContent).toContain("Set up connection");
    await openMaintenance("MATLAB connection");
    expect(menuItem("Remove").getAttribute("aria-label")).toBe("Remove MATLAB connection helper");
    expect(document.body.textContent).not.toContain("Rebuild connection");
    await openMaintenance("MATLAB connection");
    await chooseRuntime(a, "MATLAB");
    expect(mocks.calls).toEqual(["save"]);
    expect(container.textContent).not.toContain("Set up connection");
    await openMaintenance("MATLAB connection");
    expect(menuItem("Rebuild").getAttribute("aria-label")).toBe("Rebuild MATLAB connection");
  });

  it("repairs a helper for the newly selected MATLAB instead of activating a stale helper", async () => {
    const previousMatlab = "/MATLAB-A/bin/matlab";
    const selectedMatlab = "/MATLAB-B/bin/matlab";
    const helper = {
      ...status(),
      displayName: "MATLAB connection helper",
      installationExecutable: previousMatlab,
      selection: "existing" as const,
    };
    mocks.preferences = { matlab: { enabled: true, executable: selectedMatlab } };
    mocks.statuses = { matlab: helper };
    mocks.languages = [
      {
        ...python(),
        descriptor: {
          ...python().descriptor,
          languageId: ComputeLanguageId.make("matlab"),
          displayName: "MATLAB",
        },
        managedRuntime: helper,
        configuredExecutable: selectedMatlab,
        installations: [
          {
            executable: selectedMatlab,
            source: "conventional",
            version: "R2026a",
            problem: null,
          },
        ],
      },
    ];
    await render();
    await openMaintenance("MATLAB connection");
    await clickMenuItem("Set up Scient connection");
    expect(mocks.calls).toEqual(["repair"]);
    expect(mocks.calls).not.toContain("use-managed");
  });

  it("promotes a mismatched active MATLAB connection to the main row", async () => {
    const previousMatlab = "/MATLAB-A/bin/matlab";
    const selectedMatlab = "/MATLAB-B/bin/matlab";
    const helper = {
      ...status(),
      displayName: "MATLAB connection helper",
      installationExecutable: previousMatlab,
    };
    mocks.preferences = { matlab: { enabled: true, executable: selectedMatlab } };
    mocks.statuses = { matlab: helper };
    mocks.languages = [
      {
        ...python(),
        descriptor: {
          ...python().descriptor,
          languageId: ComputeLanguageId.make("matlab"),
          displayName: "MATLAB",
        },
        managedRuntime: helper,
        configuredExecutable: selectedMatlab,
        installations: [
          {
            executable: selectedMatlab,
            source: "conventional",
            version: "R2026a",
            problem: null,
          },
        ],
      },
    ];
    await render();
    expect(container.textContent).toContain("Connection needs update");
    expectCompactAction(button("Set up connection"));
    await click("Set up connection");
    expect(mocks.calls).toEqual(["repair"]);
  });

  it("requires confirmation before removal and keeps cancellation non-mutating", async () => {
    await render();
    await openMaintenance("Python runtime");
    await clickMenuItem("Remove");
    expect(mocks.manage).not.toHaveBeenCalled();
    const dialog = document.querySelector<HTMLElement>('[role="alertdialog"]')!;
    expect(dialog.textContent).toContain(
      "System installations and project environments are untouched",
    );
    await click("Cancel", dialog);
    expect(mocks.manage).not.toHaveBeenCalled();
    await openMaintenance("Python runtime");
    await clickMenuItem("Remove");
    await click("Remove", document.querySelector<HTMLElement>('[role="alertdialog"]')!);
    expect(mocks.calls).toEqual(["remove"]);
  });

  it("keeps repair reachable for a missing managed executable", async () => {
    mocks.languages = [
      {
        ...python(),
        installations: [
          {
            executable: managedPath,
            source: "managed",
            version: "3.12.13",
            problem: "Scient-managed Python needs repair.",
          },
        ],
      },
    ];
    await render();
    expect(button("Repair").disabled).toBe(false);
    expect(
      [...container.querySelectorAll("button")].filter(
        (candidate) => candidate.textContent?.trim() === "Repair",
      ),
    ).toHaveLength(1);
    expect(container.textContent).toContain("needs repair");
    expect(mocks.manage).not.toHaveBeenCalled();
  });

  it("survives repeated changes between managed and existing Python without duplicate mutations", async () => {
    await render();
    for (let n = 0; n < 25; n++) {
      await chooseRuntime(systemPath);
      expect(runtimeValue()).toBe(systemPath);
      await chooseRuntime(managedPath);
      expect(runtimeValue()).toBe(managedPath);
    }
    expect(mocks.calls).toEqual(
      Array.from({ length: 25 }, () => ["save", "use-existing", "use-managed"]).flat(),
    );
    expect(mocks.verify).not.toHaveBeenCalled();
  });
});
