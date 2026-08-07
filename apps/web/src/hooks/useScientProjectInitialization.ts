import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import type { EnvironmentId, ScientProjectInspection } from "@t3tools/contracts";
import { useCallback, useEffect, useRef, useState } from "react";

import { toastManager } from "../components/ui/toast";
import {
  initializeScientProjectForOpening,
  inspectScientProjectForOpening,
  type ScientProjectInitializationDecision,
} from "../lib/scientProjectInitialization";
import { inferProjectTitleFromPath } from "../lib/projectPaths";
import { readPreparedConnection } from "../state/session";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "An unexpected error occurred.";
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

  const requestDecision = useCallback(
    (nextInspection: ScientProjectInspection): Promise<ScientProjectInitializationDecision> =>
      new Promise((resolve) => {
        decisionRef.current?.("cancel");
        decisionRef.current = resolve;
        setInspection(nextInspection);
      }),
    [],
  );

  const resolveDecision = useCallback((decision: ScientProjectInitializationDecision) => {
    const resolve = decisionRef.current;
    if (!resolve) return;
    decisionRef.current = null;
    setInspection(null);
    resolve(decision);
  }, []);

  useEffect(
    () => () => {
      decisionRef.current?.("cancel");
      decisionRef.current = null;
    },
    [],
  );

  const initializeWithFeedback = useCallback(
    async (input: { readonly environmentId: EnvironmentId; readonly root: string }) => {
      const runInitialization = async () => {
        const prepared = readPreparedConnection(input.environmentId);
        if (prepared === null) {
          throw new Error("The selected environment is not connected.");
        }
        const result = await initializeScientProjectForOpening({
          prepared,
          root: input.root,
          title: inferProjectTitleFromPath(input.root),
        });
        if (result.state !== "initialized") {
          throw new Error(
            result.issues[0]?.message ?? "This folder could not be initialized safely.",
          );
        }
        toastManager.add({
          type: "success",
          title: "Scient project ready",
          description:
            result.created.length > 0
              ? `Created ${result.created.join(", ")}.`
              : "The existing Scient project foundation is ready.",
        });
      };

      try {
        await runInitialization();
      } catch (error) {
        toastManager.add({
          type: "error",
          title: "Project opened without Scient setup",
          description: errorMessage(error),
          data: {
            secondaryActionProps: {
              children: "Retry setup",
              onClick: () => {
                void runInitialization().catch((retryError) => {
                  toastManager.add({
                    type: "error",
                    title: "Scient project setup still needs attention",
                    description: errorMessage(retryError),
                  });
                });
              },
            },
            secondaryActionVariant: "outline",
          },
        });
      }
    },
    [],
  );

  const prepareForOpening = useCallback(
    async (input: {
      readonly environmentId: EnvironmentId;
      readonly prepared: PreparedConnection | null;
      readonly root: string;
    }): Promise<{ readonly root: string; readonly initialize: boolean } | null> => {
      const prepared = input.prepared ?? readPreparedConnection(input.environmentId);
      if (prepared === null) {
        toastManager.add({
          type: "warning",
          title: "Scient project setup could not be checked",
          description:
            "The selected environment is still connecting. The folder will open without changing its files.",
        });
        return { root: input.root, initialize: false };
      }

      try {
        const nextInspection = await inspectScientProjectForOpening(prepared, input.root);
        if (nextInspection.state === "initialized") {
          return { root: nextInspection.root, initialize: false };
        }

        const decision = await requestDecision(nextInspection);
        if (decision === "cancel") return null;
        return {
          root: nextInspection.root,
          initialize: decision === "initialize",
        };
      } catch (error) {
        toastManager.add({
          type: "warning",
          title: "Scient project setup could not be checked",
          description: `${errorMessage(error)} The folder will open without changing its files.`,
        });
        return { root: input.root, initialize: false };
      }
    },
    [requestDecision],
  );

  return { initializeWithFeedback, inspection, prepareForOpening, resolveDecision } as const;
}
