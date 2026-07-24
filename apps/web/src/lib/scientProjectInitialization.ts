import type {
  NativeApi,
  ScientProjectInitializationApplyResult,
  ScientProjectInitializationPreviewResult,
  ScientProjectInitializationRollbackResult,
} from "@synara/contracts";

export type ScientProjectInitializationDecision =
  | "cancel"
  | "open-only"
  | "apply"
  | "recover"
  | "rollback";

export type ScientProjectInitializationCompletion =
  | { readonly kind: "applied"; readonly result: ScientProjectInitializationApplyResult }
  | { readonly kind: "recovered"; readonly result: ScientProjectInitializationApplyResult }
  | { readonly kind: "rolled-back"; readonly result: ScientProjectInitializationRollbackResult };

export function scientProjectFolderName(root: string): string {
  return root.split(/[/\\]/).findLast((segment) => segment.length > 0) ?? root;
}

export async function prepareScientProjectForOpening(input: {
  readonly api: Pick<NativeApi, "scientProjectInitialization">;
  readonly root: string;
  readonly requestDecision: (
    preview: ScientProjectInitializationPreviewResult,
    error: string | null,
  ) => Promise<ScientProjectInitializationDecision>;
  readonly onCompletion?: (completion: ScientProjectInitializationCompletion) => void;
}): Promise<"open" | "cancel" | "already-initialized"> {
  let actionError: string | null = null;
  for (;;) {
    const preview = await input.api.scientProjectInitialization.preview({
      root: input.root,
      request: {
        title: scientProjectFolderName(input.root),
      },
    });
    if (preview.status === "already-initialized") return "already-initialized";

    const decision = await input.requestDecision(preview, actionError);
    actionError = null;
    if (decision === "cancel") return "cancel";
    if (decision === "open-only") return "open";

    if (!preview.previewId) {
      actionError = "This preview cannot perform that action. Preview the folder again.";
      continue;
    }

    try {
      if (decision === "apply") {
        if (!preview.canApply) throw new Error("This folder is not ready to initialize.");
        const result = await input.api.scientProjectInitialization.apply({
          previewId: preview.previewId,
        });
        input.onCompletion?.({ kind: "applied", result });
        return "open";
      }
      if (decision === "recover") {
        if (!preview.canRecover) throw new Error("This initialization cannot be resumed safely.");
        const result = await input.api.scientProjectInitialization.recover({
          previewId: preview.previewId,
        });
        input.onCompletion?.({ kind: "recovered", result });
        return "open";
      }
      if (!preview.canRollback)
        throw new Error("This initialization cannot be rolled back safely.");
      const result = await input.api.scientProjectInitialization.rollback({
        previewId: preview.previewId,
      });
      input.onCompletion?.({ kind: "rolled-back", result });
      if (!result.complete) {
        actionError = `Rollback preserved changed files: ${result.preserved.join(", ")}.`;
      }
    } catch (error) {
      actionError = error instanceof Error ? error.message : "The initialization action failed.";
    }
  }
}
