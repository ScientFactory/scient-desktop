import { describe, expect, it, vi } from "vite-plus/test";
import {
  ComputeLanguageId,
  type ComputeLanguageRuntimeInventory,
  type ComputeManagedRuntimeStatus,
} from "@t3tools/contracts";
import {
  automaticComputeRuntimeLabel,
  computeCurrentRuntimeSummary,
  computeLanguageAbsent,
  computeLanguageDetail,
  computeLanguageDownloadUrl,
  computeLanguagePrimaryAction,
  computeManagedPrimaryAction,
  computeRuntimePickerLabel,
  defaultComputeInstallation,
  selectExistingComputeInstallation,
} from "./computeInstallationSettingsModel";

const status: ComputeManagedRuntimeStatus = {
  installed: true,
  selection: "managed",
  updateAvailable: false,
  runtimeVersion: "Python 3.12.13",
  toolkitRevision: null,
  generationId: "g1",
  operation: null,
  failureMessage: null,
};
const inventory: ComputeLanguageRuntimeInventory = {
  descriptor: {
    languageId: ComputeLanguageId.make("python"),
    displayName: "Python",
    sourceExtensions: [".py"],
    capabilities: [],
  },
  enabled: true,
  configuredExecutable: "/system/python",
  managedRuntime: status,
  toolkits: [],
  failureMessage: null,
  installations: [
    { executable: "/managed/python", source: "managed", version: "3.12.13", problem: null },
    {
      executable: "/system/python",
      source: "path",
      version: null,
      problem: null,
      configured: true,
    },
  ],
};

