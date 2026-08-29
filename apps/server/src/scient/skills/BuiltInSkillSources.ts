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

const pdfAuthoring = `---
name: pdf-authoring
description: Create polished PDF deliverables and their editable sources. Use when the user asks to create, revise, or export a PDF or printable document, not when they only want to read an existing PDF.
---

# PDF Authoring

The goal is to produce a correct, polished PDF that fits the user's purpose while preserving an appropriate editable source and truthful build evidence.

## Choose an Authoring Route

Honor the user's requested source format. If they ask for LaTeX or a \`.tex\` source, create LaTeX and do not substitute HTML merely because HTML has a direct build tool. Preserve an existing authoring format unless the user asks to convert it.

When the user has not chosen a format, select the source model whose strengths match the document's hardest requirements and expected revision workflow, not its topic or length alone:

- Prefer LaTeX when semantic typesetting—such as equations, references, numbering, footnotes, or consistent structured composition—is the main source of complexity.
- Prefer HTML and CSS when visual composition, browser-native graphics, multilingual or RTL behavior, or web-derived content is the main source of complexity.
- When neither dominates, use the route that can be built, inspected, and maintained most reliably with the capabilities actually available.

When LaTeX is chosen, use \`latex-authoring\` when available. When HTML is chosen for PDF output, use \`html-pdf-authoring\` when available. Preserve another existing source format and use its qualified native exporter when that gives the most faithful result.

These are judgment criteria, not restrictions. Do not re-render an existing PDF merely to copy, inspect, or transform it; use a PDF-native operation when one is available.

This skill provides guidance only and grants no tools or authority. If no qualified build route is available, provide the editable source and state the limitation clearly; never imply that a PDF was produced or verified.

## Build and Verify the Deliverable

Keep the source and its assets in sensible workspace locations unless the user requests otherwise. When the requested deliverable is a PDF, source alone is not completion: build the PDF when the session has a qualified route.

Review the result in the dimensions that matter for the document:

- visual fidelity, including typography, hierarchy, spacing, pagination, sharp figures, and the absence of clipping, overlap, or missing glyphs;
- text fidelity, including search, selection, copy order, and RTL or mixed-direction text when relevant; and
- document behavior, including page count, links, outline, references, and page numbering when intended.

Inspect rendered pages rather than relying only on successful compilation or structural parsing. Review every page of a short document and representative high-risk pages of a long one. Fix meaningful defects and rebuild when possible.

Link the editable source and the final project PDF when one was actually produced. Use project-relative Markdown links, wrap link destinations containing spaces in angle brackets, and link the exact \`outputPath\` returned by a build operation. If no PDF was built, link the source and state that limitation clearly. Do not rebuild through another route merely to obtain a clickable link. Then report the authoring route, verification performed, and any unresolved warning or unverified property.
`;

const htmlPdfAuthoring = `---
name: html-pdf-authoring
description: Create or modify HTML specifically to produce a high-quality PDF with Chromium. Use only when PDF or printable output is the purpose of the HTML work, not for ordinary webpage creation or editing.
---

# HTML-to-PDF Authoring

The goal is to create or adapt HTML whose Chromium-generated PDF is visually polished, textually usable, and faithful to the user's purpose, while keeping the HTML an editable source.

Use this guidance only when HTML is being created or modified specifically to produce a PDF or printable document. Do not apply it to ordinary webpage work.

## Design for Pages

Understand the document's audience, content, and intended paper size before styling. Honor an existing design and source structure. When adapting an existing page, prefer a narrow print layer over rewriting its screen behavior unless the user asks for a redesign.

Use normal document flow as the foundation. Avoid fixed-height page canvases, viewport-sized sections, nested scrolling regions, overflow clipping, and fixed or sticky interface elements unless the requested design genuinely requires them and the exported PDF has been verified. Let content reflow across pages.

Choose page size, orientation, and margins deliberately when they matter, and express them with \`@page\`. Do not silently assume A4 or Letter when the choice could change the result. Use \`@media print\` to adapt layout and remove controls or navigation, but confirm that it does not hide meaningful content.

Keep screen and print spacing separate: define PDF margins with \`@page\`; if the screen preview would otherwise touch the viewport edge, add a modest outer gutter only in \`@media screen\`, unless edge-to-edge presentation is intentional. Do not reproduce page margins as print-visible padding inside the document.

## Preserve Document Meaning

Use semantic headings in a logical hierarchy, real links, lists, figures with captions, and native tables with header and body structure. These preserve document meaning and support useful outlines, links, accessibility, and later inspection. Set the document language and use \`dir\` on the document or relevant sections for RTL and mixed-direction content.

Keep assets stable and workspace-relative. Give images useful intrinsic dimensions, ensure fonts cover every required glyph, and prefer SVG or HTML and CSS for diagrams and charts that should remain sharp. Avoid depending on slow or transient remote assets. Canvas, WebGL, video, embedded frames, virtualization, and lazy content may flatten, omit, or destabilize output; use static alternatives when fidelity matters.

## Control Fragmentation Carefully

Use \`break-before\`, \`break-after\`, \`break-inside\`, \`widows\`, and \`orphans\` to guide Chromium, not to simulate a rigid page editor. Keep short figures, rows, code blocks, and headings with their related content when practical. Do not forbid breaks inside content taller than a page; it must remain able to fragment without clipping or creating large blank areas.

Page counters and margin-box content may be used only when the actual Chromium export verifies them. Do not rely on automatic CSS footnotes, running strings, or target-based page cross-references. Author stable visible footnotes or endnotes instead, or choose LaTeX when those publishing features are central.

## Export and Verify

If \`scient_pdf_build\` is available, call it with the project-relative HTML source path and intended project-relative PDF output path. Scient renders the document with print media in isolated Chromium, permits its local sibling assets, blocks remote resources, validates the PDF structurally, publishes an immutable revision, writes the validated PDF to \`outputPath\`, and opens it. Tool success does not prove visual quality. If direct build access is unavailable, create and link the workspace HTML so the user can open it in Scient and choose Export PDF. This skill grants no tools or authority, and source creation alone is not a completed PDF.

Judge the exported PDF, not only the browser page. Check representative page boundaries and every page of a short document for blank pages, clipping, overlaps, awkward breaks, missing glyphs, and weak visual hierarchy. Verify page size and count, selectable text and logical copy order, RTL where relevant, links and outline, font rendering, and image or vector sharpness. Fix meaningful defects and export again when possible.

Link the editable HTML and the returned \`outputPath\` with project-relative Markdown links. Wrap link destinations containing spaces in angle brackets. Do not rebuild through another route merely to obtain a clickable link. Then report what was verified and any unresolved warning or untested property.
`;

