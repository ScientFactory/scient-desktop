import { useState } from "react";
import type {
  ComputeLanguageRuntimeInventory,
  EnvironmentId,
  ScientificComputingLanguageSettings,
} from "@t3tools/contracts";
import {
  ComputeLanguageDescriptor,
  ComputeLanguageId,
  resolveScientificComputingExecutable,
  resolveScientificComputingLanguageSettings,
} from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";

import { useEnvironmentSettings } from "~/hooks/useSettings";
import { computeEnvironment } from "~/state/compute";
import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { computeScientPart } from "./computeInstallationSettingsModel";

const PENDING_RUNTIME_DESCRIPTORS: ReadonlyArray<ComputeLanguageDescriptor> = (
  [
    ["python", "Python", ".py"],
    ["r", "R", ".r"],
    ["julia", "Julia", ".jl"],
    ["sql", "SQL", ".sql"],
    ["matlab", "MATLAB", ".m"],
  ] as const
).map(([languageId, displayName, extension]) =>
  ComputeLanguageDescriptor.make({
    languageId: ComputeLanguageId.make(languageId),
    displayName,
    sourceExtensions: [extension],
    capabilities: ["execute", "interrupt", "restart", "shutdown"],
  }),
);

function pendingRuntimeInventory(
  preferences: Readonly<Record<string, ScientificComputingLanguageSettings>>,
): ReadonlyArray<ComputeLanguageRuntimeInventory> {
  return PENDING_RUNTIME_DESCRIPTORS.map((descriptor) => {
    const preference = resolveScientificComputingLanguageSettings(
      { languages: preferences },
      descriptor.languageId,
    );
    return {
      descriptor,
      enabled: preference.enabled,
      configuredExecutable: preference.executable || null,
      managedRuntime: null,
      toolkits: [],
      installations: [],
      failureMessage: null,
    };
  });
}

/** What this computer has for each language, and the choices saved for it. */
export function useComputeLanguages(environmentId: EnvironmentId) {
  const preferences = useEnvironmentSettings(
    environmentId,
    (settings) => settings.scientificComputing,
  );
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const refreshRuntimes = useAtomCommand(computeEnvironment.refreshRuntimeInventory, {
    reportFailure: false,
  });
  const [refreshing, setRefreshing] = useState(false);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [refreshFailure, setRefreshFailure] = useState<string | null>(null);
  // The list is instant; versions run each Python, so they arrive a moment later.
  const listed = useEnvironmentQuery(
    computeEnvironment.runtimeInventory({ environmentId, input: {} }),
  );
  const withVersions = useEnvironmentQuery(
    computeEnvironment.runtimeInventory({ environmentId, input: { versions: true } }),
  );
  const runtimes = withVersions.data ? withVersions : listed;
  const hostKey = runtimes.data?.hostKey ?? null;
  const pending = runtimes.data === null && runtimes.error === null;

  const preferenceFor = (language: ComputeLanguageRuntimeInventory) => {
    const languageId = language.descriptor.languageId;
    return {
      ...resolveScientificComputingLanguageSettings(preferences, languageId),
      executable:
        hostKey === null
          ? (preferences.languages[languageId]?.executable ?? language.configuredExecutable ?? "")
          : resolveScientificComputingExecutable(preferences.languages[languageId], hostKey),
    };
  };

  // Choices are saved for this machine, so a copied or synced profile does not carry them.
  const updateLanguage = async (
    languageId: ComputeLanguageRuntimeInventory["descriptor"]["languageId"],
    next: ScientificComputingLanguageSettings,
  ) => {
    const result = await updateSettings({
      environmentId,
      input: {
        patch: {
          scientificComputing: {
            schemaVersion: 1,
            languages: {
              [languageId]:
                hostKey === null
                  ? next
                  : {
                      enabled: next.enabled,
                      executable: "",
                      selections: { [hostKey]: next.executable },
                    },
            },
          },
        },
      },
    });
    if (result._tag === "Failure") {
      const failure = squashAtomCommandFailure(result);
      setRefreshFailure(
        failure instanceof Error ? failure.message : "The setting could not be saved.",
      );
      return false;
    }
    setRefreshFailure(null);
    setRefreshVersion((current) => current + 1);
    return true;
  };

  const refresh = async () => {
    // Refresh is a new observation, not proof that an earlier Test still holds.
    setRefreshVersion((current) => current + 1);
    setRefreshFailure(null);
    setRefreshing(true);
    const result = await refreshRuntimes({ environmentId, input: {} });
    setRefreshing(false);
    if (result._tag === "Failure") {
      const failure = squashAtomCommandFailure(result);
      setRefreshFailure(
        failure instanceof Error
          ? failure.message
          : "Scient could not refresh scientific runtimes.",
      );
    }
  };

  return {
    // Languages Scient has a part in lead; the ones that bring their own kernel follow.
    languages: (
      runtimes.data?.languages ?? pendingRuntimeInventory(preferences.languages)
    ).toSorted(
      (a, b) =>
        Number(computeScientPart(a.descriptor.languageId) === null) -
        Number(computeScientPart(b.descriptor.languageId) === null),
    ),
    pending,
    busy: runtimes.isPending || refreshing,
    refreshing,
    refreshVersion,
    failure: refreshFailure ?? runtimes.error,
    preferenceFor,
    updateLanguage,
    refresh,
  };
}

export type ComputeLanguages = ReturnType<typeof useComputeLanguages>;
