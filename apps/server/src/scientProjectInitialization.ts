import { randomUUID } from "node:crypto";

import {
  applyProjectInitialization,
  inspectProjectFolder,
  planProjectInitialization,
  ProjectInitializationError,
  recoverProjectInitialization,
  rollbackProjectInitialization,
  type InitializationPlan,
  type InitializationRequest,
  type BuiltInSkillDescriptor,
} from "@scientfactory/project-init";
import { listProjectActivatableBuiltInSkillReleases } from "@scientfactory/scient-skills";
import type {
  ScientProjectInitializationApplyResult,
  ScientProjectInitializationOperation,
  ScientProjectInitializationPreviewInput,
  ScientProjectInitializationPreviewResult,
  ScientProjectInitializationRollbackResult,
} from "@synara/contracts";

const DEFAULT_PREVIEW_TTL_MS = 10 * 60 * 1000;
const DEFAULT_MAX_PREVIEWS = 64;
const MAX_PREVIEW_ID_GENERATION_ATTEMPTS = 100;

type PreviewCapability = "apply" | "recover" | "rollback";

interface StoredPreview {
  readonly previewId: string;
  readonly root: string;
  readonly expiresAtMs: number;
  readonly capabilities: ReadonlySet<PreviewCapability>;
  readonly plan: InitializationPlan | null;
}

export interface ScientProjectInitializationServiceOptions {
  readonly now?: () => number;
  readonly createPreviewId?: () => string;
  readonly previewTtlMs?: number;
  readonly maxPreviews?: number;
  readonly builtInSkills?: readonly BuiltInSkillDescriptor[];
}

function defaultBuiltInSkills(): readonly BuiltInSkillDescriptor[] {
  return listProjectActivatableBuiltInSkillReleases().map((release) => ({
    id: release.id,
    version: release.version,
    digest: release.digest,
    origin: release.origin,
    displayName: release.displayName,
    description: release.description,
    role: release.role,
    defaultSelected: false,
    readiness:
      release.requirements.projectObjects.length > 0 || release.requirements.operations.length > 0
        ? "latent"
        : "available",
    prerequisites: [
      ...release.requirements.projectObjects.map((object) => `Project object: ${object}`),
      ...release.requirements.operations.map((operation) => `Operation: ${operation}`),
    ],
    capabilities: release.capabilities,
  }));
}

function toPreviewOperation(
  operation: InitializationPlan["operations"][number],
): ScientProjectInitializationOperation {
  switch (operation.kind) {
    case "create":
    case "propose":
      return {
        kind: operation.kind,
        path: operation.path,
        reason: operation.reason,
        contents: operation.contents,
      };
    case "preserve":
      return {
        kind: operation.kind,
        path: operation.path,
        reason: operation.reason,
      };
    case "conflict":
      return {
        kind: operation.kind,
        path: operation.path,
        reason: operation.reason,
        observedKind: operation.observed.kind,
      };
  }
}

function toInitializationRequest(
  input: ScientProjectInitializationPreviewInput,
): InitializationRequest {
  const request = input.request;
  if (!request) return {};
  return {
    ...(request.title !== undefined ? { title: request.title } : {}),
    ...(request.purpose !== undefined ? { purpose: request.purpose } : {}),
    ...(request.question !== undefined ? { question: request.question } : {}),
    ...(request.scopeIncluded !== undefined ? { scopeIncluded: request.scopeIncluded } : {}),
    ...(request.scopeExcluded !== undefined ? { scopeExcluded: request.scopeExcluded } : {}),
    ...(request.skillIds !== undefined ? { skillIds: request.skillIds } : {}),
  };
}

function toPreviewIssues(
  issues: Awaited<ReturnType<typeof inspectProjectFolder>>["issues"],
): ScientProjectInitializationPreviewResult["issues"] {
  return issues.map((issue) => ({
    code: issue.code,
    path: issue.path,
    message: issue.message,
  }));
}

export class ScientProjectInitializationService {
  readonly #now: () => number;
  readonly #createPreviewId: () => string;
  readonly #previewTtlMs: number;
  readonly #maxPreviews: number;
  readonly #builtInSkills: readonly BuiltInSkillDescriptor[];
  readonly #previews = new Map<string, StoredPreview>();

  constructor(options: ScientProjectInitializationServiceOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#createPreviewId = options.createPreviewId ?? randomUUID;
    this.#previewTtlMs = options.previewTtlMs ?? DEFAULT_PREVIEW_TTL_MS;
    this.#maxPreviews = options.maxPreviews ?? DEFAULT_MAX_PREVIEWS;
    this.#builtInSkills = options.builtInSkills ?? defaultBuiltInSkills();
    if (!Number.isSafeInteger(this.#previewTtlMs) || this.#previewTtlMs <= 0) {
      throw new Error("Project initialization preview TTL must be a positive integer.");
    }
    if (!Number.isSafeInteger(this.#maxPreviews) || this.#maxPreviews <= 0) {
      throw new Error("Project initialization preview capacity must be a positive integer.");
    }
  }

  async preview(
    input: ScientProjectInitializationPreviewInput,
  ): Promise<ScientProjectInitializationPreviewResult> {
    this.#prune();
    let inspection: Awaited<ReturnType<typeof inspectProjectFolder>>;
    try {
      inspection = await inspectProjectFolder(input.root);
    } catch (error) {
      if (!(error instanceof ProjectInitializationError) || error.code !== "INVALID_FOLDER") {
        throw error;
      }
      return {
        previewId: null,
        expiresAt: null,
        root: input.root.trim(),
        folderState: "unavailable",
        status: "blocked",
        projectId: null,
        canApply: false,
        canRecover: false,
        canRollback: false,
        operations: [],
        skills: [],
        issues: [
          {
            code: "invalid-folder",
            path: input.root.trim(),
            message: error.message,
          },
        ],
      };
    }
    const recoveryRequired = inspection.issues.some(
      (issue) => issue.code === "incomplete-transaction",
    );
    if (recoveryRequired) {
      const stored = this.#store({
        root: inspection.root,
        plan: null,
        capabilities: new Set(["recover", "rollback"]),
      });
      return {
        previewId: stored.previewId,
        expiresAt: new Date(stored.expiresAtMs).toISOString(),
        root: inspection.root,
        folderState: inspection.state,
        status: "recovery-required",
        projectId: inspection.identity?.projectId ?? null,
        canApply: false,
        canRecover: true,
        canRollback: true,
        operations: [],
        skills: [],
        issues: toPreviewIssues(inspection.issues),
      };
    }

    const plan = await planProjectInitialization({
      inspection,
      request: toInitializationRequest(input),
      builtInSkills: this.#builtInSkills,
    });
    const canApply = plan.status === "ready";
    const stored = canApply
      ? this.#store({
          root: inspection.root,
          plan,
          capabilities: new Set(["apply"]),
        })
      : null;
    return {
      previewId: stored?.previewId ?? null,
      expiresAt: stored ? new Date(stored.expiresAtMs).toISOString() : null,
      root: inspection.root,
      folderState: inspection.state,
      status: plan.status,
      projectId: inspection.identity?.projectId ?? (canApply ? plan.projectId : null),
      canApply,
      canRecover: false,
      canRollback: false,
      operations: plan.operations.map(toPreviewOperation),
      skills: this.#builtInSkills.map((skill) => ({
        id: skill.id,
        version: skill.version,
        digest: skill.digest,
        origin: skill.origin,
        displayName: skill.displayName,
        description: skill.description,
        role: skill.role,
        selected: plan.skillActivations.some((activation) => activation.id === skill.id),
        defaultSelected: skill.defaultSelected,
        readiness: skill.readiness,
        prerequisites: [...skill.prerequisites],
        capabilities: { ...skill.capabilities },
      })),
      issues: toPreviewIssues(inspection.issues),
    };
  }

  async apply(previewId: string): Promise<ScientProjectInitializationApplyResult> {
    const preview = this.#take(previewId, "apply");
    if (!preview.plan) {
      throw new Error("Project initialization preview does not contain an applicable plan.");
    }
    const result = await applyProjectInitialization(preview.plan);
    return { root: preview.root, ...result };
  }

  async recover(previewId: string): Promise<ScientProjectInitializationApplyResult> {
    const preview = this.#take(previewId, "recover");
    const result = await recoverProjectInitialization(preview.root);
    return { root: preview.root, ...result };
  }

  async rollback(previewId: string): Promise<ScientProjectInitializationRollbackResult> {
    const preview = this.#take(previewId, "rollback");
    const result = await rollbackProjectInitialization(preview.root);
    return { root: preview.root, ...result };
  }

  #store(input: {
    readonly root: string;
    readonly capabilities: ReadonlySet<PreviewCapability>;
    readonly plan: InitializationPlan | null;
  }): StoredPreview {
    this.#prune();
    while (this.#previews.size >= this.#maxPreviews) {
      const oldestPreviewId = this.#previews.keys().next().value;
      if (typeof oldestPreviewId !== "string") break;
      this.#previews.delete(oldestPreviewId);
    }
    let previewId: string | null = null;
    for (let attempt = 0; attempt < MAX_PREVIEW_ID_GENERATION_ATTEMPTS; attempt += 1) {
      const candidate = this.#createPreviewId();
      if (!this.#previews.has(candidate)) {
        previewId = candidate;
        break;
      }
    }
    if (previewId === null) {
      throw new Error("Unable to generate a unique project initialization preview ID.");
    }
    const stored: StoredPreview = {
      previewId,
      root: input.root,
      expiresAtMs: this.#now() + this.#previewTtlMs,
      capabilities: new Set(input.capabilities),
      plan: input.plan,
    };
    this.#previews.set(previewId, stored);
    return stored;
  }

  #take(previewId: string, capability: PreviewCapability): StoredPreview {
    const now = this.#now();
    const preview = this.#previews.get(previewId);
    if (!preview || preview.expiresAtMs <= now) {
      this.#previews.delete(previewId);
      throw new Error("Project initialization preview expired. Preview the folder again.");
    }
    this.#previews.delete(previewId);
    if (!preview.capabilities.has(capability)) {
      throw new Error(`Project initialization preview cannot ${capability} this folder.`);
    }
    return preview;
  }

  #prune(): void {
    const now = this.#now();
    for (const [previewId, preview] of this.#previews) {
      if (preview.expiresAtMs <= now) this.#previews.delete(previewId);
    }
  }
}