const latexAuthoring = `---
name: latex-authoring
description: Create or modify LaTeX documents in Scient. Use when the user requests LaTeX or a .tex source, when working in an existing LaTeX project, or when PDF authoring selects LaTeX as the appropriate source format.
---

# LaTeX Authoring

The goal is to produce maintainable LaTeX source that fits the user's purpose, respects the project's authoring conventions, and has a truthfully reported build state.

Honor the user's requested format and preserve an existing project's document class, engine requirements, bibliography system, structure, and naming unless the user asks to change them. Keep the source semantic and use packages, custom layout, or multiple files only when they materially help the document.

Do not assume a particular engine or package is available. Follow existing magic comments and preamble choices. For a new document with no engine requirement, prefer broadly supported LaTeX; when the content genuinely requires engine-specific features, state that requirement rather than silently changing formats. Keep assets workspace-relative. In a multi-file document, use \`% !TEX root = main.tex\` in subordinate files only when needed.

Reconcile the body against the preamble before reporting a source ready: every command, environment, and glyph the document uses must have its defining package or engine feature loaded. Undefined control sequences from an unloaded package are the most common failure in generated LaTeX; a typical slip is \`\\mathscr\` without \`mathrsfs\` or \`unicode-math\`.

In Scient, a workspace \`.tex\` file is a first-class editable source. Create it in the project and provide a project-relative Markdown link. Opening the link opens Scient's LaTeX source and PDF view, starts local compilation, and shows the PDF after a successful build. If direct build access is unavailable, state that the source is ready to compile; opening a link or creating a source is not evidence that compilation succeeded.

When build evidence is available, inspect meaningful diagnostics and the rendered PDF rather than treating a successful compiler exit as proof of quality. Check the parts that matter for the document, such as equations, citations and references, pagination, figures, tables, and required glyphs. Fix material defects when possible. Link an actual project PDF only when one was produced, and report any unverified build or output property clearly.

This skill provides guidance only and grants no tools, packages, credentials, or permissions.
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
  Object.freeze({
    directoryName: "pdf-authoring",
    defaultActive: true,
    files: Object.freeze({
      "SKILL.md": pdfAuthoring,
      "scient.skill.json": `{
  "apiVersion": "scient.skills/v1alpha1",
  "id": "scient.pdf-authoring",
  "version": "0.1.0",
  "category": "Document creation",
  "categoryDescription": "Create polished documents and reliable final outputs.",
  "displayOrder": 40,
  "supportedScopes": ["user"],
  "defaultInvocationPolicy": "automatic",
  "origin": {
    "kind": "scient"
  }
}
`,
    }),
  }),
  Object.freeze({
    directoryName: "html-pdf-authoring",
    defaultActive: true,
    files: Object.freeze({
      "SKILL.md": htmlPdfAuthoring,
      "scient.skill.json": `{
  "apiVersion": "scient.skills/v1alpha1",
  "id": "scient.html-pdf-authoring",
  "version": "0.1.0",
  "category": "Document creation",
  "categoryDescription": "Create polished documents and reliable final outputs.",
  "displayOrder": 50,
  "supportedScopes": ["user"],
  "defaultInvocationPolicy": "automatic",
  "origin": {
    "kind": "scient"
  }
}
`,
    }),
  }),
  Object.freeze({
    directoryName: "latex-authoring",
    defaultActive: true,
    files: Object.freeze({
      "SKILL.md": latexAuthoring,
      "scient.skill.json": `{
  "apiVersion": "scient.skills/v1alpha1",
  "id": "scient.latex-authoring",
  "version": "0.1.0",
  "category": "Document creation",
  "categoryDescription": "Create polished documents and reliable final outputs.",
  "displayOrder": 60,
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