describe("installation selection", () => {
  it("labels automatic by its resolved source, without inventing a runtime or version", () => {
    expect(automaticComputeRuntimeLabel(undefined)).toBe("Automatic");
    expect(automaticComputeRuntimeLabel(inventory.installations[1])).toBe("Automatic · System");
    expect(automaticComputeRuntimeLabel(inventory.installations[0])).toBe(
      "Automatic · Scient-managed",
    );
  });
  it("labels a runtime without its executable path", () => {
    expect(computeRuntimePickerLabel(inventory.installations[0]!, "Python")).toBe(
      "3.12.13 · Scient-managed",
    );
    expect(computeRuntimePickerLabel(inventory.installations[1]!, "Python")).toBe(
      "Python · System",
    );
    expect(computeRuntimePickerLabel(inventory.installations[0]!, "Python")).not.toContain(
      "/managed/python",
    );
  });

  it("disambiguates only otherwise-identical runtime choices", () => {
    const duplicate = {
      ...inventory.installations[1]!,
      executable: "/alternate/bin/python",
    };
    const installations = [inventory.installations[1]!, duplicate];
    expect(computeRuntimePickerLabel(installations[0]!, "Python", installations)).toBe(
      "Python · System · system/python",
    );
    expect(computeRuntimePickerLabel(duplicate, "Python", installations)).toBe(
      "Python · System · bin/python",
    );
  });

  it("distinguishes matching bin/python suffixes across equivalent system sources", () => {
    const installations = [
      { ...inventory.installations[1]!, executable: "/env/a/bin/python", source: "path" as const },
      {
        ...inventory.installations[1]!,
        executable: "/env/b/bin/python",
        source: "conventional" as const,
      },
    ];
    expect(
      installations.map((installation) =>
        computeRuntimePickerLabel(installation, "Python", installations),
      ),
    ).toEqual(["Python · System · a/bin/python", "Python · System · b/bin/python"]);
    expect(computeRuntimePickerLabel({ ...installations[0]! }, "Python", [installations[0]!])).toBe(
      "Python · System",
    );
  });

  it("derives setup actions from managed ownership and status", () => {
    expect(computeManagedPrimaryAction(null)).toBe("install");
    expect(computeManagedPrimaryAction({ ...status, installed: false })).toBe("install");
    expect(computeManagedPrimaryAction({ ...status, selection: "existing" })).toBe("use-managed");
    expect(computeManagedPrimaryAction(status)).toBe("use-managed");
    expect(computeManagedPrimaryAction({ ...status, failureMessage: "broken" })).toBe("repair");
    expect(
      computeManagedPrimaryAction({
        ...status,
        failure: {
          reason: "remove-failed",
          action: "remove",
          summary: "Scientific Python could not be removed",
          detail: "Permission denied",
        },
        failureMessage: "Permission denied",
      }),
    ).toBe("use-managed");
  });

  it("uses managed precedence only for Python, independently of an existing path", () => {
    const preference = { enabled: true, executable: "/system/python" };
    expect(defaultComputeInstallation(inventory, preference, status)?.source).toBe("managed");
    expect(
      defaultComputeInstallation(inventory, preference, { ...status, selection: "existing" })
        ?.source,
    ).toBe("path");
    const matlab = {
      ...inventory,
      descriptor: { ...inventory.descriptor, languageId: ComputeLanguageId.make("matlab") },
    };
    expect(defaultComputeInstallation(matlab, preference, status)?.source).toBe("path");
  });

  it("defaults SQL to Scient-managed Python, which has DuckDB, until a Python is chosen", () => {
    const sql = {
      ...inventory,
      descriptor: { ...inventory.descriptor, languageId: ComputeLanguageId.make("sql") },
      configuredExecutable: null,
    };
    const automatic = { enabled: true, executable: "" };
    expect(defaultComputeInstallation(sql, automatic, null)?.source).toBe("managed");
    expect(
      defaultComputeInstallation(sql, { ...automatic, executable: "/system/python" }, null)
        ?.executable,
    ).toBe("/system/python");
  });

  it("keeps a configured alias selected without changing its system provenance", () => {
    const language = { ...inventory, configuredExecutable: "python3" };
    expect(
      defaultComputeInstallation(language, { enabled: true, executable: "python3" }, null)
        ?.executable,
    ).toBe("/system/python");
    expect(
      defaultComputeInstallation(language, { enabled: true, executable: "/new/python" }, null),
    ).toBeUndefined();
  });

  it("never labels an alternative as default when an explicit choice disappeared", () => {
    expect(
      defaultComputeInstallation(inventory, { enabled: true, executable: "/missing/python" }, null),
    ).toBeUndefined();
    expect(
      defaultComputeInstallation(
        { ...inventory, installations: inventory.installations.slice(1) },
        { enabled: true, executable: "" },
        status,
      ),
    ).toBeUndefined();
  });

  it("automatic excludes installed-but-unselected managed Python", () => {
    expect(
      defaultComputeInstallation(
        { ...inventory, configuredExecutable: null },
        { enabled: true, executable: "" },
        { ...status, selection: "existing" },
      )?.executable,
    ).toBe("/system/python");
    expect(
      defaultComputeInstallation(
        {
          ...inventory,
          configuredExecutable: null,
          installations: inventory.installations.slice(0, 1),
        },
        { enabled: true, executable: "" },
        { ...status, selection: "existing" },
      ),
    ).toBeUndefined();
  });

  it("does not reuse stale explicit candidate order while automatic discovery refreshes", () => {
    expect(
      defaultComputeInstallation(inventory, { enabled: true, executable: "" }, null),
    ).toBeUndefined();
  });

  it.each(["/system/python", ""])(
    "saves %s before releasing managed precedence",
    async (executable) => {
      const steps: string[] = [];
      await selectExistingComputeInstallation({
        executable,
        preference: { enabled: true, executable: "old" },
        releaseManaged: true,
        save: async (next) => {
          steps.push(`save:${next.executable}`);
          return true;
        },
        useExisting: async () => {
          steps.push("release");
        },
      });
      expect(steps).toEqual([`save:${executable}`, "release"]);
    },
  );

  it("does not release the managed installation after a failed settings save", async () => {
    const release = vi.fn();
    await expect(
      selectExistingComputeInstallation({
        executable: "/system/python",
        preference: { enabled: true, executable: "" },
        releaseManaged: true,
        save: async () => false,
        useExisting: release,
      }),
    ).rejects.toThrow("Settings were not saved");
    expect(release).not.toHaveBeenCalled();
  });

  it("reports a rejected managed release instead of claiming selection succeeded", async () => {
    await expect(
      selectExistingComputeInstallation({
        executable: "/system/python",
        preference: { enabled: true, executable: "" },
        releaseManaged: true,
        save: async () => true,
        useExisting: async () => {
          throw new Error("operation in progress");
        },
      }),
    ).rejects.toThrow("operation in progress");
  });

  it("leaves MATLAB helper selection alone when selecting an installation", async () => {
    const release = vi.fn();
    await selectExistingComputeInstallation({
      executable: "/MATLAB/bin/matlab",
      preference: { enabled: false, executable: "" },
      releaseManaged: false,
      save: async (next) => {
        expect(next.enabled).toBe(false);
        return true;
      },
      useExisting: release,
    });
    expect(release).not.toHaveBeenCalled();
  });
});

