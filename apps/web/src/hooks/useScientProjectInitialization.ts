import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import type { EnvironmentId, ScientProjectInspection } from "@t3tools/contracts";
import { msg } from "gt-react";
import { useEffect, useRef, useState } from "react";

import { toastManager } from "../components/ui/toast";
import { m } from "../i18n/messages";
import {
  initializeScientProjectForOpening,
  inspectScientProjectForOpening,
  type ScientProjectInitializationDecision,
} from "../lib/scientProjectInitialization";
import { inferProjectTitleFromPath } from "@t3tools/client-runtime/state/projects";
import { readPreparedConnection } from "../state/session";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : m(msg("An unexpected error occurred."));
}

/**
 * Owns the Scient-specific decision and background initialization lifecycle so
 * the host project picker only coordinates project registration and navigation.
 */
export function useScientProjectInitialization() {
  const [inspection, setInspection] = useState<ScientProjectInspection | null>(null);
  const decisionRef = useRef<((decision: ScientProjectInitializationDecision) => void) | null>(
    null,
  );

  const requestDecision = (
    nextInspection: ScientProjectInspection,
  ): Promise<ScientProjectInitializationDecision> =>
    new Promise((resolve) => {
      decisionRef.current?.("cancel");
      decisionRef.current = resolve;
      setInspection(nextInspection);
    });

  const resolveDecision = (decision: ScientProjectInitializationDecision) => {
    const resolve = decisionRef.current;
    if (!resolve) return;
    decisionRef.current = null;
    setInspection(null);
    resolve(decision);
  };

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- cancels a pending initialization decision when its owner unmounts
  useEffect(
    () => () => {
      decisionRef.current?.("cancel");
      decisionRef.current = null;
    },
    [],
  );

  const initializeWithFeedback = async (input: {
    readonly environmentId: EnvironmentId;
    readonly root: string;
  }) => {
    const runInitialization = async () => {
      const prepared = readPreparedConnection(input.environmentId);
      if (prepared === null) {
        throw new Error(m(msg("The selected environment is not connected.")));
      }
      const result = await initializeScientProjectForOpening({
        prepared,
        root: input.root,
        title: inferProjectTitleFromPath(input.root),
      });
      if (result.state !== "initialized") {
        throw new Error(
          result.issues[0]?.message ?? m(msg("This folder could not be initialized safely.")),
        );
      }
      toastManager.add({
        type: "success",
        title: m(msg("Scient project ready")),
        description:
          result.created.length > 0
            ? m(msg("Created {files}.", { files: result.created.join(", ") }))
            : m(msg("The existing Scient project foundation is ready.")),
      });
    };

    try {
      await runInitialization();
    } catch (error) {
      toastManager.add({
        type: "error",
        title: m(msg("Project opened without Scient setup")),
        description: errorMessage(error),
        data: {
          secondaryActionProps: {
            children: m(msg("Retry setup")),
            onClick: () => {
              void runInitialization().catch((retryError) => {
                toastManager.add({
                  type: "error",
                  title: m(msg("Scient project setup still needs attention")),
                  description: errorMessage(retryError),
                });
              });
            },
          },
          secondaryActionVariant: "outline",
        },
      });
    }
  };

  const prepareForOpening = async (input: {
    readonly environmentId: EnvironmentId;
    readonly prepared: PreparedConnection | null;
    readonly root: string;
    readonly isCurrent?: () => boolean;
  }): Promise<{ readonly root: string; readonly initialize: boolean } | null> => {
    const prepared = input.prepared ?? readPreparedConnection(input.environmentId);
    if (prepared === null) {
      toastManager.add({
        type: "warning",
        title: m(msg("Scient project setup could not be checked")),
        description: m(
          msg(
            "The selected environment is still connecting. The folder will open without changing its files.",
          ),
        ),
      });
      return { root: input.root, initialize: false };
    }

    try {
      const nextInspection = await inspectScientProjectForOpening(prepared, input.root);
      if (input.isCurrent?.() === false) return null;
      if (nextInspection.state === "initialized") {
        return { root: nextInspection.root, initialize: false };
      }

      const decision = await requestDecision(nextInspection);
      if (decision === "cancel" || input.isCurrent?.() === false) return null;
      return {
        root: nextInspection.root,
        initialize: decision === "initialize",
      };
    } catch (error) {
      if (input.isCurrent?.() === false) return null;
      toastManager.add({
        type: "warning",
        title: m(msg("Scient project setup could not be checked")),
        description: m(
          msg("{error} The folder will open without changing its files.", {
            error: errorMessage(error),
          }),
        ),
      });
      return { root: input.root, initialize: false };
    }
  };

  return { initializeWithFeedback, inspection, prepareForOpening, resolveDecision } as const;
}
