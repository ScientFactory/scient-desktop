import type { EnvironmentId } from "@t3tools/contracts";

/** Reference metadata is optional context, never ownership of an annotation. */
export interface SourceAnnotationContext {
  readonly environmentId: EnvironmentId;
  readonly root: string;
  readonly sourceId: string;
  readonly attachmentId?: string;
  readonly onAskScient?: (context: string) => boolean;
}
