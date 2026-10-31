// @effect-diagnostics nodeBuiltinImport:off -- the machine key is a hash of host identity.
import * as NodeCrypto from "node:crypto";

import {
  ComputeLanguageId,
  DEFAULT_SCIENTIFIC_COMPUTING_LANGUAGE_SETTINGS,
  resolveScientificComputingExecutable,
  scientificComputingSelectionKey,
  type ServerSettings,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ServerSettingsService } from "../../serverSettings.ts";
import { LocalAnalysisStore } from "../analysis/LocalAnalysisStore.ts";
const MATLAB = ComputeLanguageId.make("matlab");

/**
 * Names this computer and account, not this profile: a profile copied to another machine or user
 * must not apply absolute paths chosen on the first one.
 */
export function machineSelectionKey(input: {
  readonly hostname: string;
  readonly platform: NodeJS.Platform;
  readonly architecture: string;
  readonly homeDirectory: string;
}): string {
  const digest = NodeCrypto.createHash("sha256")
    .update([input.hostname, input.platform, input.architecture, input.homeDirectory].join("\n"))
    .digest("hex");
  return `host-${digest.slice(0, 16)}`;
}

/** One preference for both MATLAB execution paths. Legacy data is read-only. */
export function makeScientificRuntimePreferences(
  settings: Pick<ServerSettingsService["Service"], "getSettings" | "updateSettings">,
  legacy: Pick<LocalAnalysisStore["Service"], "readRuntimeExecutablePath">,
  hostKey: string | null = null,
) {
  // Readers see each language's executable already resolved for this machine.
  const forMachine = (current: ServerSettings): ServerSettings =>
    hostKey === null
      ? current
      : {
          ...current,
          scientificComputing: {
            ...current.scientificComputing,
            languages: Object.fromEntries(
              Object.entries(current.scientificComputing.languages).map(([id, language]) => [
                id,
                {
                  ...language,
                  executable: resolveScientificComputingExecutable(language, hostKey),
                },
              ]),
            ),
          },
        };
  const getSettings = Effect.gen(function* () {
    const current = forMachine(yield* settings.getSettings);
    // Presence is deliberate: an explicitly cleared path means Automatic, not
    // permission to resurrect a superseded legacy path.
    if (current.scientificComputing.languages[MATLAB] !== undefined) return current;
    const previous = yield* legacy.readRuntimeExecutablePath("matlab");
    if (previous.executablePath === null) return current;
    return {
      ...current,
      scientificComputing: {
        ...current.scientificComputing,
        languages: {
          ...current.scientificComputing.languages,
          [MATLAB]: {
            ...DEFAULT_SCIENTIFIC_COMPUTING_LANGUAGE_SETTINGS,
            executable: previous.executablePath,
          },
        },
      },
    };
  });
  return {
    hostKey: Effect.succeed(hostKey),
    getSettings,
    readRuntimeExecutablePath: Effect.fn("ScientificRuntimePreferences.readRuntimeExecutablePath")(
      function* (kind: string) {
        const current = yield* settings.getSettings;
        const preference = current.scientificComputing.languages[ComputeLanguageId.make(kind)];
        if (kind === "matlab" && preference === undefined)
          return yield* legacy.readRuntimeExecutablePath(kind);
        return {
          executablePath: resolveScientificComputingExecutable(preference, hostKey) || null,
          warning: null,
        };
      },
    ),
    /** This machine's choice for one project, when one was made; otherwise null. */
    projectExecutable: Effect.fn("ScientificRuntimePreferences.projectExecutable")(function* (
      kind: string,
      projectId: string,
    ) {
      if (hostKey === null) return null;
      const current = yield* settings.getSettings;
      const selections =
        current.scientificComputing.languages[ComputeLanguageId.make(kind)]?.selections ?? {};
      return selections[scientificComputingSelectionKey(hostKey, projectId)] ?? null;
    }),
    writeRuntimeExecutablePath: (kind: string, executablePath: string | null) =>
      settings
        .updateSettings({
          scientificComputing: {
            languages: {
              [ComputeLanguageId.make(kind)]:
                hostKey === null
                  ? { executable: executablePath ?? "" }
                  : { executable: "", selections: { [hostKey]: executablePath ?? "" } },
            },
          },
        })
        .pipe(Effect.asVoid),
    /** Moves an unscoped choice, written before selections were per machine, into this machine's. */
    migrate: Effect.fn("ScientificRuntimePreferences.migrate")(function* () {
      if (hostKey === null) return;
      const current = yield* settings.getSettings;
      const languages = Object.fromEntries(
        Object.entries(current.scientificComputing.languages).flatMap(([id, language]) =>
          language.executable
            ? [[id, { executable: "", selections: { [hostKey]: language.executable } }]]
            : [],
        ),
      );
      if (Object.keys(languages).length > 0)
        yield* settings.updateSettings({ scientificComputing: { languages } });
    }),
  };
}

export class ScientificRuntimePreferences extends Context.Service<
  ScientificRuntimePreferences,
  ReturnType<typeof makeScientificRuntimePreferences>
>()("t3/scient/compute/ScientificRuntimePreferences") {}

export const layer = Layer.effect(
  ScientificRuntimePreferences,
  Effect.gen(function* () {
    const hostKey = machineSelectionKey({
      hostname: yield* HostProcess.Hostname,
      platform: yield* HostProcess.Platform,
      architecture: yield* HostProcess.Architecture,
      homeDirectory: yield* HostProcess.HomeDirectory,
    });
    const preferences = makeScientificRuntimePreferences(
      yield* ServerSettingsService,
      yield* LocalAnalysisStore,
      hostKey,
    );
    yield* preferences
      .migrate()
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("scientific runtime selections were not migrated", { cause }),
        ),
      );
    return preferences;
  }),
);