describe("current runtime summary", () => {
  it("describes the selected Python without listing other installations", () => {
    expect(
      computeCurrentRuntimeSummary({
        language: inventory,
        preference: { enabled: true, executable: "" },
        managed: status,
      }),
    ).toEqual({
      kind: "ready",
      title: "3.12.13",
      detail: "Scient-managed",
    });
  });

  it("offers one explicit update for an older selected managed toolkit", () => {
    expect(
      computeCurrentRuntimeSummary({
        language: inventory,
        preference: { enabled: true, executable: "" },
        managed: { ...status, updateAvailable: true },
      }),
    ).toEqual({
      kind: "update-managed",
      title: "3.12.13",
      detail: "Toolkit update available",
    });
    expect(
      computeCurrentRuntimeSummary({
        language: inventory,
        preference: { enabled: true, executable: "/system/python" },
        managed: { ...status, selection: "existing", updateAvailable: true },
      }).kind,
    ).toBe("ready");
  });

  it("keeps a disabled Python row quiet until it is enabled", () => {
    expect(
      computeCurrentRuntimeSummary({
        language: { ...inventory, installations: [] },
        preference: { enabled: false, executable: "" },
        managed: null,
      }),
    ).toEqual({ kind: "disabled", title: "Off", detail: "" });
  });

  it("repairs only a broken Scient-managed runtime", () => {
    const brokenManaged = {
      ...inventory,
      installations: [
        { ...inventory.installations[0]!, problem: "Managed runtime is unavailable" },
      ],
    };
    expect(
      computeCurrentRuntimeSummary({
        language: brokenManaged,
        preference: { enabled: true, executable: "" },
        managed: status,
      }).kind,
    ).toBe("repair-managed");
    const brokenSystem = {
      ...inventory,
      configuredExecutable: "/system/python",
      installations: [{ ...inventory.installations[1]!, problem: "System runtime is unavailable" }],
    };
    expect(
      computeCurrentRuntimeSummary({
        language: brokenSystem,
        preference: { enabled: true, executable: "/system/python" },
        managed: { ...status, selection: "existing" },
      }).kind,
    ).toBe("unavailable");
  });

  it("keeps a failed removal behind the explicit Remove action", () => {
    expect(
      computeCurrentRuntimeSummary({
        language: inventory,
        preference: { enabled: true, executable: "" },
        managed: {
          ...status,
          failure: {
            reason: "remove-failed",
            action: "remove",
            summary: "Scientific Python could not be removed",
            detail: "Permission denied",
          },
          failureMessage: "Permission denied",
        },
      }).kind,
    ).toBe("ready");
  });

  it("keeps disabled MATLAB quiet, then offers the correct enabled recovery", () => {
    const matlab = {
      ...inventory,
      descriptor: { ...inventory.descriptor, languageId: ComputeLanguageId.make("matlab") },
      installations: [
        {
          executable: "/MATLAB/bin/matlab",
          source: "conventional" as const,
          version: "R2026a",
          problem: null,
        },
      ],
    };
    expect(
      computeCurrentRuntimeSummary({
        language: matlab,
        preference: { enabled: false, executable: "" },
        managed: null,
      }),
    ).toEqual({ kind: "disabled", title: "Off", detail: "" });
    expect(
      computeCurrentRuntimeSummary({
        language: { ...matlab, installations: [] },
        preference: { enabled: false, executable: "" },
        managed: null,
      }),
    ).toEqual({ kind: "disabled", title: "Off", detail: "" });
    expect(
      computeCurrentRuntimeSummary({
        language: matlab,
        preference: { enabled: true, executable: "" },
        managed: null,
      }).kind,
    ).toBe("connect");
    expect(
      computeCurrentRuntimeSummary({
        language: { ...matlab, installations: [] },
        preference: { enabled: true, executable: "" },
        managed: null,
      }).kind,
    ).toBe("missing");
  });

  it("makes a failed MATLAB connection helper the current runtime truth", () => {
    const matlab = {
      ...inventory,
      descriptor: { ...inventory.descriptor, languageId: ComputeLanguageId.make("matlab") },
      configuredExecutable: "/MATLAB/bin/matlab",
      installations: [
        {
          executable: "/MATLAB/bin/matlab",
          source: "conventional" as const,
          version: "R2026a",
          problem: null,
        },
      ],
    };
    expect(
      computeCurrentRuntimeSummary({
        language: matlab,
        preference: { enabled: true, executable: "/MATLAB/bin/matlab" },
        managed: {
          ...status,
          selection: "managed",
          installationExecutable: "/MATLAB/bin/matlab",
          failure: {
            reason: "provision-failed",
            action: "repair",
            summary: "MATLAB connection failed",
            detail: "ENOENT: uv.lock",
          },
          failureMessage: "ENOENT: uv.lock",
        },
      }),
    ).toEqual({
      kind: "repair-connection",
      title: "MATLAB connection failed",
      detail: "ENOENT: uv.lock",
    });
  });
});

