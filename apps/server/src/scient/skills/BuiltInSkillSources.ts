export interface BuiltInSkillSource {
  readonly directoryName: string;
  /** Scient-owned product policy. Portable skill manifests cannot self-activate. */
  readonly defaultActive: boolean;
  readonly files: Readonly<Record<string, string>>;
}

const improveWorkspaceReadiness = `---
name: improve-workspace-readiness
description: Apply safe changes that materially improve a workspace's clarity, organization, or agent guidance. Use when the user explicitly asks to improve readiness or apply findings from a readiness review.
---

# Improve Workspace Readiness

The goal is to improve the workspace's readiness for a capable human or agent collaborator to understand its purpose, work in it safely, reproduce its work, and verify its results—while preserving the workspace's purpose and the user's intent.

Use a recent readiness review when available, but verify the relevant workspace evidence before changing it. Without a review, inspect enough to identify grounded improvements.

Make only changes that materially advance this goal. Where obstacles exist, remove or reduce them through the smallest coherent changes that address the user's request. Keep documentation truthful and consistent with the workspace.

Workspace-readiness work must not alter the user's substantive work itself—such as application behavior or source logic, a research or study protocol, an analysis, a draft, or other core content—unless the user separately asks for that change. It may clarify supporting documentation and, when safe, improve organization or names while preserving meaning, behavior, and references. Do not reorganize, rename, remove, broadly rewrite, or change tooling merely to enforce conventions. Ask before destructive, structurally disruptive, or materially broader changes.

This skill provides guidance only and grants no tools or authority. After making changes, verify them where practical. Report exactly what changed, where it changed, and why each change meaningfully improves readiness. Mention any important recommendation that remains unapplied.
`;

const scientSkillAuthoring = `---
name: scient-skill-authoring
description: Create or improve skills for Scient. Use when the user asks to design, write, review, simplify, or test a skill, or decide whether recurring work should become one.
---

# Scient Skill Authoring

The goal is to create or improve a skill that gives a capable agent the minimum missing guidance needed to perform repeatable work well, while preserving the agent's judgment, the user's intent, and Scient's authority boundaries.

## Understand the Work

Begin with the work, not the skill. Understand what the user is actually trying to accomplish, inspect relevant context or examples when available, and discuss uncertainty only when it would materially change the skill's purpose, scope, safety, or expected result.

Identify what a capable agent would otherwise be missing and what a good result would look like. Then decide whether reusable guidance would materially improve the work. If it would not, explain that clearly to the user and recommend against creating a skill, offering a better-fitting alternative when one is apparent.

A skill adds reusable domain context, judgment, workflow, resources, or verification to capabilities the agent already has. It does not provide tools or authority. New integrations, persistent runtimes, or privileged capabilities belong in an add-on or another capability layer. One-off work should remain an ordinary task; always-relevant workspace context or broad personal behavior may belong in instructions or preferences.

## Write Only What Is Missing

Give the skill a focused purpose. Its description is a routing contract: say what it helps accomplish and when it should be used, adding exclusions only where they prevent likely confusion.

In the body, include the goal, useful first principles or non-obvious context, meaningful constraints, and how success can be verified. Leave room for the agent to adapt to the request and available evidence. Use fixed procedures or scripts only when the work is genuinely fragile, deterministic, repetitive, or risky.

Do not impose a universal structure, restate generic model behavior, or encode speculative edge cases. Add supporting resources only when they materially help, and make their use clear. Apply domain standards—such as evidence, uncertainty, and provenance in research—only when relevant.

## Choose Its Home and Invocation

A personal skill follows the user across projects. A project skill captures guidance or resources that belong to one initialized Scient workspace. Infer the intended home when the context is clear; otherwise discuss it with the user when the choice would materially affect the skill.

Create a project skill at \`.scient/skills/<name>/SKILL.md\`, with the frontmatter name matching the directory. Do not add \`scient.skill.json\`; that filename is reserved for reviewed packaged releases. A newly valid project skill is available automatically from the next message. The user can later choose Agent access, \`$name\` only, or Deactivated in Settings. Do not edit Scient's app-private preference store.

Scient does not yet expose agent-driven personal-skill installation, so present a personal candidate without claiming it was installed.

After checking relevant existing skills when available, give the skill a short, distinct name; this is also its explicit \`$name\` invocation. Choose invocation separately from its home. Allow automatic selection when the description can reliably identify work that normally benefits from the skill. Use explicit invocation when applying it depends on intent the request may not reveal or the user should deliberately choose that mode.

Invocation controls how a skill is selected, not what it may do. Scient owns identity, storage, origin, versioning, installation, activation, and authorization. Use only capabilities available in the session, and do not claim a lifecycle action or validation occurred unless it was verified.

## Test and Hand Off

Validate the skill and its resources. Test in proportion to its importance with a representative request, a plausible near-miss, and a variation requiring adaptation. When its value is uncertain, compare the same work without the skill. Use a fresh context when practical so the test does not inherit the intended answer or critique.

Revise from observed failures rather than imagined completeness. Remove instructions that do not improve decisions or outcomes.

Present the candidate or exact changes, its intended home and invocation, non-obvious rationale, testing performed, and remaining uncertainty. Keep drafted, installed, activated, and tested states distinct.
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
  Object.freeze({
    directoryName: "scient-skill-authoring",
    defaultActive: true,
    files: Object.freeze({
      "SKILL.md": scientSkillAuthoring,
      "scient.skill.json": `{
  "apiVersion": "scient.skills/v1alpha1",
  "id": "scient.skill-authoring",
  "version": "0.1.0",
  "category": "Skill creation",
  "categoryDescription": "Create and improve reusable guidance for Scient agents.",
  "displayOrder": 30,
  "supportedScopes": ["user"],
  "defaultInvocationPolicy": "automatic",
  "origin": {
    "kind": "scient"
  }
}
`,
    }),
  }),
]);
