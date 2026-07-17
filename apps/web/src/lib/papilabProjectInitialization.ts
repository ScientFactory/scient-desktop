import type {
  NativeApi,
  PapiLabProjectInitializationApplyResult,
  PapiLabProjectInitializationPreviewResult,
  PapiLabProjectInitializationRollbackResult,
} from "@synara/contracts";

export type PapiLabProjectInitializationDecision =
  | "cancel"
  | "open-only"
  | "apply"
  | "recover"
  | "rollback";

export type PapiLabProjectInitializationCompletion =
  | { readonly kind: "applied"; readonly result: PapiLabProjectInitializationApplyResult }
  | { readonly kind: "recovered"; readonly result: PapiLabProjectInitializationApplyResult }
  | { readonly kind: "rolled-back"; readonly result: PapiLabProjectInitializationRollbackResult };

function projectTitleFromRoot(root: string): string {
  return root.split(/[/\\]/).findLast((segment) => segment.length > 0) ?? root;
}

export async function preparePapiLabProjectForOpening(input: {
  readonly api: Pick<NativeApi, "papilabProjectInitialization">;
  readonly root: string;
  readonly requestDecision: (
    preview: PapiLabProjectInitializationPreviewResult,
    error: string | null,
  ) => Promise<PapiLabProjectInitializationDecision>;
  readonly onCompletion?: (completion: PapiLabProjectInitializationCompletion) => void;
}): Promise<"open" | "cancel" | "already-initialized"> {
  let actionError: string | null = null;
  for (;;) {
    const preview = await input.api.papilabProjectInitialization.preview({
      root: input.root,
      request: { title: projectTitleFromRoot(input.root) },
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
        const result = await input.api.papilabProjectInitialization.apply({
          previewId: preview.previewId,
        });
        input.onCompletion?.({ kind: "applied", result });
        return "open";
      }
      if (decision === "recover") {
        if (!preview.canRecover) throw new Error("This initialization cannot be resumed safely.");
        const result = await input.api.papilabProjectInitialization.recover({
          previewId: preview.previewId,
        });
        input.onCompletion?.({ kind: "recovered", result });
        return "open";
      }
      if (!preview.canRollback)
        throw new Error("This initialization cannot be rolled back safely.");
      const result = await input.api.papilabProjectInitialization.rollback({
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
