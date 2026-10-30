import {
  render as _fixtureRender,
  type Screen,
  fakeTimers as _fixtureFakeTimers,
  act,
} from "../../../test/render";
import { type ReactNode } from "react";

import { describe, expect, it, vi } from "vite-plus/test";
import {
  AuthSettingsWriteScope,
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
  hostKey: null as string | null,
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
vi.mock("~/state/environments", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/state/environments")>()),
  usePrimaryEnvironmentId: () => "local",
  usePrimaryEnvironment: () => ({ environmentId: "local", label: "local" }),
  useEnvironment: (id: string) => ({ environmentId: id, label: id }),
}));
vi.mock("~/state/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/state/session")>()),
  // These interactions exercise a connected machine with settings-write permission.
  useEnvironmentScope: (id: EnvironmentId, scope: string) =>
    id === "local" && scope === AuthSettingsWriteScope,
  useEnvironmentsWithScope: (
    environments: ReadonlyArray<{ readonly environmentId: EnvironmentId }>,
    scope: string,
  ) =>
    new Set(
      environments
        .filter(
          ({ environmentId }) => environmentId === "local" && scope === AuthSettingsWriteScope,
        )
        .map(({ environmentId }) => environmentId),
    ),
  readEnvironmentScope: (id: EnvironmentId, scope: string) =>
    id === "local" && scope === AuthSettingsWriteScope,
}));
vi.mock("~/components/settings/settingsLayout", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/components/settings/settingsLayout")>()),
  SettingsPageContainer: ({ children }: { children: ReactNode }) => <main>{children}</main>,
}));
vi.mock("~/hooks/useSettings", async (importOriginal) => {
  const original = await importOriginal<typeof import("~/hooks/useSettings")>();
  const { useSyncExternalStore } = await import("react");
  return {
    ...original,
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
vi.mock("~/state/server", async (importOriginal) => {
  const original = await importOriginal<typeof import("~/state/server")>();
  return {
    ...original,
    serverEnvironment: { ...original.serverEnvironment, updateSettings: "update" },
  };
});
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
vi.mock("~/state/query", async (importOriginal) => {
  const { useSyncExternalStore } = await import("react");
  return {
    ...(await importOriginal<typeof import("~/state/query")>()),
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
              : { languages: mocks.languages, ...(mocks.hostKey ? { hostKey: mocks.hostKey } : {}) }
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
// The pages link to each other; these tests check the address, not the navigation.
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  Link: ({
    to,
    params,
    search: _search,
    children,
    ...props
  }: {
    to: string;
    params?: Record<string, string>;
    search?: unknown;
    children?: ReactNode;
  }) => (
    <a
      href={to.replace(/\$([A-Za-z]+)/g, (_match, key: string) =>
        encodeURIComponent(params?.[key] ?? ""),
      )}
      {...props}
    >
      {children}
    </a>
  ),
}));
import { ComputeLanguagePage } from "./ComputeLanguagePage";
import { ScientificComputingSettings } from "./ScientificComputingSettings";

const managedPath = "/scient/python";
const systemPath = "/system/python";
const automaticRuntimeOption = "scient-runtime:automatic";
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

/** Another language on this computer, to move away from Python and back. */
const matlabHere = (): ComputeLanguageRuntimeInventory => ({
  ...python(),
  descriptor: {
    ...python().descriptor,
    languageId: ComputeLanguageId.make("matlab"),
    displayName: "MATLAB",
  },
  managedRuntime: null,
  toolkits: [],
  installations: [
    { executable: "/MATLAB/bin/matlab", source: "conventional", version: "R2026a", problem: null },
  ],
});

describe("Scientific Computing settings interactions", () => {
  async function _setupFixture0(_fixture: _Fixture) {
    mocks.preferences = { python: { enabled: true, executable: "" } };
    mocks.languages = [python()];
    mocks.statuses = { python: status() };
    mocks.queryErrors = {};
    mocks.inventoryPending = false;
    mocks.hostKey = null;
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
    _fixture.container = document.createElement("div");
    document.body.append(_fixture.container);
    _fixture.root0 = _fixture.stack.use(
      await _fixtureRender(null, { container: _fixture.container, router: false }),
    );
  }
  async function _cleanupFixture1(_fixture: _Fixture) {
    await act(async () => await _fixture.root0.unmount());
    vi.useRealTimers();
    _fixture.container.remove();
    vi.unstubAllGlobals();
  }
  /** One language's page, as opened from the overview. */
  const render = async (_fixture: _Fixture, languageId = "python") => {
    await act(
      async () =>
        await _fixture.root0.rerender(
          <ComputeLanguagePage
            languageId={languageId}
            environmentId={EnvironmentId.make("remote")}
          />,
        ),
    );
  };
  /** Every language at a glance. */
  const renderOverview = async (_fixture: _Fixture) => {
    await act(
      async () =>
        await _fixture.root0.rerender(
          <ScientificComputingSettings environmentId={EnvironmentId.make("remote")} />,
        ),
    );
  };
  const runtimeSelect = (_fixture: _Fixture, languageName = "Python") => {
    const match = _fixture.container.querySelector<HTMLElement>(
      `[data-slot="select-trigger"][aria-label="Choose ${languageName} runtime"]`,
    );
    expect(match, `Choose ${languageName} runtime`).toBeDefined();
    return match!;
  };
  const runtimeValue = (_fixture: _Fixture, languageName = "Python") =>
    runtimeSelect(_fixture, languageName).getAttribute("data-compute-runtime");
  const chooseRuntime = async (_fixture: _Fixture, path: string, languageName = "Python") => {
    const picker = runtimeSelect(_fixture, languageName);
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
  const button = (_fixture: _Fixture, label: string, scope: ParentNode = _fixture.container) => {
    const match = [...scope.querySelectorAll<HTMLButtonElement>("button")].find(
      (node) => node.textContent?.trim() === label,
    );
    expect(match, label).toBeDefined();
    return match!;
  };
  const click = async (_fixture: _Fixture, label: string, scope?: ParentNode) => {
    await act(async () => {
      button(_fixture, label, scope).click();
      await Promise.resolve();
    });
  };
  const openMaintenance = async (_fixture: _Fixture, languageName: string) => {
    const trigger = _fixture.container.querySelector<HTMLButtonElement>(
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

  const installationRow = (_fixture: _Fixture, executable: string) => {
    const control = [
      ..._fixture.container.querySelectorAll<HTMLElement>("[data-compute-installation]"),
    ].find((node) => node.dataset.computeInstallation === executable);
    expect(control, executable).toBeDefined();
    return control!.closest<HTMLElement>("[data-slot=settings-row]")!;
  };
  const openFound = async (_fixture: _Fixture, languageId = "python") => {
    const toggle = _fixture.container.querySelector<HTMLButtonElement>(
      `#${languageId}-found [aria-controls="${languageId}-found-list"]`,
    );
    expect(toggle, `${languageId} found on this computer`).toBeDefined();
    if (toggle!.getAttribute("aria-expanded") !== "true") await act(() => toggle!.click());
  };
  const closeFound = async (_fixture: _Fixture, languageId = "python") => {
    const toggle = _fixture.container.querySelector<HTMLButtonElement>(
      `#${languageId}-found [aria-controls="${languageId}-found-list"]`,
    )!;
    if (toggle.getAttribute("aria-expanded") === "true") await act(() => toggle.click());
  };
  /** The Runtime row's Test, shown once the language is ready. */
  const testRuntime = async (_fixture: _Fixture, languageName = "Python") => {
    const test = _fixture.container.querySelector<HTMLButtonElement>(
      `[aria-label="Test ${languageName}"]`,
    );
    expect(test, `Test ${languageName}`).toBeDefined();
    await act(async () => {
      test!.click();
      await Promise.resolve();
    });
  };
  /** A found installation's own Test. */
  const testInstallation = async (_fixture: _Fixture, executable: string) => {
    const test = installationRow(_fixture, executable).querySelector<HTMLButtonElement>(
      'button[aria-label^="Test "]',
    );
    expect(test, `Test ${executable}`).toBeDefined();
    await act(async () => {
      test!.click();
      await Promise.resolve();
    });
  };
  const typePath = async (_fixture: _Fixture, value: string, languageName = "Python") => {
    const input = _fixture.container.querySelector<HTMLInputElement>(
      `input[aria-label="${languageName} executable path"]`,
    )!;
    await act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    return input;
  };
  const openInstallation = async (_fixture: _Fixture, executable: string) => {
    await act(() =>
      installationRow(_fixture, executable)
        .querySelector<HTMLButtonElement>("[data-slot=menu-trigger]")!
        .click(),
    );
  };

  it("lists every actual installation and keeps custom entry outside the picker", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

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
    await render(_fixture);
    expect(_fixture.container.querySelector("#python-installation-0")).toBeNull();
    expect(
      _fixture.container.querySelector('[aria-label="3 found on this computer"]'),
    ).not.toBeNull();
    await openFound(_fixture);
    // Scient's own Python plus every runtime found on this computer.
    expect(_fixture.container.querySelectorAll("[data-compute-installation]")).toHaveLength(4);
    expect(installationRow(_fixture, systemPath).textContent).toContain("System");
    expect(installationRow(_fixture, systemPath).textContent).toContain(systemPath);
    expect(installationRow(_fixture, systemPath).textContent).not.toContain("In use");
    expect(runtimeValue(_fixture)).toBe(managedPath);
    await act(() => runtimeSelect(_fixture).click());
    expect(document.querySelectorAll("[data-slot=select-item]")).toHaveLength(5);
    expect(
      [...document.querySelectorAll("[data-slot=select-item]")].some((item) =>
        item.textContent?.includes("Custom path"),
      ),
    ).toBe(false);
    expect(mocks.verify).not.toHaveBeenCalled();
  });

  it("tests a non-default installation read-only and shares its observed version with the picker", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    mocks.verify.mockImplementation(async ({ input }) => ({
      _tag: "Success",
      value: {
        profile: { executable: input.executable, languageVersion: "3.14.6" },
        readiness: "ready",
        connection: "verified",
      },
    }));
    await render(_fixture);
    await openFound(_fixture);
    expect(installationRow(_fixture, systemPath).textContent).not.toContain("3.14.6");
    await openInstallation(_fixture, systemPath);
    expect(
      [...document.querySelectorAll("[data-slot=menu-item]")].map((item) =>
        item.textContent?.trim(),
      ),
    ).toEqual(["Copy path"]);
    await act(() =>
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
    );
    await testInstallation(_fixture, systemPath);
    expect(mocks.verify).toHaveBeenCalledWith({
      environmentId: "remote",
      input: { cwd: null, languageId: "python", executable: systemPath },
    });
    expect(installationRow(_fixture, systemPath).textContent).toContain("3.14.6");
    expect(installationRow(_fixture, systemPath).textContent).toContain("Test passed");
    expect(runtimeValue(_fixture)).toBe(managedPath);
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.manage).not.toHaveBeenCalled();
    await act(() => runtimeSelect(_fixture).click());
    expect(
      [...document.querySelectorAll("[data-slot=select-item]")].find(
        (item) => item.getAttribute("data-compute-runtime") === systemPath,
      )?.textContent,
    ).toContain("3.14.6");
  });

  it("copies the installation path through the shared clipboard without changing selection", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const writeText = vi.fn().mockResolvedValue(undefined);
    const spy = vi.spyOn(navigator.clipboard, "writeText").mockImplementation(writeText);
    try {
      await render(_fixture);
      await openFound(_fixture);
      await openInstallation(_fixture, systemPath);
      await clickMenuItem("Copy path");
      expect(writeText).toHaveBeenCalledWith(systemPath);
      expect(mocks.update).not.toHaveBeenCalled();
      expect(mocks.manage).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("keeps an unavailable custom installation visible and forgets only its saved reference", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

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
    await render(_fixture);
    expect(runtimeValue(_fixture)).toBe(path);
    await openFound(_fixture);
    expect(installationRow(_fixture, path).textContent).toContain("Executable not found");
    expect(installationRow(_fixture, path).querySelector('button[aria-label^="Test "]')).toBeNull();
    await openInstallation(_fixture, path);
    await clickMenuItem("Forget path");
    expect(mocks.preferences.python?.executable).toBe("");
    expect(mocks.calls).toEqual(["save"]);
    expect(mocks.verify).not.toHaveBeenCalled();
  });

  it("shows and forgets only this machine's choice", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const path = "/opt/conda/envs/lab/bin/python";
    mocks.hostKey = "host-a";
    mocks.preferences.python = {
      enabled: true,
      executable: "",
      selections: { "host-a": path, "host-b": "/other/python" },
    };
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
            problem: null,
          },
          ...python().installations,
        ],
      },
    ];
    await render(_fixture);
    expect(runtimeValue(_fixture)).toBe(path);
    await openFound(_fixture);
    expect(installationRow(_fixture, path).textContent).toContain("In use");
    await openInstallation(_fixture, path);
    await clickMenuItem("Forget path");
    expect(mocks.preferences.python).toEqual({
      enabled: true,
      executable: "",
      selections: { "host-a": "" },
    });
  });

  it("keeps the custom draft and previous default when saving fails", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    mocks.saveFails = true;
    await render(_fixture);
    await openFound(_fixture);
    await typePath(_fixture, "/new/python");
    await closeFound(_fixture);
    expect(
      _fixture.container.querySelector('input[aria-label="Python executable path"]'),
    ).toBeNull();
    await openFound(_fixture);
    expect(
      _fixture.container.querySelector<HTMLInputElement>(
        'input[aria-label="Python executable path"]',
      )!.value,
    ).toBe("/new/python");
    expect(mocks.update).not.toHaveBeenCalled();
    await click(_fixture, "Use", _fixture.container.querySelector("#python-custom-executable")!);
    expect(
      _fixture.container.querySelector<HTMLInputElement>(
        'input[aria-label="Python executable path"]',
      )!.value,
    ).toBe("/new/python");
    expect(mocks.preferences.python?.executable).toBe("");
    expect(runtimeValue(_fixture)).toBe(managedPath);
    expect(mocks.manage).not.toHaveBeenCalled();
  });

  it("identifies Automatic's resolved source without treating it as another installation", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    mocks.statuses.python = { ...status(), selection: "existing" };
    await render(_fixture);
    expect(runtimeSelect(_fixture).textContent).toContain("Automatic · System");
    await openFound(_fixture);
    expect(installationRow(_fixture, systemPath).textContent).toContain("In use");
    expect(installationRow(_fixture, managedPath).textContent).not.toContain("In use");
    expect(
      _fixture.container.querySelectorAll("#python-found-list [data-compute-installation]"),
    ).toHaveLength(1);
  });

  it("does not turn a MATLAB installation test into a helper retarget or a default change", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

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
    await render(_fixture, "matlab");
    await openFound(_fixture, "matlab");
    await testInstallation(_fixture, other);
    expect(mocks.verify).toHaveBeenCalledWith({
      environmentId: "remote",
      input: { cwd: null, languageId: "matlab", executable: other },
    });
    expect(runtimeValue(_fixture, "MATLAB")).toBe(selected);
    expect(mocks.manage).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
    expect(installationRow(_fixture, selected).textContent).toContain("In use");
    expect(installationRow(_fixture, other).textContent).not.toContain("In use");
    expect(_fixture.container.querySelector("#matlab-managed-runtime")!.textContent).toContain(
      "MATLAB connection",
    );
    expect(_fixture.container.querySelector("#matlab-managed-runtime")!.textContent).not.toContain(
      "In use",
    );
  });

  it("ignores an external runtime test's late metadata after refresh", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    let finish!: (result: unknown) => void;
    mocks.verify.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await render(_fixture);
    await openFound(_fixture);
    await testInstallation(_fixture, systemPath);
    await act(() =>
      _fixture.container
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
    expect(installationRow(_fixture, systemPath).textContent).toContain("Python · System");
    expect(installationRow(_fixture, systemPath).textContent).not.toContain("Test passed");
    expect(_fixture.container.textContent).not.toContain("3.14.6");
  });

  it("renders language rows immediately without offering setup before inventory arrives", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    mocks.inventoryPending = true;
    const offersSetup = () =>
      [..._fixture.container.querySelectorAll("button")].some(
        (node) => node.textContent?.trim() === "Set up" && !node.disabled,
      );
    await renderOverview(_fixture);
    const row = () =>
      _fixture.container.querySelector<HTMLElement>('li[data-compute-language="python"]');
    expect(row()?.textContent).toContain("Python");
    expect(row()?.textContent).toContain("Checking");
    expect(offersSetup()).toBe(false);
    await render(_fixture);
    expect(_fixture.container.textContent).toContain("Checking");
    expect(offersSetup()).toBe(false);
    await act(() => {
      mocks.inventoryPending = false;
      notify();
    });
    expect(_fixture.container.textContent).toContain("3.12.13");
    await renderOverview(_fixture);
    expect(row()?.textContent).toContain("3.12.13 · Scient-managed");
  });

  it("sets up managed Python beside a working system runtime without switching it", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

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
    await render(_fixture);
    // Toolkits belong to Scient-managed Python, so they wait until it is set up.
    expect(_fixture.container.querySelector("#scientific-computing-toolkits")).toBeNull();
    expect(_fixture.container.querySelector('[aria-label="Download Image analysis"]')).toBeNull();
    await click(_fixture, "Set up", _fixture.container.querySelector("#python-runtime")!);
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

  it("lets Scient-managed Python become the default when set up from Automatic", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const uninstalled = {
      ...status(),
      installed: false,
      selection: "existing" as const,
      generationId: null,
      runtimeVersion: null,
      toolkitIds: [],
    };
    mocks.statuses.python = uninstalled;
    mocks.languages = [
      {
        ...python(),
        managedRuntime: uninstalled,
        installations: [
          { executable: systemPath, source: "path", version: "3.12.13", problem: null },
        ],
        toolkits: pythonToolkits(),
      },
    ];
    await render(_fixture);
    await click(_fixture, "Set up", _fixture.container.querySelector("#python-runtime")!);
    expect(mocks.manage).toHaveBeenLastCalledWith({
      environmentId: "remote",
      input: {
        languageId: "python",
        action: "install",
        toolkitIds: ["python-data-and-figures"],
      },
    });
    expect(mocks.calls).toEqual(["install"]);
    expect(mocks.preferences.python?.executable).toBe("");
  });

  it("opens each language on its own page, with independent enablement", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

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
    // The overview links each language to its own page; nothing is switched in place.
    await renderOverview(_fixture);
    expect(
      _fixture.container
        .querySelector('li[data-compute-language="python"] a')
        ?.getAttribute("href"),
    ).toBe("/settings/scientific-computing/python");
    expect(
      _fixture.container
        .querySelector('li[data-compute-language="matlab"] a')
        ?.getAttribute("href"),
    ).toBe("/settings/scientific-computing/matlab");
    expect(_fixture.container.querySelector("#scientific-computing-python")).toBeNull();
    expect(mocks.calls).toEqual([]);
    await render(_fixture);
    expect(_fixture.container.querySelector('[id$="-trigger"]')).toBeNull();
    await openFound(_fixture);
    expect(_fixture.container.querySelectorAll("[data-compute-installation]")).toHaveLength(2);
    expect(_fixture.container.querySelector("#python-managed-runtime")?.textContent).toContain(
      "Private to Scient",
    );
    expect(_fixture.container.querySelector("[data-compute-summary='matlab']")).toBeNull();
    expect(mocks.calls).toEqual([]);
    await render(_fixture, "matlab");
    expect(_fixture.container.querySelector("#scientific-computing-python")).toBeNull();
    expect(_fixture.container.querySelector("#scientific-computing-matlab")).not.toBeNull();
    await openFound(_fixture, "matlab");
    expect(_fixture.container.querySelector("#matlab-installation-0")?.textContent).toContain(
      "R2026a",
    );
    expect(mocks.calls).toEqual([]);
  });

  it("sets up a private kernel for R and offers its download when R is missing", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const kernel: ComputeManagedRuntimeStatus = {
      displayName: "IRkernel",
      installed: false,
      selection: "managed",
      updateAvailable: false,
      runtimeVersion: null,
      toolkitRevision: null,
      operation: null,
      failureMessage: null,
    };
    const r = (installations: ComputeLanguageRuntimeInventory["installations"]) => ({
      ...python(),
      descriptor: {
        ...python().descriptor,
        languageId: ComputeLanguageId.make("r"),
        displayName: "R",
        sourceExtensions: [".r"],
      },
      managedRuntime: kernel,
      installations,
    });
    mocks.preferences = { r: { enabled: true, executable: "" } };
    mocks.statuses = { r: kernel };
    mocks.languages = [
      python(),
      r([{ executable: "/opt/homebrew/bin/R", source: "path", version: "4.6.2", problem: null }]),
    ];
    await renderOverview(_fixture);
    expect(
      _fixture.container.querySelector('li[data-compute-language="r"]')?.textContent,
    ).toContain("Needs setup");
    await render(_fixture, "r");
    // Scient's kernel row appears once it is installed; until then the Runtime row sets it up.
    expect(_fixture.container.querySelector("#r-managed-runtime")).toBeNull();
    const row = _fixture.container.querySelector<HTMLElement>("#r-runtime")!;
    expect(row.querySelector("[data-compute-summary='r']")?.textContent).toBe("Not set up");
    await click(_fixture, "Set up", row);
    expect(mocks.manage).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({ languageId: "r", action: "install" }),
      }),
    );

    mocks.languages = [python(), r([])];
    notify();
    await render(_fixture, "r");
    expect(_fixture.container.querySelector("#r-managed-runtime")).toBeNull();
    expect(_fixture.container.querySelector("#r-runtime")).toBeNull();
    const missing = _fixture.container.querySelector("#r-installation-missing a");
    expect(missing?.textContent).toContain("Get R");
    expect(missing?.getAttribute("href")).toBe("https://cloud.r-project.org/");
    await renderOverview(_fixture);
    expect(
      _fixture.container.querySelector('#scientific-computing li[data-compute-language="r"]'),
    ).toBeNull();
    expect(
      _fixture.container
        .querySelector(
          '#scientific-computing-more li[data-compute-language="r"] a[aria-label="Get R"]',
        )
        ?.getAttribute("href"),
    ).toBe("https://cloud.r-project.org/");
  });

  it("renders Python Toolkits in a separate card that follows the language page", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const installed = status();
    const toolkits = pythonToolkits();
    mocks.statuses.python = installed;
    mocks.languages = [{ ...python(), managedRuntime: installed, toolkits }, matlabHere()];
    await render(_fixture);

    const runtimePanel = _fixture.container.querySelector<HTMLElement>(
      "#scientific-computing-python",
    )!;
    const toolkitSection = _fixture.container.querySelector<HTMLElement>(
      "#scientific-computing-toolkits",
    )!;
    const toolkitCard = toolkitSection.querySelector<HTMLElement>("[data-source-panel]")!;
    expect(runtimePanel.contains(toolkitSection)).toBe(false);
    expect(runtimePanel.querySelectorAll("[data-slot=settings-row]")).toHaveLength(4);
    expect(toolkitSection.querySelector("h2")?.textContent).toBe("Toolkits");
    expect(toolkitCard.querySelectorAll("[data-slot=settings-row]")).toHaveLength(toolkits.length);

    await render(_fixture, "matlab");
    expect(_fixture.container.querySelector("#scientific-computing-python")).toBeNull();
    expect(_fixture.container.querySelector("#scientific-computing-toolkits")).toBeNull();
    await render(_fixture);
    expect(_fixture.container.querySelector("#scientific-computing-python")).not.toBeNull();
    expect(
      _fixture.container
        .querySelector("#scientific-computing-toolkits [data-source-panel]")
        ?.querySelectorAll("[data-slot=settings-row]"),
    ).toHaveLength(toolkits.length);
  });

  it("downloads each Toolkit immediately without changing runtime selection", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const installed = {
      ...status(),
      selection: "existing" as const,
      toolkitIds: [ComputeToolkitId.make("python-data-and-figures")],
    };
    mocks.statuses.python = installed;
    mocks.languages = [{ ...python(), managedRuntime: installed, toolkits: pythonToolkits() }];
    await render(_fixture);
    expect(_fixture.container.textContent).not.toContain("Apply changes");
    expect(_fixture.container.textContent).not.toContain("Discard");
    expect(_fixture.container.querySelector('[aria-label="Include Image analysis"]')).toBeNull();
    await click(_fixture, "Download");
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
    expect(button(_fixture, "Download")).toBeDefined();
  });

  it("removes only the selected Toolkit and keeps all other installed Toolkit ids", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const installed = {
      ...status(),
      toolkitIds: ["python-data-and-figures", "python-image-analysis", "python-other"].map((id) =>
        ComputeToolkitId.make(id),
      ),
    };
    mocks.statuses.python = installed;
    mocks.languages = [{ ...python(), managedRuntime: installed, toolkits: pythonToolkits() }];
    await render(_fixture);
    await act(() =>
      _fixture.container
        .querySelector<HTMLButtonElement>('[aria-label="Manage Image analysis"]')!
        .click(),
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
    expect(_fixture.container.textContent).toContain("Installed");
  });

  it("retries the same per-Toolkit request after a command failure", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const installed = {
      ...status(),
      toolkitIds: [ComputeToolkitId.make("python-data-and-figures")],
    };
    mocks.statuses.python = installed;
    mocks.languages = [{ ...python(), managedRuntime: installed, toolkits: pythonToolkits() }];
    mocks.releaseFails = true;
    await render(_fixture);
    await click(_fixture, "Download");
    expect(_fixture.container.querySelectorAll('[data-compute-notice="block"]')).toHaveLength(1);
    expect(button(_fixture, "Retry")).toBeDefined();
    mocks.releaseFails = false;
    await act(() => {
      mocks.statuses.python = {
        ...installed,
        toolkitIds: [...installed.toolkitIds, ComputeToolkitId.make("python-other")],
      };
      notify();
    });
    await click(_fixture, "Retry");
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
      await using _fixture = _createFixture();
      _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
      await _setupFixture0(_fixture);

      const installed = {
        ...status(),
        toolkitIds: [ComputeToolkitId.make("python-data-and-figures")],
      };
      mocks.statuses.python = installed;
      mocks.languages = [
        { ...python(), managedRuntime: installed, toolkits: pythonToolkits() },
        matlabHere(),
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
      await render(_fixture);
      await click(_fixture, "Download");
      expect(_fixture.container.querySelectorAll('[data-compute-notice="toolbar"]')).toHaveLength(
        1,
      );
      expect(button(_fixture, "Cancel")).toBeDefined();
      // Opening another language's page and coming back.
      await render(_fixture, "matlab");
      await render(_fixture);
      expect(_fixture.container.querySelectorAll('[data-compute-notice="toolbar"]')).toHaveLength(
        1,
      );
      expect(_fixture.container.querySelectorAll('[data-compute-notice="toolbar"]')).toHaveLength(
        1,
      );
      expect(_fixture.container.querySelector('[aria-label="Download Image analysis"]')).toBeNull();
      if (finish === "cancel") {
        await click(_fixture, "Cancel");
        expect(mocks.cancel).toHaveBeenCalledWith({
          environmentId: "remote",
          input: { languageId: "python" },
        });
        expect(_fixture.container.querySelectorAll('[data-compute-notice="toolbar"]')).toHaveLength(
          1,
        );
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
      expect(_fixture.container.querySelectorAll('[data-compute-notice="toolbar"]')).toHaveLength(
        0,
      );
      if (finish === "cancel") expect(button(_fixture, "Download").disabled).toBe(false);
      else
        expect(
          _fixture.container.querySelector('[aria-label="Manage Image analysis"]'),
        ).not.toBeNull();
      expect(mocks.manage).toHaveBeenCalledOnce();
    },
  );

  it("serializes rapid Toolkit clicks before the command receipt arrives", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

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
    await render(_fixture);
    await act(() => {
      const download = button(_fixture, "Download");
      download.click();
      download.click();
    });
    expect(mocks.manage).toHaveBeenCalledOnce();
    await act(async () => {
      release();
      await Promise.resolve();
    });
    expect(button(_fixture, "Download").disabled).toBe(false);
  });

  it("keeps progress inline and accepts another Toolkit while a build is running", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

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
    await render(_fixture);
    expect(_fixture.container.querySelectorAll('[data-compute-notice="block"]')).toHaveLength(0);
    expect(
      _fixture.container.querySelectorAll(
        '[role="status"][aria-label="Image analysis: Installing…"]',
      ),
    ).toHaveLength(1);
    expect(button(_fixture, "Download").disabled).toBe(false);
    await click(_fixture, "Download");
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
    const cancelToolkit = _fixture.container.querySelector<HTMLButtonElement>(
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
      _fixture.container.querySelector('[role="status"][aria-label="Image analysis: Cancelling…"]'),
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
    expect(_fixture.container.querySelector('[aria-label="Cancel Image analysis"]')).toBeNull();
    expect(_fixture.container.textContent).toContain("Cancelling…");
    expect(button(_fixture, "Cancel").disabled).toBe(true);
    await act(() => {
      mocks.statuses.python = { ...installed, toolkitChanges: [], operation: null };
      notify();
    });
    expect(_fixture.container.textContent).not.toContain("Cancelling…");
  });

  it("shows server-owned queued and failed rows on first mount and retries the exact intent", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const kits = pythonToolkits();
    const image = kits[1]!;
    const installed: ComputeManagedRuntimeStatus = {
      ...status(),
      toolkitIds: [kits[0]!.toolkitId],
      toolkitChanges: [{ toolkitId: image.toolkitId, install: true, state: "queued", error: null }],
    };
    mocks.statuses.python = installed;
    mocks.languages = [{ ...python(), managedRuntime: installed, toolkits: kits }];
    await render(_fixture);
    expect(_fixture.container.textContent).toContain("Queued");
    await act(() => {
      mocks.statuses.python = {
        ...installed,
        toolkitChanges: [
          { toolkitId: image.toolkitId, install: true, state: "failed", error: "Download failed" },
        ],
      };
      notify();
    });
    await click(_fixture, "Retry");
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
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

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
    await render(_fixture);
    await act(() => {
      const first = _fixture.container.querySelector<HTMLButtonElement>(
        '[aria-label="Download Image analysis"]',
      )!;
      first.click();
      first.click();
      _fixture.container
        .querySelector<HTMLButtonElement>('[aria-label="Download Large data"]')!
        .click();
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

  it("observes setup completion while another language is shown and returns without repeating setup", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

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
    mocks.languages = [python(), matlabHere()];
    await render(_fixture);
    const setupProgress = () =>
      _fixture.container.querySelectorAll('#python-runtime [role="status"]').length;
    expect(setupProgress()).toBe(1);
    await render(_fixture, "matlab");
    await act(() => {
      mocks.statuses.python = { ...status(), runtimeVersion: "3.12.14", generationId: "g2" };
      notify();
    });
    expect(_fixture.container.querySelector("#scientific-computing-python")).toBeNull();
    await render(_fixture);
    // Scient's row names no version for Python, so completion shows as setup no longer running.
    expect(setupProgress()).toBe(0);
    expect(_fixture.container.querySelector("#python-managed-runtime")?.textContent).toContain(
      "Private to Scient",
    );
    expect(mocks.manage).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("shows test progress inline and clears only successful feedback after a while", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    let finish!: (result: unknown) => void;
    mocks.verify.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await render(_fixture);
    _fixture.stack.use(_fixtureFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }));
    await openFound(_fixture);
    await testInstallation(_fixture, systemPath);
    const row = installationRow(_fixture, systemPath);
    expect(row.querySelector('[role="status"]')?.textContent).toBe("Testing…");
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
    expect(row.querySelector('[role="status"]')?.textContent).toBe("Test passed");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_000);
    });
    expect(row.textContent).not.toContain("Test passed");
    expect(row.textContent).toContain("3.14.6");
    expect(runtimeValue(_fixture)).toBe(managedPath);
    await act(() => runtimeSelect(_fixture).click());
    expect(
      [...document.querySelectorAll("[data-slot=select-item]")].find(
        (item) => item.getAttribute("data-compute-runtime") === systemPath,
      )?.textContent,
    ).toContain("3.14.6");
  });

  it("gives each successful retest its own feedback duration", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    mocks.verify.mockResolvedValue({
      _tag: "Success",
      value: { readiness: "ready", connection: "verified" },
    });
    await render(_fixture);
    _fixture.stack.use(_fixtureFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }));
    await testRuntime(_fixture);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    expect(_fixture.container.textContent).toContain("Test passed");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(_fixture.container.textContent).not.toContain("Test passed");
    // The retest's feedback runs its own full duration, not what was left of the first.
    await testRuntime(_fixture);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    expect(_fixture.container.textContent).toContain("Test passed");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(_fixture.container.textContent).not.toContain("Test passed");
    expect(mocks.verify).toHaveBeenCalledTimes(2);
  });

  it("does not expire failed feedback and keeps its retry available", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    // Commands settle a lost connection into a Failure result; they never reject.
    mocks.verify.mockResolvedValueOnce({ _tag: "Failure", cause: new Error("Connection lost") });
    await render(_fixture);
    _fixture.stack.use(_fixtureFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }));
    await testRuntime(_fixture);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(button(_fixture, "Test failed").getAttribute("aria-label")).toContain("Connection lost");
    expect(button(_fixture, "Test failed").disabled).toBe(false);
    mocks.verify.mockResolvedValueOnce({
      _tag: "Success",
      value: { readiness: "ready", connection: "verified" },
    });
    await click(_fixture, "Test failed");
    expect(_fixture.container.textContent).toContain("Test passed");
    expect(_fixture.container.textContent).not.toContain("Test failed");
  });

  it("treats Test passed as a started-and-closed session, not a metadata probe", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

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
    await render(_fixture);
    await testRuntime(_fixture);
    expect(mocks.calls).toEqual(["verify"]);
    expect(_fixture.container.querySelector('[role="status"]')?.textContent).toBe("Test passed");
    expect(mocks.manage).not.toHaveBeenCalled();
    await act(() => {
      mocks.statuses.python = { ...status() };
      notify();
    });
    expect(_fixture.container.querySelector('[role="status"]')?.textContent).toBe("Test passed");
    await act(() =>
      _fixture.container
        .querySelector<HTMLButtonElement>('[aria-label="Refresh scientific runtimes"]')!
        .click(),
    );
    expect(_fixture.container.textContent).not.toContain("Test passed");
    expect(
      _fixture.container.querySelector<HTMLButtonElement>(
        '[aria-label="More Python runtime actions"]',
      )!,
    ).toBeDefined();
    expect(mocks.verify).toHaveBeenCalledOnce();
    await testRuntime(_fixture);
    expect(_fixture.container.querySelector('[role="status"]')?.textContent).toBe("Test passed");
    await act(() => {
      mocks.statuses.python = { ...status(), generationId: "replacement-helper" };
      notify();
    });
    expect(_fixture.container.textContent).not.toContain("Test passed");
    await act(() => {
      mocks.statuses.python = status();
      notify();
    });
    expect(_fixture.container.textContent).not.toContain("Test passed");
  });

  it("ignores a late test reply after the selected runtime changes and returns", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    let finish!: (result: unknown) => void;
    mocks.verify.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await render(_fixture);
    await testRuntime(_fixture);
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
    expect(_fixture.container.textContent).not.toContain("Test passed");
    expect(
      _fixture.container.querySelector<HTMLButtonElement>(
        '[aria-label="More Python runtime actions"]',
      )!.disabled,
    ).toBe(false);
  });

  it("recovers from a rejected verification request", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    // Commands settle a lost connection into a Failure result; they never reject.
    mocks.verify.mockResolvedValueOnce({ _tag: "Failure", cause: new Error("Connection lost") });
    await render(_fixture);
    await testRuntime(_fixture);
    expect(button(_fixture, "Test failed").getAttribute("aria-label")).toContain("Connection lost");
    expect(button(_fixture, "Test failed").disabled).toBe(false);
  });

  it("does not treat a Python probe as Test passed or send people to Repair", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

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
    await render(_fixture);
    await testRuntime(_fixture);
    expect(_fixture.container.textContent).not.toContain("Test passed");
    expect(button(_fixture, "Test failed").getAttribute("aria-label")).toContain(
      "The connection could not be verified",
    );
    expect(mocks.manage).not.toHaveBeenCalled();
  });

  it("promotes a helper failure to the MATLAB summary with one recovery action", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

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
    await render(_fixture, "matlab");
    const summary = _fixture.container.querySelector("[data-compute-summary='matlab']");
    expect(summary?.textContent).toContain("MATLAB connection failed");
    expect(_fixture.container.textContent).toContain("ENOENT");
    expect(summary?.textContent).not.toContain("R2026a");
    expect(button(_fixture, "Repair connection")).not.toBeNull();
    expect(_fixture.container.textContent?.match(/ENOENT/gu)).toHaveLength(1);
    expect(
      _fixture.container.querySelector("[data-compute-recovery='matlab'] [data-compute-notice]"),
    ).toBeNull();
    expect(_fixture.container.querySelector("[data-compute-notice]")).not.toBeNull();
  });

  it("replaces the MATLAB installation summary when connection setup fails immediately", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

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
    await render(_fixture, "matlab");
    await click(_fixture, "Connect MATLAB");
    expect(_fixture.container.textContent).toContain("MATLAB connection failed");
    expect(_fixture.container.textContent).toContain("Busy operation");
    expect(button(_fixture, "Repair connection")).not.toBeNull();
  });

  it("reports a MATLAB status-query failure without mislabeling the connection", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

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
    await render(_fixture, "matlab");
    await openFound(_fixture, "matlab");
    expect(_fixture.container.querySelector("#matlab-installation-0")?.textContent).toContain(
      "R2026a",
    );
    expect(_fixture.container.textContent).toContain("MATLAB status unavailable");
    expect(_fixture.container.textContent).not.toContain("MATLAB connection failed");
    expect(() => button(_fixture, "Repair connection")).toThrow();
  });

  it.each(["install", "repair", "remove"] as const)(
    "keeps connection-helper %s progress inline and Enable available",
    async (action) => {
      await using _fixture = _createFixture();
      _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
      await _setupFixture0(_fixture);

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
      await render(_fixture, "matlab");
      expect(
        _fixture.container.textContent?.match(/(?:Preparing|Removing) MATLAB connection/gu),
      ).toHaveLength(1);
      // Progress lives inline on the Runtime row, beside its single action.
      const runtimeRow = _fixture.container.querySelector("#matlab-runtime")!;
      expect(
        runtimeRow.querySelectorAll('[data-compute-notice="toolbar"] [role="status"]'),
      ).toHaveLength(1);
      expect(_fixture.container.querySelector('[data-compute-notice="block"]')).toBeNull();
      expect(_fixture.container.textContent).not.toContain("Installing private Python");
      const enable = _fixture.container.querySelector<HTMLElement>(
        '[aria-label="Use MATLAB in Scient"]',
      )!;
      expect(enable.closest("[data-compute-recovery]")).toBeNull();
      expect(enable.hasAttribute("data-disabled")).toBe(false);
    },
  );

  it("returns directly to Connect MATLAB after its helper is removed", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

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
    await render(_fixture, "matlab");
    await openMaintenance(_fixture, "MATLAB connection");
    await clickMenuItem("Remove");
    await click(_fixture, "Remove", document.querySelector<HTMLElement>('[role="alertdialog"]')!);
    await vi.waitFor(() => expect(button(_fixture, "Connect MATLAB")).toBeDefined());
    expect(mocks.calls).toEqual(["remove"]);
    expect(_fixture.container.textContent?.match(/Preparing MATLAB connection/gu)).toBeNull();
  });

  it("surfaces one update action for an older selected managed toolkit", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    mocks.statuses.python = { ...status(), updateAvailable: true };
    mocks.languages = [{ ...python(), managedRuntime: mocks.statuses.python }];
    await renderOverview(_fixture);
    expect(
      _fixture.container.querySelector('li[data-compute-language="python"]')?.textContent,
    ).toContain("3.12.13");
    await render(_fixture);
    expect(
      [..._fixture.container.querySelectorAll("button")].filter(
        (candidate) => candidate.textContent?.trim() === "Update",
      ),
    ).toHaveLength(1);
    await click(_fixture, "Update");
    expect(mocks.calls).toEqual(["update"]);
  });

  it.each([
    ["python", "managed", true],
    ["python", "existing", true],
    ["python", "existing", false],
    ["matlab", "existing", true],
  ] as const)(
    "keeps %s updates on the Runtime row, out of the maintenance menu (%s, enabled=%s)",
    async (languageId, selection, enabled) => {
      await using _fixture = _createFixture();
      _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
      await _setupFixture0(_fixture);

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
      await render(_fixture, languageId);
      // The single primary action and its progress live on the Runtime row.
      const row = () => _fixture.container.querySelector(`#${languageId}-runtime`)!;
      expect(
        [
          ..._fixture.container
            .querySelector(`#${languageId}-managed-runtime`)!
            .querySelectorAll("button"),
        ].some((node) => node.textContent?.trim() === "Update"),
      ).toBe(false);
      await openMaintenance(
        _fixture,
        languageId === "matlab" ? "MATLAB connection" : "Python runtime",
      );
      expect(
        [...document.querySelectorAll('[data-slot="menu-item"]')].some((item) =>
          item.textContent?.includes("Update"),
        ),
      ).toBe(false);
      // Close the menu before exercising the ordinary row action.
      await act(() =>
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
      );
      await click(_fixture, "Update", row());
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
      const cancelButton = button(_fixture, "Cancel", row());
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
      expect(button(_fixture, "Cancel", row()).disabled).toBe(true);
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
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

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
    await render(_fixture);
    await click(_fixture, "Cancel");
    expect(_fixture.container.textContent).not.toContain("Cancelling…");
    expect(button(_fixture, "Cancel").disabled).toBe(false);
    expect(_fixture.container.textContent).toContain("Cancellation failed");
    await click(_fixture, "Cancel");
    expect(mocks.cancel).toHaveBeenCalledTimes(2);
    expect(_fixture.container.textContent).toContain("Cancelling…");
    await act(() => {
      mocks.statuses.python = {
        ...running,
        operation: { ...running.operation!, operationId: "second-build" },
      };
      notify();
    });
    expect(_fixture.container.textContent).not.toContain("Cancelling…");
    expect(button(_fixture, "Cancel").disabled).toBe(false);
    await click(_fixture, "Cancel");
    expect(mocks.cancel).toHaveBeenCalledTimes(3);
  });

  it("selects system Python by saving first and releasing managed precedence exactly once", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await render(_fixture);
    await chooseRuntime(_fixture, systemPath);
    await chooseRuntime(_fixture, systemPath);
    expect(mocks.calls).toEqual(["save", "use-existing"]);
    expect(mocks.preferences.python?.executable).toBe(systemPath);
    expect(runtimeValue(_fixture)).toBe(systemPath);
    expect(mocks.verify).not.toHaveBeenCalled();
  });

  it("keeps enablement and runtime selection usable while packages are being prepared", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

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
    await render(_fixture);
    const toggle = _fixture.container.querySelector<HTMLButtonElement>(
      '[aria-label="Use Python in Scient"]',
    )!;
    expect(toggle.hasAttribute("data-disabled")).toBe(false);
    await chooseRuntime(_fixture, systemPath);
    expect(mocks.calls).toEqual(["save", "use-existing"]);
    expect(runtimeValue(_fixture)).toBe(systemPath);
    await act(() =>
      _fixture.container.querySelector<HTMLElement>('[aria-label="Use Python in Scient"]')!.click(),
    );
    expect(mocks.preferences.python?.enabled).toBe(false);
  });

  it("does not switch or release managed Python when saving fails", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    mocks.saveFails = true;
    await render(_fixture);
    await chooseRuntime(_fixture, systemPath);
    expect(mocks.calls).toEqual(["save"]);
    expect(runtimeValue(_fixture)).toBe(managedPath);
    expect(_fixture.container.textContent).toContain("Settings were not saved");
  });

  it("keeps the real managed default when release fails and allows retry", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    mocks.releaseFails = true;
    await render(_fixture);
    await chooseRuntime(_fixture, systemPath);
    expect(runtimeValue(_fixture)).toBe(managedPath);
    expect(_fixture.container.textContent).toContain("still selected");
    mocks.releaseFails = false;
    await chooseRuntime(_fixture, systemPath);
    expect(runtimeValue(_fixture)).toBe(systemPath);
    expect(_fixture.container.textContent).not.toContain("still selected");
  });

  it("resets automatic discovery without leaving managed precedence active", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    mocks.preferences.python = { enabled: true, executable: "/old/python" };
    await render(_fixture);
    await chooseRuntime(_fixture, automaticRuntimeOption);
    expect(mocks.calls).toEqual(["save", "use-existing"]);
    expect(mocks.preferences.python?.executable).toBe("");
    expect(runtimeValue(_fixture)).toBe(systemPath);
  });

  it("does not save a custom path on blur or closing the list; saves only on explicit submission", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await render(_fixture);
    await openFound(_fixture);
    const input = await typePath(_fixture, "/custom/python");
    await act(() => {
      input.dispatchEvent(new Event("change", { bubbles: true }));
      input.blur();
    });
    expect(mocks.update).not.toHaveBeenCalled();
    // Closing the list is the way out now; it must not save either.
    await closeFound(_fixture);
    expect(mocks.update).not.toHaveBeenCalled();
    await openFound(_fixture);
    const next = await typePath(_fixture, "/custom/python");
    await act(() =>
      next.closest("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
    );
    expect(mocks.preferences.python?.executable).toBe("/custom/python");
    expect(mocks.calls).toEqual(["save", "use-existing"]);
  });

  it("keeps disabled managed Python removable without falsely saying it needs repair", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    mocks.preferences.python = { enabled: false, executable: "" };
    mocks.languages = [{ ...python(), enabled: false, installations: [] }];
    await render(_fixture);
    expect(_fixture.container.textContent).not.toContain("needs repair");
    await openMaintenance(_fixture, "Python runtime");
    expect(menuItem("Remove").getAttribute("data-disabled")).toBeNull();
    expect(mocks.manage).not.toHaveBeenCalled();
  });

  it("ties helper maintenance to the selected MATLAB, not an inventory of rows", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

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
    await render(_fixture, "matlab");
    expect(_fixture.container.textContent).toContain("Set up connection");
    await openMaintenance(_fixture, "MATLAB connection");
    expect(menuItem("Remove").getAttribute("aria-label")).toBe("Remove MATLAB connection helper");
    expect(document.body.textContent).not.toContain("Rebuild connection");
    await openMaintenance(_fixture, "MATLAB connection");
    await chooseRuntime(_fixture, a, "MATLAB");
    expect(mocks.calls).toEqual(["save"]);
    expect(_fixture.container.textContent).not.toContain("Set up connection");
    await openMaintenance(_fixture, "MATLAB connection");
    expect(menuItem("Rebuild").getAttribute("aria-label")).toBe("Rebuild MATLAB connection");
  });

  it("repairs a helper for the newly selected MATLAB instead of activating a stale helper", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

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
    await render(_fixture, "matlab");
    await openMaintenance(_fixture, "MATLAB connection");
    await clickMenuItem("Set up Scient connection");
    expect(mocks.calls).toEqual(["repair"]);
    expect(mocks.calls).not.toContain("use-managed");
  });

  it("promotes a mismatched active MATLAB connection to the main row", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

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
    await render(_fixture, "matlab");
    const runtimeRow = _fixture.container.querySelector<HTMLElement>("#matlab-runtime")!;
    expect(
      [...runtimeRow.querySelectorAll("button")].filter(
        (node) => node.textContent?.trim() === "Set up connection",
      ),
    ).toHaveLength(1);
    await click(_fixture, "Set up connection", runtimeRow);
    expect(mocks.calls).toEqual(["repair"]);
  });

  it("requires confirmation before removal and keeps cancellation non-mutating", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await render(_fixture);
    await openMaintenance(_fixture, "Python runtime");
    await clickMenuItem("Remove");
    expect(mocks.manage).not.toHaveBeenCalled();
    const dialog = document.querySelector<HTMLElement>('[role="alertdialog"]')!;
    expect(dialog.textContent).toContain(
      "System installations and project environments are untouched",
    );
    await click(_fixture, "Cancel", dialog);
    expect(mocks.manage).not.toHaveBeenCalled();
    await openMaintenance(_fixture, "Python runtime");
    await clickMenuItem("Remove");
    await click(_fixture, "Remove", document.querySelector<HTMLElement>('[role="alertdialog"]')!);
    expect(mocks.calls).toEqual(["remove"]);
  });

  it("shows a refused removal's reason as its summary without a duplicate Details", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    mocks.releaseFails = true;
    await render(_fixture);
    await openMaintenance(_fixture, "Python runtime");
    await clickMenuItem("Remove");
    await click(_fixture, "Remove", document.querySelector<HTMLElement>('[role="alertdialog"]')!);
    expect(mocks.calls).toEqual(["remove"]);
    const alert = _fixture.container.querySelector<HTMLElement>('[role="alert"]');
    expect(alert?.textContent).toContain("Busy operation");
    expect(_fixture.container.textContent).not.toContain("Python setup failed");
    expect(_fixture.container.textContent?.match(/Busy operation/gu)).toHaveLength(1);
    expect(_fixture.container.querySelector("details")).toBeNull();
    expect(_fixture.container.querySelector('[aria-label="Error details"]')).toBeNull();
  });

  it("keeps repair reachable for a missing managed executable", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

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
    await render(_fixture);
    expect(button(_fixture, "Repair").disabled).toBe(false);
    expect(
      [..._fixture.container.querySelectorAll("button")].filter(
        (candidate) => candidate.textContent?.trim() === "Repair",
      ),
    ).toHaveLength(1);
    expect(_fixture.container.textContent).toContain("needs repair");
    expect(mocks.manage).not.toHaveBeenCalled();
  });

  it("survives repeated changes between managed and existing Python without duplicate mutations", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await render(_fixture);
    for (let n = 0; n < 2; n++) {
      await chooseRuntime(_fixture, systemPath);
      expect(runtimeValue(_fixture)).toBe(systemPath);
      await chooseRuntime(_fixture, managedPath);
      expect(runtimeValue(_fixture)).toBe(managedPath);
    }
    expect(mocks.calls).toEqual(
      Array.from({ length: 2 }, () => ["save", "use-existing", "use-managed"]).flat(),
    );
    expect(mocks.verify).not.toHaveBeenCalled();
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
