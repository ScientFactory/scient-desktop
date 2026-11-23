import * as Schema from "effect/Schema";
import { useEffect, useState } from "react";

import { APP_VERSION } from "../../branding";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { SCIENT_RELEASE_NOTES } from "./catalog";
import {
  resolveScientReleaseNotesDecision,
  sortScientReleaseNotes,
  type ScientReleaseNote,
  type ScientReleaseNotesDecision,
} from "./model";

const SCIENT_RELEASE_NOTES_STORAGE_KEY = "scient:release-notes:v1";

const ScientReleaseNotesStorageSchema = Schema.Struct({
  lastHandledVersion: Schema.NullOr(Schema.String),
});

type ScientReleaseNotesStorage = typeof ScientReleaseNotesStorageSchema.Type;

const INITIAL_STORAGE: ScientReleaseNotesStorage = { lastHandledVersion: null };

export interface ScientReleaseNotesController {
  /** The installed version's note, or the newest note when the catalog has none. */
  readonly current: ScientReleaseNote | null;
  /** The installed version, used to mark the "Current" row in the history. */
  readonly installedVersion: string;
  readonly history: readonly ScientReleaseNote[];
  readonly dialogView: "release" | "history";
  readonly isCardVisible: boolean;
  readonly isDialogOpen: boolean;
  readonly openDialog: () => void;
  readonly openHistory: () => void;
  readonly dismissCard: () => void;
  readonly setDialogOpen: (open: boolean) => void;
}

export function useScientReleaseNotes(options?: {
  readonly catalog?: readonly ScientReleaseNote[];
  readonly currentVersion?: string;
}): ScientReleaseNotesController {
  const catalog = options?.catalog ?? SCIENT_RELEASE_NOTES;
  const currentVersion = options?.currentVersion ?? APP_VERSION;
  const [storage, setStorage] = useLocalStorage(
    SCIENT_RELEASE_NOTES_STORAGE_KEY,
    INITIAL_STORAGE,
    ScientReleaseNotesStorageSchema,
  );
  const [decision] = useState<ScientReleaseNotesDecision>(() =>
    resolveScientReleaseNotesDecision({
      catalog,
      currentVersion,
      lastHandledVersion: storage.lastHandledVersion,
    }),
  );
  const [isCardVisible, setCardVisible] = useState(decision.kind === "show");
  const [isDialogOpen, setDialogOpenState] = useState(false);
  const [dialogView, setDialogView] = useState<"release" | "history">("release");
  // Every note the build ships, newest first: the history must not depend on the installed version.
  const history = sortScientReleaseNotes(catalog);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- persists the handled release version to storage on silent bootstrap
  useEffect(() => {
    if (decision.kind === "silent-bootstrap") {
      setStorage({ lastHandledVersion: decision.nextLastHandledVersion });
    }
  }, [decision, setStorage]);

  const acknowledge = () => {
    if (decision.kind !== "show") return;
    setStorage({ lastHandledVersion: decision.nextLastHandledVersion });
    setCardVisible(false);
  };

  const openDialog = () => {
    if (decision.kind === "show") {
      setDialogView("release");
      setDialogOpenState(true);
    }
  };

  const openHistory = () => {
    setDialogView("history");
    setDialogOpenState(true);
  };

  const dismissCard = () => {
    acknowledge();
  };

  // Only the card's own dialog counts as seeing the upgrade notice; the history does not.
  const setDialogOpen = (open: boolean) => {
    setDialogOpenState(open);
    if (!open && dialogView === "release") acknowledge();
  };

  return {
    current: history.find((note) => note.version === currentVersion) ?? history[0] ?? null,
    installedVersion: currentVersion,
    history,
    dialogView,
    isCardVisible,
    isDialogOpen,
    openDialog,
    openHistory,
    dismissCard,
    setDialogOpen,
  };
}
