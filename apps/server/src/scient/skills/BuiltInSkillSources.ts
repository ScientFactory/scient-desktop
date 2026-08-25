export interface BuiltInSkillSource {
  readonly directoryName: string;
  /** Scient-owned product policy. Portable skill manifests cannot self-activate. */
  readonly defaultActive: boolean;
  readonly files: Readonly<Record<string, string>>;
}

const improveWorkspaceReadiness = `---
name: improve-workspace-readiness
description: Apply safe, targeted changes that materially improve a workspace's clarity, organization, reproducibility, or agent guidance. Use when the user explicitly asks to improve workspace readiness or apply findings from a readiness review.
---

# Improve Workspace Readiness

The goal is to improve the workspace's readiness for a capable human or agent collaborator to understand its purpose, work in it safely, reproduce its work, and verify its results—while preserving the workspace's purpose and the user's intent.

Use a recent readiness review when available, but verify the relevant workspace evidence before changing it. Without a review, inspect enough to identify grounded improvements.

Make only changes that materially advance this goal. Where obstacles exist, remove or reduce them through the smallest coherent changes that address the user's request. Keep documentation truthful and consistent with the workspace.

Workspace-readiness work must not alter the user's substantive work itself—such as application behavior or source logic, a research or study protocol, an analysis, a draft, or other core content—unless the user separately asks for that change. It may clarify supporting documentation and, when safe, improve organization or names while preserving meaning, behavior, and references. Do not reorganize, rename, remove, broadly rewrite, or change tooling merely to enforce conventions. Ask before destructive, structurally disruptive, or materially broader changes.

This skill provides guidance only and grants no tools or authority. After making changes, verify them where practical. Report exactly what changed, where it changed, and why each change meaningfully improves readiness. Mention any important recommendation that remains unapplied.
`;

const workspaceReadinessReview = `---
name: workspace-readiness-review
description: Assess whether a project or workspace contains enough grounded context for effective agent collaboration. Use when the user asks if a workspace is understandable, organized, or ready.
---

# Workspace Readiness Review

The goal is to assess the workspace's readiness for a capable human or agent collaborator to understand its purpose, work in it safely, reproduce its work, and verify its results—and to identify meaningful improvements when needed.

Evaluate the workspace from evidence actually present. Judge it by its purpose—code, research, study, writing, or a mixture—not by a universal repository template.

Consider whether essential context is documented clearly enough and still agrees with the workspace. This includes agent instructions when specialized guidance matters, but no particular document is required if equivalent context is discoverable elsewhere.

Consider whether files and folders make sources of truth, responsibilities, inputs, and outputs reasonably discoverable. Do not enforce a conventional structure. Flag documentation or organization only when it could materially cause misunderstanding, unsafe action, irreproducible work, or unverifiable results. Distinguish blockers from useful refinements and uncertainty from deficiency. Do not invent missing requirements or score the workspace.

Use judgment about which evidence matters; there is no fixed checklist. Inspect enough to reach a grounded conclusion. The review is read-only: do not modify files or broaden permissions. This skill provides guidance only and grants no tools or authority.

Report concisely:

- what the workspace appears to be and how work is expected to proceed;
- material strengths or gaps, tied to observed evidence and practical consequences; and
- selective, prioritized improvements tied to meaningful practical benefit.

Omit cosmetic, speculative, or low-value recommendations. If the workspace is already ready for the requested work, say so plainly. If its purpose cannot be inferred reliably, state what remains unknown rather than guessing.

When material improvements exist, ask whether the user wants them applied. If they agree, use \`improve-workspace-readiness\` when available; do not begin changes as part of this review.
`;

/**
 * Bundle-safe mirrors of the reviewed built-in release files.
 * BuiltInSkillReleases.test.ts prevents these bytes from drifting from the
 * human-reviewable files under built-ins/.
 */
export const BUILT_IN_SKILL_SOURCES: ReadonlyArray<BuiltInSkillSource> = Object.freeze([
  Object.freeze({
    directoryName: "workspace-readiness-review",
    defaultActive: true,
    files: Object.freeze({
      "SKILL.md": workspaceReadinessReview,
      "scient.skill.json": `{
  "apiVersion": "scient.skills/v1alpha1",
  "id": "scient.workspace-readiness-review",
  "version": "0.1.0",
  "category": "Workspace readiness",
  "categoryDescription": "Review and improve a workspace so people and agents can understand it and work safely.",
  "displayOrder": 10,
  "supportedScopes": ["user", "project"],
  "defaultInvocationPolicy": "automatic",
  "origin": {
    "kind": "scient"
  }
}
`,
    }),
  }),
  Object.freeze({
    directoryName: "improve-workspace-readiness",
    defaultActive: true,
    files: Object.freeze({
      "SKILL.md": improveWorkspaceReadiness,
      "scient.skill.json": `{
  "apiVersion": "scient.skills/v1alpha1",
  "id": "scient.improve-workspace-readiness",
  "version": "0.1.0",
  "category": "Workspace readiness",
  "categoryDescription": "Review and improve a workspace so people and agents can understand it and work safely.",
  "displayOrder": 20,
  "supportedScopes": ["user", "project"],
  "defaultInvocationPolicy": "explicit",
  "origin": {
    "kind": "scient"
  }
}
`,
    }),
  }),
]);