describe("what a language shows", () => {
  const language = (
    languageId: string,
    installations: ComputeLanguageRuntimeInventory["installations"],
    managedRuntime: ComputeManagedRuntimeStatus | null = null,
  ): ComputeLanguageRuntimeInventory => ({
    ...inventory,
    descriptor: {
      ...inventory.descriptor,
      languageId: ComputeLanguageId.make(languageId),
      displayName: languageId === "r" ? "R" : languageId,
    },
    configuredExecutable: null,
    managedRuntime,
    installations,
  });
  const found = {
    executable: "/usr/bin/R",
    source: "path" as const,
    version: "4.6.2",
    problem: null,
  };
  const preference = { enabled: true, executable: "" };
  const detail = (item: ComputeLanguageRuntimeInventory, enabled = true) => {
    const current = { ...preference, enabled };
    return computeLanguageDetail(
      item,
      computeCurrentRuntimeSummary({
        language: item,
        preference: current,
        managed: item.managedRuntime,
      }),
      current,
      item.managedRuntime,
    );
  };

  it("names where a runtime came from, not just that it is on the system", () => {
    expect(
      computeRuntimePickerLabel(
        {
          executable: "/a",
          source: "conventional",
          version: "3.13.5",
          problem: null,
          origin: "uv",
        },
        "Python",
      ),
    ).toBe("3.13.5 · uv");
    expect(
      automaticComputeRuntimeLabel({
        executable: "/a",
        source: "path",
        version: null,
        problem: null,
        origin: "Homebrew",
      }),
    ).toBe("Automatic · Homebrew");
    expect(
      computeRuntimePickerLabel(
        {
          executable: "/k",
          source: "conventional",
          version: null,
          problem: null,
          origin: "Octave",
        },
        "GNU Octave",
      ),
    ).toBe("GNU Octave");
  });

  it("says Scient can always set up Python and SQL, and others need their language", () => {
    expect(computeLanguageAbsent(language("python", []))).toBe(false);
    expect(computeLanguageAbsent(language("sql", []))).toBe(false);
    expect(computeLanguageAbsent(language("r", []))).toBe(true);
    expect(computeLanguageAbsent(language("matlab", []))).toBe(true);
    expect(computeLanguageAbsent(language("rust", []))).toBe(true);
    expect(computeLanguageAbsent(language("r", [found]))).toBe(false);
  });

  it("says what a language runs on, or what it needs", () => {
    const kernel = { ...status, selection: "existing" as const };
    expect(detail(language("r", [found], kernel))).toBe("4.6.2 · System");
    expect(detail(language("r", [found], kernel), false)).toBe("Off");
    expect(detail(language("r", [found], { ...status, installed: false }))).toBe("Needs setup");
    expect(detail(language("rust", [{ ...found, version: null }]))).toBe("Found");
    expect(
      detail(language("r", [{ ...found, problem: "The selected R executable was not found." }])),
    ).toBe("The selected R executable was not found.");
    expect(
      detail(
        language("sql", [{ ...found, source: "managed" as const, version: "3.14.7" }], status),
      ),
    ).toBe("Ready");
    expect(detail(language("matlab", [found], { ...status, installed: false }))).toBe(
      "Not connected",
    );
  });

  it("points to where a missing language comes from", () => {
    expect(computeLanguageDownloadUrl(language("r", []))).toContain("r-project");
    const setup = { needs: "evcxr", url: "https://example.org/evcxr" };
    const rust = language("rust", []);
    expect(computeLanguageDownloadUrl({ ...rust, descriptor: { ...rust.descriptor, setup } })).toBe(
      setup.url,
    );
    expect(computeLanguageDownloadUrl(language("spss", []))).toBeUndefined();
  });

  it("offers one action, the most urgent", () => {
    const action = (item: ComputeLanguageRuntimeInventory) => {
      const managed = item.managedRuntime;
      const summary = computeCurrentRuntimeSummary({ language: item, preference, managed });
      return computeLanguagePrimaryAction({
        language: item,
        summary,
        managed,
        selected: defaultComputeInstallation(item, preference, managed),
        failureRetry: null,
      })?.label;
    };
    const absent = { ...status, installed: false };
    expect(action(language("python", [], absent))).toBe("Set up");
    expect(action(language("r", [found], absent))).toBe("Set up");
    expect(action(language("matlab", [found], absent))).toBe("Connect MATLAB");
    const managed = { ...found, source: "managed" as const };
    expect(action(language("python", [managed], { ...status, updateAvailable: true }))).toBe(
      "Update",
    );
    expect(action(language("rust", [found]))).toBeUndefined();
    expect(
      action(
        language(
          "python",
          [{ executable: "/m", source: "managed" as const, version: "3.14", problem: "Damaged" }],
          status,
        ),
      ),
    ).toBe("Repair");
  });
});
