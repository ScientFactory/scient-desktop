import * as Schema from "effect/Schema";
import { useCallback, useEffect, useState } from "react";

import { APP_VERSION } from "../../branding";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { SCIENT_RELEASE_NOTES } from "./catalog";
import {
  resolveScientReleaseNotesDecision,
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
  readonly current: ScientReleaseNote | null;
  readonly history: readonly ScientReleaseNote[];
  readonly isCardVisible: boolean;
  readonly isDialogOpen: boolean;
  readonly openDialog: () => void;
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

  useEffect(() => {
    if (decision.kind === "silent-bootstrap") {
      setStorage({ lastHandledVersion: decision.nextLastHandledVersion });
    }
  }, [decision, setStorage]);

  const acknowledge = useCallback(() => {
    if (decision.kind !== "show") return;
    setStorage({ lastHandledVersion: decision.nextLastHandledVersion });
    setCardVisible(false);
  }, [decision, setStorage]);

  const openDialog = useCallback(() => {
    if (decision.kind === "show") {
      setDialogOpenState(true);
    }
  }, [decision]);

  const dismissCard = useCallback(() => {
    acknowledge();
  }, [acknowledge]);

  const setDialogOpen = useCallback(
    (open: boolean) => {
      setDialogOpenState(open);
      if (!open) acknowledge();
    },
    [acknowledge],
  );

  return {
    current: decision.kind === "show" ? decision.current : null,
    history: decision.kind === "show" ? decision.history : [],
    isCardVisible,
    isDialogOpen,
    openDialog,
    dismissCard,
    setDialogOpen,
  };
}
