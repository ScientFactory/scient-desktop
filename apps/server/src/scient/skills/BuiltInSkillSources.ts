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

The goal is to improve the workspace's readiness for a capable human or agent collaborator to understand its purpose, work in it safely, reproduce its work, and verify its results, while preserving the workspace's purpose and the user's intent.

Use a recent readiness review when available, but verify the relevant workspace evidence before changing it. Without a review, inspect enough to identify grounded improvements.

Make only changes that materially advance this goal. Where obstacles exist, remove or reduce them through the smallest coherent changes that address the user's request. Keep documentation truthful and consistent with the workspace.

Workspace-readiness work must not alter the user's substantive work itself (such as application behavior or source logic, a research or study protocol, an analysis, a draft, or other core content) unless the user separately asks for that change. It may clarify supporting documentation and, when safe, improve organization or names while preserving meaning, behavior, and references. Do not reorganize, rename, remove, broadly rewrite, or change tooling merely to enforce conventions. Ask before destructive, structurally disruptive, or materially broader changes.

This skill provides guidance only and grants no tools or authority. After making changes, verify them where practical. Report exactly what changed, where it changed, and why each change meaningfully improves readiness. Mention any important recommendation that remains unapplied.
`;

const pdfAuthoring = `---
name: pdf-authoring
description: Create, revise, or export PDF documents in Scient. Use when the user asks to create a PDF, change an existing PDF, or export another document as PDF. Do not use when the task only involves reading or extracting information from a PDF.
---

# PDF Authoring

The goal is to deliver a PDF that meets the user’s requirements and accurately report what was produced and verified.

## Choose a Method

Honor any format or editing method the user requests. When working from an editable source, preserve its format unless the user requests conversion or conversion is required to complete the task.

Choose the method based on the requested changes, available source, future editing needs, and the tools available:

- For an existing PDF, use direct PDF operations when they can make the requested changes while preserving the rest of the document.
- When authoring a document without an established source format, consider LaTeX for structured typesetting such as equations, citations, and cross-references, or HTML and CSS for browser-based layout and graphics.
- Consider other available authoring, export, or PDF-editing tools when they better fit the task.

Use the relevant dedicated skill and tools available for the selected method. Use \`latex-authoring\` for LaTeX and \`html-pdf-authoring\` for HTML-to-PDF; follow equivalent guidance for other methods when available.

## Produce and Verify the PDF

This skill grants no tools or authority. When the requested deliverable is a PDF, source alone is not completion: produce the actual PDF using an available build, export, or editing capability. If that cannot be completed, provide any useful work produced and clearly explain what remains.

Review the output against the requirements that matter for that document, including content completeness, readable layout, relevant text fidelity and navigation, and any explicitly requested page count.

Successful generation or editing does not establish visual quality. When visual review is available, inspect rendered pages of the resulting PDF. Prefer direct page rendering or a PDF preview tool over computer use when it provides the needed view. Inspect enough of the document to support the claims you make, fix material defects you observe, and verify the updated output. If visual inspection is unavailable, say so.

When reporting completion in Scient chat, provide clickable Markdown links to the final PDF and any editable source created or updated. Use the actual output path; when a tool returns \`outputPath\`, use it for that tool’s output. Wrap destinations containing spaces in angle brackets. If no PDF was produced, link any useful work created and state what remains. Briefly report what was verified and any material limitation.
`;

const htmlPdfAuthoring = `---
name: html-pdf-authoring
description: Create or revise HTML when it is the editable source for a PDF requested in Scient. Do not use for ordinary webpage work.
---

# HTML-to-PDF Authoring

Use this skill when HTML is the editable source for a requested PDF. Preserve the user's requirements and any existing source or design. Do not redesign or convert the document unless the user asks.

Scient's controlled renderer blocks remote resources, so keep required document assets available within the project. If the document depends on dynamic or lazy browser content, verify that the content actually appears in the PDF.

Ensure the document can paginate without clipping or large empty regions. Keep content together only when it can reasonably fit on one page. Treat an explicitly requested page count as a real output constraint. Verify it from the rendered PDF, and preserve the document's content and readability rather than padding, removing, or distorting content merely to reach the number.

This skill grants no tools or authority. When \`scient_pdf_build\` is available, use it to build the project-relative HTML source into the requested project-relative PDF. If no qualified build capability is available, link the editable HTML source, state clearly that no PDF was built, and tell the user they can open the HTML in Scient and choose **Export PDF**.

A successful build proves that a structurally valid PDF was produced; it does not prove visual quality. When visual review is available, inspect rendered page images or an equivalent preview of the resulting PDF, not only extracted text, page count, or metadata. Prefer direct page rendering or a PDF preview tool over computer use when it provides the needed view. Inspect enough of the document to support the claims you make, fix material defects you observe, rebuild when appropriate, and verify the updated PDF. If visual inspection is unavailable, say so.

When reporting completion in Scient chat, provide clickable Markdown links to the exact editable HTML source and the final PDF at the exact \`outputPath\` returned by the build. Wrap link destinations containing spaces in angle brackets. Report what was verified and any material property that remains unverified.
`;

const latexAuthoring = `---
name: latex-authoring
description: Create or modify LaTeX documents in Scient. Use when the user asks for LaTeX or a \`.tex\` file, when working in an existing LaTeX project, or when LaTeX is selected for PDF authoring.
---

# LaTeX Authoring

The goal is to produce maintainable LaTeX that meets the user's requirements, respects an existing project's conventions, and accurately reports what was built and verified.

## Author the LaTeX

Preserve an existing project's document class, engine, bibliography system, structure, and naming unless the user asks to change them.

Follow the project's existing engine declarations, magic comments, and preamble choices. Do not assume that a particular engine or package is available. If the document requires one that the available build path cannot support, report that requirement instead of silently changing the document's format or design. In a multi-file project, add a \`% !TEX root\` comment to a subordinate file only when Scient needs it to identify the compiled root, and make its path relative to that file.

Before reporting the source ready, make sure the document's commands, environments, and required characters are supported by its preamble and selected engine.

Preserve an existing project's hyperlink configuration. When the document uses a table of contents, citations, cross-references, or URLs, verify the intended navigation after compilation.

Keep \`.tex\` source files and required assets in the project. A clickable \`.tex\` link opens Scient's LaTeX Source, Split, and PDF surface and starts local compilation; a successful build displays the PDF.

## Build and Verify the PDF

This skill grants no tools or authority.

When the user asks for a PDF and \`scient_latex_build\` is available, call it with the project-relative \`.tex\` source path and intended project-relative \`.pdf\` output path. If it returns \`in-progress\`, wait at least \`retryAfterMs\` and call it again with the same paths; do not start a parallel build. Use the completed result's paths, page count, diagnostics, and warnings as the build evidence.

If direct build access is unavailable, provide a clickable Markdown link to the \`.tex\` source and state that PDF compilation was not verified. The user can open the source in Scient to use its built-in compiler. Creating or opening the source is not evidence that compilation succeeded.

A completed build proves that a structurally valid PDF was produced and published; it does not prove visual quality. When visual review is available, inspect rendered pages of the resulting PDF. Prefer direct page rendering or a PDF preview tool over computer use when it provides the needed view. Review the parts that matter for the document, such as equations, citations and references, pagination, figures, tables, and required characters. Fix material defects, rebuild when appropriate, and verify the updated PDF. If visual inspection is unavailable, say so.

When reporting completion in Scient chat, provide clickable Markdown links to the exact \`sourcePath\` and \`outputPath\` returned by the completed build. If \`rootSourcePath\` differs, also link it and identify it as the compiled root. Wrap destinations containing spaces in angle brackets. Report the actual \`pageCount\`, material diagnostics or warnings, and anything that remains unverified. Automatic opening in Scient does not replace these links.
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

Do not impose a universal structure, restate generic model behavior, or encode speculative edge cases. Add supporting resources only when they materially help, and make their use clear. Apply domain standards (such as evidence, uncertainty, and provenance in research) only when relevant.

## Choose Its Home and Invocation

A personal skill follows the user across projects. A project skill captures guidance or resources that belong to one initialized Scient workspace. Infer the intended home when the context is clear; otherwise discuss it with the user when the choice would materially affect the skill.

Create a project skill at \`.scient/skills/<name>/SKILL.md\`, with the frontmatter name matching the directory. Do not add \`scient.skill.json\`; that filename is reserved for reviewed packaged releases. A newly valid project skill is available automatically from the next message. The user can later choose Agent access, \`$name\` only, or Deactivated in Settings. Do not edit Scient's app-private preference store.

Save a personal skill with \`scient_skill_save\`, and read one of the user's skills with \`scient_skill_read\` before improving it. A new personal skill is on for every agent from the user's next message; saving over one keeps the earlier version, and the user can turn it off or undo the change in Settings. When the user gave rough material (notes, a document, a partial skill), keep what they meant and finish the rest; ask only about choices that change what the skill is for.

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

The goal is to assess the workspace's readiness for a capable human or agent collaborator to understand its purpose, work in it safely, reproduce its work, and verify its results, and to identify meaningful improvements when needed.

Evaluate the workspace from evidence actually present. Judge it by its purpose (code, research, study, writing, or a mixture) not by a universal repository template.

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

const overleafSync = `---
name: overleaf-sync
description: Link project folders to Overleaf projects and sync them in Scient. Use when the user mentions Overleaf, asks to bring in, link, sync, push to or pull from an Overleaf project, or when a file has Overleaf conflict marks.
---

# Overleaf Sync

The goal is to keep a paper in a Scient project and its Overleaf project in step, losing nobody's text, and to report plainly what moved each way.

You can do with Overleaf whatever the user can do in Scient. The tools ask no one for approval: do what the user asked, then report the result lines. This skill grants no tools or authority.

Here means the linked folder on this project's server. For a remote project, Git 2.39 or newer and the project files must be on that server.

## The Folder Model

- One Overleaf project is one document (a paper, thesis, slide deck or grant). It lives in its own folder inside the Scient project, and everything in that folder syncs. Nothing outside it ever does.
- A project can hold several Overleaf folders side by side, for example \`paper/\` and \`slides/\`. A linked folder is never inside another.
- Keep code, data and analysis outside Overleaf folders. Write figures for the paper into its folder, for example \`paper/figures/\`; the next sync sends them.
- Bring a project in as a new folder by default (\`scient_overleaf_connect\` with mode \`new-folder\`), named after the paper. Link an existing folder (mode \`link-folder\`) only when it already holds just the paper. Link the project's top folder only when the whole project is the paper. If the connect result says the folder looks like more than a paper, tell the user and prefer a new folder.

## The Token

Syncing needs the user's Overleaf Git token (Git access needs a paid Overleaf plan, the user's or the project owner's). When a tool says no token is saved, or that Overleaf refused it:

1. Call \`request_secret\` with the label "Overleaf Git token", explaining that the user creates it in Overleaf under Account settings, Git integration.
2. Call \`scient_overleaf_token\` with action \`save\` and the returned \`secretRef\`.

Never ask for the token in chat, never write it anywhere, and never repeat it.

## Syncing

1. Find the link with \`scient_overleaf_status\`; it lists each linked folder's \`connectionId\` and status without going online.
2. Optionally preview with \`scient_overleaf_preview\`: what would come in and be sent, and any conflicts. Pass \`diff: true\` for bounded before/after text from the sync base to the fetched and publication trees; binary and oversized files are listed without contents. A stale diff needs another preview.
3. Sync with \`scient_overleaf_sync\`. It saves the folder's open editors, brings Overleaf's changes in, then sends the folder's changes. New files, deletions, renames and older versions all sync, then get reported.
4. New files are sent by default, except build output, hidden files and Scient's own project files. Send one of those with \`files.send\`. Keep a new file only here (notes to self, for example) with \`files.keepOnlyHere\`; it stays out until you send it the same way.
5. Report the result lines to the user: what came in, what was sent, renames (Overleaf drops comments and tracked changes on renamed files), older versions sent, and any other agents working in the same copy.

If the thread works in a separate worktree, the tools act on the copy the link belongs to and say so. Your edits in the worktree reach Overleaf only after they are merged into that copy.

## Conflicts

A conflict stops a sync until you settle it; other problems stop it with a message to report. None of the stopped review's changes are applied; the result first says if the sync finished an interrupted sync or applied an earlier attempt before it stopped. Each conflict has a key and allowed choices:

- \`mine\` keeps this folder's version; \`theirs\` takes Overleaf's.
- \`markers\` writes both versions into the file between conflict marks (\`<<<<<<<\`, \`=======\`, \`>>>>>>>\`).

Decide the way you would for a Git merge conflict: follow the user's instructions, and when both sides hold real work, choose \`markers\` and merge. Call \`scient_overleaf_sync\` again with one choice per key and the \`reviewedRemote\` the result gave. If Overleaf changed meanwhile, the result shows a new review whose conflicts your choices don't answer; decide again for them. For \`markers\`, edit each marked file so it keeps the intended text from both sides, remove every mark, check the document still builds, then sync again. A file with marks is not sent until its marks are gone; everything else is. If the marks are the file's real content (a guide that quotes them), send it as it is with \`files.release\`. Explain your merge choices to the user.

The version a sync replaced is kept as a copy. \`scient_overleaf_kept_copies\` lists them and restores one.

## Undo

Undo puts back what Overleaf had before one send: for example after an older branch's files were sent over a collaborator's newer text, or a deletion was sent by mistake. \`scient_overleaf_undo\` without \`attemptNumber\` lists the sends you can undo, with what each changed. With the send's number (\`send #N\` in a sync result) it saves the open editors, puts back the earlier version of every file that send changed, keeps the replaced files as copies, then syncs. A file edited since that send is left as it is and reported. Tell the user what was put back and what was left.

## When Something Stops

Errors name what happened and what to do next: Overleaf unreachable, a missing or refused token, an editor that could not save, a link to relink (\`scient_overleaf_manage\` with action \`relink\`), or an interrupted sync to recover (action \`recover\`). Action \`cancel\` asks a running sync to stop before its next step. Do what the message says, or tell the user when only they can fix it.
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
  "version": "0.3.1",
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
  "version": "0.3.1",
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
  "version": "0.3.1",
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
  Object.freeze({
    directoryName: "overleaf-sync",
    defaultActive: true,
    files: Object.freeze({
      "SKILL.md": overleafSync,
      "scient.skill.json": `{
  "apiVersion": "scient.skills/v1alpha1",
  "id": "scient.overleaf-sync",
  "version": "0.1.0",
  "category": "Document creation",
  "categoryDescription": "Create polished documents and reliable final outputs.",
  "displayOrder": 70,
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
    directoryName: "connector-authoring",
    defaultActive: true,
    files: Object.freeze({
      "SKILL.md": `---
name: connector-authoring
description: Find, add, build, test, fix or improve a connector (an MCP server) in Scient. Use when the user asks for a connector or to connect a service, asks to make, fix, repair or improve a connector or MCP server, when a connector stopped, needs sign-in or returns errors, or when the user needs to reach a service, website, database, file collection or command-line tool that no installed connector or Scient tool covers, including sites with no public API that the user signs in to.
---

# Connector Authoring

A connector gives agents tools for one service. In Scient it is a folder with a
\`manifest.json\` (MCP Bundle format) and a small Node program. Scient starts it, hands it keys
and sign-ins from Accounts, and checks it before it goes in. The goal: a connector that does
the user's real tasks, returns correct data, stays signed in, and holds no secret in its files.

This skill grants no tools or permissions.

## Make a connector

1. **Add one that exists before building.** \`scient_connector_list {query}\` (for example
   \`{"query":"gmail"}\`) shows the user's connectors and ones Scient can add from Discover and
   the MCP Registry. If one fits, \`scient_connector_add {from}\` with its \`name\` adds it, on for
   every project; a key or the user's own sign-in app it needs is asked in a private card.
   Then follow its message (\`scient_connector_setup\` for \`needs-setup\`,
   \`scient_connector_control {action: "sign-in"}\` for \`needs-sign-in\`). New chats get its
   tools; in this chat, call them through \`scient_connector_check {connector, calls}\`.
   \`scient_connector_add\` also takes an https MCP address or a \`.mcpb\` file. Build one only when none fits; an
   entry's \`reason\` says why it can't be added, a good place to start. Also check Scient's own
   tools (papers, sources, accounts, compute). If the work is one-off, a script fits better; if
   it is know-how rather than access, a skill does (\`scient-skill-authoring\`).
2. **Ask briefly**, in one message and only what you don't know: which service (a link), the
   two or three things they want to do with it (with an example), and how they sign in (an API
   key, a university or site login, nothing).
3. **Choose the kind:**
   - a web API with a key or none: \`auth-and-sessions.md\` for keys, \`science-apis.md\` for
     science services;
   - an API that only offers OAuth: the template can't sign in with OAuth yet; read
     \`auth-and-sessions.md\`, "OAuth APIs", for what to do instead;
   - a website the user signs in to, with no documented API: \`study-a-website.md\` first, then
     \`auth-and-sessions.md\`;
   - files, a database or a command-line tool on this computer: \`local-tools.md\`.
4. **Plan a few tools** shaped like the user's tasks, not one per endpoint. Read
   \`tool-design.md\`. Tell the user the plan in a few lines and go on.
5. **Build from the template.** \`scient_connector_copy {name}\` writes a working connector to
   \`connectors/<slug>/\` (an OpenAlex example with no dependencies). Read its \`README.md\`,
   replace the example tools in \`server.mjs\`, and update \`manifest.json\`. Keep \`mcp.mjs\`,
   \`http.mjs\` and \`session.mjs\` unless you have a reason. Scient runs Node connectors on its own
   Node, and npm may be missing: add libraries only when truly needed, installed inside the
   folder.
6. **Test with real calls.** \`scient_connector_check {folder, calls}\` with real inputs from the
   user's tasks. For a site the user signs in to, add \`signIn\` with the name of their Accounts
   sign-in, so the check runs signed in. Read the data: it must match the source, not just
   arrive. See \`testing.md\`. Fix and check again until it passes.
7. **Save and set up.** \`scient_connector_save {folder}\`. When it says \`needs-setup\`, call
   \`scient_connector_setup {connector}\`: keys open a private card, a sign-in links the user's
   Accounts sign-in. Then check once more with \`connector\` set, so it uses them. (\`signIn\` is
   only for a folder that isn't saved yet.) New chats get its tools; in this chat, call them
   through \`scient_connector_check {connector, calls}\`.
8. **Report** in a few lines: what it does, its tools, what you tested with one real result,
   what you didn't test, and how to take it back: a new connector has nothing earlier to go
   back to, so the user removes it on its page (Remove can be undone); after a fix, its page
   has **Undo last change**.

## Fix or improve a connector

1. **Find what is wrong.** \`scient_connector_list\` gives each connector's status (\`ready\`,
   \`needs-setup\`, \`needs-sign-in\`, \`error\`, \`off\`) and last error. \`scient_connector_check
   {connector}\` (no folder) tests an installed one, hosted or local, and lists its tools;
   with \`calls\` it makes them too.
2. **A hosted connector** (it runs online) has no code to fix. \`needs-sign-in\`:
   \`scient_connector_control {connector, action: "sign-in"}\` opens its sign-in in this chat's
   browser for the user to finish; then check again. \`off\`: \`action: "on"\`. Other errors are
   the service's: tell the user what it said.
3. **A local connector**: \`needs-setup\` is \`scient_connector_setup\`. A one-off failure may need
   only \`scient_connector_control {connector, action: "restart"}\`. Otherwise copy and fix it:
   1. \`scient_connector_copy {connector}\` copies it into this chat's folder and returns its
      status, last error and log. For an npm or PyPI package connector, the package's code
      comes too, in \`package/\`, with its dependencies; \`source\` says where to edit. A command
      that runs a script outside its folder is named in \`source\`: copy the script in to change
      it.
   2. Read the error, the log and the code. Read \`fixing.md\`.
   3. Reproduce with \`scient_connector_check {folder, connector, calls}\`, using the call that
      failed.
   4. Make the smallest fix. Keep tool names, inputs and result fields.
   5. Check again: the failing call and the calls that worked before.
   6. \`scient_connector_save {folder, connector}\`. Scient keeps the old version (Undo on the
      connector's page). A vendor's connector or a package becomes the user's own copy; say
      so.

Turning connectors on, off or restarting them needs no question first. Removing one is the
user's: tell them where (its page in Settings → Extensions).

Go from the diagnosis to the saved fix in one go; don't stop to ask whether to go ahead.
Ask only when the fix needs something from the user (a key, a sign-in, a choice of behaviour).

## Hard rules

- **Secrets only through Scient.** Keys, passwords, tokens and cookies never go in chat, code,
  \`manifest.json\`, files, logs or results. Keys reach the program through setup and Accounts,
  as environment variables; sign-ins as Scient's cookie files. Never ask for a key in chat.
- **The user's own account, used fairly.** Only their account, for their own use. Respect the
  site's terms; if they forbid automated access, say so and stop. Be polite: pace requests,
  back off when limited, identify honestly. Send the browser's user agent only with the
  user's own sign-in session (\`SCIENT_SIGN_IN_USER_AGENT\`), never to get past a bot check.
- **Never get past a captcha or 2FA yourself.** Hand it to the user.
- **Read first.** Explore by reading. Ask the user before any request that changes data
  (submit, post, delete, enroll, pay), while studying and when testing.
- **No captures with secrets.** Never save request captures, HAR files, cookies or page dumps
  in the connector or the project. Use masked or made-up values in notes and tests.

## References

- \`references/tool-design.md\`: when planning or changing tools (names, schemas, results,
  paging, errors, annotations).
- \`references/auth-and-sessions.md\`: when the connector needs a key, OAuth, or the user's
  sign-in to a website, and how it stays signed in.
- \`references/study-a-website.md\`: before building for a site with no documented API.
- \`references/science-apis.md\`: when using OpenAlex, NCBI, arXiv, Crossref, Semantic Scholar,
  ClinicalTrials.gov, Zotero, Moodle or a similar service.
- \`references/local-tools.md\`: for local files, databases and command-line tools.
- \`references/testing.md\`: before calling a connector done.
- \`references/fixing.md\`: when a connector fails or the user asks to improve one.
- \`references/sources.md\`: where these methods come from.
- \`templates/\`: the connector \`scient_connector_copy\` writes; read its \`README.md\`.
`,
      "scient.skill.json": `{
  "apiVersion": "scient.skills/v1alpha1",
  "id": "scient.connector-authoring",
  "version": "0.1.0",
  "category": "Connector creation",
  "categoryDescription": "Make and fix connectors that give agents tools for a service.",
  "displayOrder": 35,
  "supportedScopes": ["user"],
  "defaultInvocationPolicy": "automatic",
  "origin": {
    "kind": "scient"
  }
}
`,
      "references/auth-and-sessions.md": `# Keys, sign-ins and staying signed in

Read this when a connector needs a key, a token, an OAuth app, or the user's sign-in to a
website. The rule behind all of it: secrets live in Scient's Accounts. The connector gets
them at start, through its environment, and never stores, prints or asks for them.

## Pick the way in

| The service has                                                                                                     | Use                                    | The program gets        |
| ------------------------------------------------------------------------------------------------------------------- | -------------------------------------- | ----------------------- |
| A public API, no key                                                                                                | Nothing                                | None                    |
| An API key or a personal token (OpenAlex, NCBI, Semantic Scholar, Zotero, GitHub)                                   | A \`user_config\` key                    | An environment variable |
| A token the user makes in the site's settings (Moodle "security keys", a library's API token)                       | A \`user_config\` key, same as above     | An environment variable |
| Only OAuth                                                                                                          | See "OAuth APIs" below                 | None                    |
| No API, or an API that works only with the browser's session (most university portals, library sites, course sites) | A website sign-in (\`signIn\`)           | Cookie files            |
| Files or a database on this computer                                                                                | Settings of type \`directory\` or \`file\` | Paths                   |

## API keys

Declare the key in \`manifest.json\` and map it to an environment variable. Keys go in \`env\`
only; Scient refuses a key in \`args\`, where other programs could read it.

\`\`\`json
"user_config": {
  "api_key": {
    "type": "string",
    "title": "NCBI API key",
    "description": "Optional. Make one in your NCBI account settings; it raises the limit to 10 requests a second.",
    "sensitive": true,
    "required": false
  }
},
"server": {
  "type": "node",
  "entry_point": "server.mjs",
  "mcp_config": {
    "command": "node",
    "args": ["\${__dirname}/server.mjs"],
    "env": { "NCBI_API_KEY": "\${user_config.api_key}" }
  }
}
\`\`\`

- \`sensitive: true\` with \`type: "string"\` makes it a key: Scient keeps it in Accounts (an
  API-key account linked to the connector), not in the connector's settings.
- \`required: true\` when nothing works without it. A connector with a missing required key is
  still added; it shows Needs setup, and its tools tell the agent to run setup.
- In code: \`const key = process.env.NCBI_API_KEY?.trim() ?? "";\`. An unanswered optional key
  arrives as an empty string.
- Start and list tools without the key. The tools that need it throw
  \`needsSetup("The NCBI API key")\` (from \`mcp.mjs\`).
- Send it in a header when the API allows (\`Authorization: Bearer …\`, \`x-api-key\`), not in the
  URL. If it must go in the URL, use \`safeUrl()\` for anything you log or return.
- When the API refuses the key (401, or 403 with an "invalid key" body), say so: "The key
  was refused. Call scient_connector_setup with replaceKeys."
- After \`scient_connector_save\` returns \`needs-setup\`, call
  \`scient_connector_setup {connector}\`. Each key opens a private card where the user pastes it,
  or links a key they already saved. Never ask for a key in chat and never use
  \`request_secret\` for a connector key.

Plain settings (a site address, a default folder) are \`user_config\` fields without
\`sensitive\`. Ask the user in chat, then pass them as \`settings\` to \`scient_connector_setup\`.

## Website sign-ins

For a site the user signs in to with a username and password (often with an authenticator
code or a university single sign-on).

### Declare it

\`\`\`json
"_meta": {
  "com.scientfactory.scient": {
    "signIn": { "site": "https://moodle.example.edu" }
  }
}
\`\`\`

\`site\` is the origin only (\`https://\` and the host, no path). Setup lists the sign-in as missing until the user
links it to an Accounts website or university sign-in for that site. \`scient_connector_setup\`
offers that.

### What the program gets

| Variable                     | Holds                                                                                                                                                                                                      |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| \`SCIENT_SIGN_IN_SITE\`        | The site's origin.                                                                                                                                                                                         |
| \`SCIENT_SIGN_IN_COOKIES\`     | Path to a JSON file: \`[{name, value, domain, path, expires, secure, httpOnly, sameSite}]\`.                                                                                                                 |
| \`SCIENT_SIGN_IN_COOKIES_TXT\` | The same cookies in Netscape format, for curl (\`-b\`) or Python (\`http.cookiejar.MozillaCookieJar\`).                                                                                                        |
| \`SCIENT_SIGN_IN_USER_AGENT\`  | The user agent of the browser the cookies came from. \`session.mjs\` sends it with the session, because some sites end a session that arrives from another browser. Use it only with the user's own session. |

The files are private, rewritten at each start and after each new sign-in, and removed with the
connector. The program never gets the password: Scient signs in, not the connector.

### Use it

\`\`\`js
import { createHttp } from "./http.mjs";
import { createSession } from "./session.mjs";

const http = createHttp({ userAgent: "moodle-connector/0.1 (Scient connector)", minGapMs: 500 });
const session = createSession({ http });

// In a handler:
const data = await session.json("/webservice/…", {}, { signal });
const page = await (await session.fetch("/my/courses.php", {}, { signal })).text();
\`\`\`

\`session.fetch\` reads the cookie file (again when Scient rewrites it), sends only the cookies
that belong to each host, keeps cookies the site sets while it runs (sessions that refresh on
each request), follows redirects itself, and throws the expired error when the session is gone.
Pass headers as a plain object.

### Know when the session has ended

\`session.fetch\` treats these as ended:

- a redirect to a sign-in page (paths like \`/login\`, \`/signin\`, \`/sso\`, \`/saml\`,
  \`/cas/login\`, \`/idp/\`, or hosts like \`login.microsoftonline.com\`);
- status 401 (and 419 or 440, used by some frameworks);
- an HTML page with a password field where data was expected.

Tune it for the site, after you have seen what the site sends a signed-out visitor (open the
same URL in a tab without the sign-in, or look at the response right after the session ends):

- \`loginPath\`: a regular expression for the site's own sign-in path, when it differs.
- \`isSignedOut(response, body)\`: a site-specific check, e.g. a JSON body with
  \`"errorcode":"requireloginerror"\`.
- \`forbiddenMeansExpired: true\` only for a site known to send 403 when the session ends. By
  default a 403 means "no access to this", which a new sign-in would not fix.

Throw \`signInExpired(site, why)\` yourself for any other sign. The tool error then starts with
\`SCIENT_SIGN_IN_EXPIRED\`. Only use it for a real end of session: each one makes Scient sign in
again, and a false one ends with the user being asked to sign in for nothing.

### What happens then

Scient sees the marker, signs the account in again in its own browser profile with the saved
username, password and authenticator code, rewrites the cookie files, restarts the program,
and retries the call once. The agent sees the retried result.

If the site needs the person (a captcha, a text-message code, a new device check), the agent
sees "<site> needs you to sign in: open Settings → Accounts, or the connector's page", and the
connector shows Needs sign-in with a Sign in button. Tell the user exactly that, once. Don't
retry in a loop.

### Tokens inside pages

Many sites also need a value from a page: a CSRF token, Moodle's \`sesskey\`, a request id.

- Get it from the page or API that hands it out (\`session.fetch\` the page, read it from the
  HTML or embedded JSON), keep it in memory for this run, and get it again when the site says
  it is invalid.
- Never write it to a file and never return it in a result.

### Never

- Read, ask for, type or store the user's password, authenticator secret or one-time codes in
  the connector. Scient does the signing in.
- Sign in from the connector (posting the login form). It skips the user's saved
  authenticator, trips bot checks, and can lock the account.
- Copy cookies into the connector's folder, a test file, a log or a result.
- Send cookies to any host but the site's own (\`session.fetch\` doesn't).
- Keep sessions alive with pings or background loops. Scient signs in again when needed.

### While building

A folder you haven't saved can still be checked signed in. The order that works:

1. Study the site in Scient's browser, signed in with \`scient_account_sign_in\` or by
   \`preview_open\` with a saved sign-in (\`study-a-website.md\`).
2. Check without a sign-in first: the program must start and list its tools, and a tool call
   must return the "no sign-in yet" message, not crash.
3. Check signed in: \`scient_connector_check {folder, signIn, calls}\`, where \`signIn\` is the name
   of the user's Accounts sign-in for the site (\`scient_accounts_list\` shows it). If they have
   none, \`scient_account_add\` with kind \`website\` asks them to add one. Fix until real calls
   return real data.
4. Save. If the result is \`needs-setup\` with the sign-in missing, call
   \`scient_connector_setup {connector}\`, which links the sign-in. After that,
   \`scient_connector_check {folder, connector, calls}\` uses the connector's own sign-in.

\`scient_account_browser_session\` exports a site's cookies to private session files for curl
while you study. Use it for reading requests only, and never copy those files anywhere.

## OAuth APIs

The template doesn't support OAuth yet: a connector made from it gets its credentials from
the environment and can't run an OAuth sign-in or keep one fresh. A package connector (npm or
PyPI) that runs its own OAuth sign-in can be added and used as it is.

1. Prefer a personal access token or API key if the service offers one (GitHub, GitLab,
   Zotero, Zenodo, Figshare and many others do). Treat it as a key.
2. If the vendor runs its own remote MCP server, suggest adding that in Extensions instead: it
   signs in with OAuth through Scient.
3. If the site works in the browser, a website sign-in may reach the same data.
4. If none of these fit, tell the user plainly that a connector made with the template
   can't sign in to this service yet, because it offers only OAuth. Don't embed a client
   secret, and never use the user's password to get a token (the "password grant").

## Local files, databases and programs

They need settings, not secrets: see \`local-tools.md\`. A database password is still a key
(\`sensitive: true\`, in \`env\`).
`,
      "references/fixing.md": `# Fixing a connector

Read this when a connector stopped, fails a tool call, returns wrong data, or the user asks to
improve one. The aim is the smallest change that makes it work again, checked the same way it
failed.

## 1. Get a copy and the facts

\`scient_connector_copy {connector}\` copies it to \`connectors/<slug>/\` in this chat's folder and
returns its status, the last error and the recent log (keys removed). Work only on that copy.
Read \`manifest.json\`, the README (its request map and test questions, if any) and the code.

A package connector (\`npx\` or \`uvx\` in its manifest) arrives with the package's code in
\`package/\`: an npm package with its dependencies in \`node_modules/\`, a PyPI package with
\`server.py\` starting it and its dependencies listed in \`pyproject.toml\` (uv installs them into
\`.venv/\` when it starts). The copy's \`source\` says where to edit. Change the package's own
files; to change a dependency's version, edit \`pyproject.toml\` or reinstall it in the folder
with npm. If \`source\` says npm or uv is missing, fix only what the manifest runs, or ask the
user to install it.

## 2. Reproduce it

Run \`scient_connector_check {folder, connector, calls}\` with \`connector\` set, so the check uses
the user's settings, keys and sign-in, and with the call that failed. A fix you can't reproduce
is a guess: if it doesn't fail now, say so, and look in the log for when and how it failed.

## 3. Find the cause

| What you see                                                                                 | Likely cause                                                                                           | Fix                                                                                              |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| \`Cannot find module …\`                                                                       | \`entry_point\` or \`args\` name a file that isn't there                                                   | Point them at the real file; keep \`\${__dirname}/…\`.                                              |
| \`SyntaxError: Cannot use import statement\` or \`Unexpected token 'export'\`                    | ES module code in a \`.js\` file without \`"type": "module"\`                                              | Use \`.mjs\`, or add a \`package.json\` with \`"type": "module"\`.                                     |
| \`fetch is not defined\`, or other missing built-ins                                           | An old Node on PATH runs it                                                                            | Use \`server.type: "node"\` with \`command: "node"\`, so Scient runs it on its own Node.             |
| A missing package                                                                            | Its \`node_modules\` isn't in the folder                                                                 | Install inside the folder, or remove the dependency.                                             |
| It exits at once with no error                                                               | It writes to stdout, exits when a key is missing, or crashes on start                                  | Logs to stderr only; start without keys; read the log.                                           |
| Every call gets 401                                                                          | The key changed or was revoked                                                                         | \`scient_connector_setup {connector, replaceKeys: […]}\`.                                          |
| \`SCIENT_SIGN_IN_EXPIRED\` on every call, or "needs you to sign in" when the user is signed in | False alarm: a 403 for "no access", a page that has a password field, a changed sign-in path           | Tighten the check: \`loginPath\`, \`isSignedOut\`, \`forbiddenMeansExpired\` (\`auth-and-sessions.md\`). |
| "needs you to sign in"                                                                       | The site wants the person (captcha, text code)                                                         | Tell the user to sign in from Accounts or the connector's page. Nothing to fix in code.          |
| 404, a changed JSON shape, empty results that used to be full                                | The site changed                                                                                       | See "When the site changed".                                                                     |
| 429 or blocked                                                                               | Too many requests                                                                                      | Slow down (\`minGapMs\`), fetch less, cache.                                                       |
| Time-outs                                                                                    | Pages too big or a slow endpoint                                                                       | Smaller pages, a longer \`timeoutMs\` for that call only.                                          |
| Fails only on Windows                                                                        | Paths joined by hand, CRLF line endings in parsing, a \`.cmd\` or \`.bat\` program started without a shell | Use \`node:path\`, split lines on \`/\\r?\\n/\`, and see \`local-tools.md\` for starting programs.       |
| JSON parse errors                                                                            | The site sent HTML: an error page, maintenance, or the sign-in page                                    | Check the content type first (\`readJson\` and \`session.json\` do).                                 |

## 4. When the site changed

1. Do the task by hand in Scient's browser and list the requests (\`study-a-website.md\`).
2. Compare with the request map in the README: renamed paths, new required parameters, a new
   token, a new GraphQL hash, renamed fields.
3. Change only what moved. Update the map and its date.

## 5. Keep the fix small

- Change what broke, nothing else. No rewrites, no new style, no renamed tools.
- Keep tool names, parameters and result fields: agents and skills depend on them. If a
  result must change, add a field rather than rename one.
- Bump \`version\` in \`manifest.json\` (the last number for a fix).

## 6. Check, then save

- Check again with the call that failed and the calls that worked before.
- \`scient_connector_save {folder, connector}\`. Scient checks it, swaps it in, restarts it and
  keeps the old version; the connector's page has **Undo last change**.
- A connector someone else published (a vendor's bundle) is never changed in place: your fix
  becomes the user's own copy, shown as "Your copy of …". Tell the user that updates from the
  publisher won't reach this copy, and suggest reporting the problem to them if it is public.

## 7. Tell the user

What broke, what you changed (a line or two), how you checked it, and that Undo is on the
connector's page.
`,
      "references/local-tools.md": `# Local files, databases and command-line tools

Read this when a connector works with things on the user's computer: a folder of data, a
database file, or a program the user already has (a lab instrument's command-line tool, an
analysis script, \`pandoc\`, \`samtools\`).

## Settings, not hard-coded paths

- Ask for folders and files with \`user_config\` fields of type \`directory\` or \`file\`. Pass
  them in \`env\` (or \`args\`; they are not secrets). Give a \`default\` with \`\${HOME}\`,
  \`\${DOCUMENTS}\` or \`\${DOWNLOADS}\` when there is an obvious one.
- A program the user has: a \`file\` setting for its path, or look it up on PATH (Scient gives the
  connector the user's login environment). If it isn't there, start anyway and have the tools
  say what to install or set.
- To work in the chat's project folder instead of the connector's own folder, set
  \`_meta["com.scientfactory.scient"].workingDirectory\` to \`"project"\`.

## Files

- Use \`node:path\` to build paths (\`path.join\`), never string joins. Windows uses \`\\\` and
  drive letters.
- Resolve every path the agent passes against the allowed folder and refuse anything outside
  it (\`path.relative(root, target)\` must not start with \`..\` or be absolute).
- Read by default. A tool that writes or deletes files is a separate tool that says so.
- Return text, not whole files: the first lines, a summary, or a page with paging. Return
  paths the agent can open, not file contents, for large or binary files.

## Databases

- Open them read-only. With Node's built-in SQLite:
  \`new DatabaseSync(file, { readOnly: true })\` (from \`node:sqlite\`).
- When an app keeps the file open and locked (Zotero's \`zotero.sqlite\` while Zotero runs),
  read a fresh copy in a temporary folder and say the data is as of that copy. Prefer the
  app's own local API when there is one (Zotero: \`http://localhost:23119/api/\`).
- Always use bound parameters (\`prepare("… where id = ?").all(id)\`), never SQL built from
  the agent's text.
- \`node:sqlite\` works without flags from Node 22.13; Scient's own Node has it. A connector
  that must also run on older Node checks for it and says what is needed.
- Other databases (Postgres, MySQL) need a driver library; see "Libraries" in the template
  README. Their password is a key (\`sensitive: true\`).

## Command-line tools

- Start programs with \`execFile\` or \`spawn\` and an array of arguments, never a shell command
  string built from the agent's input.
- On Windows, \`.cmd\` and \`.bat\` programs (most npm tools) need a shell: call
  \`cmd.exe /d /s /c\` with the program and arguments, quoting each argument, or call the
  program's real \`.exe\`.
- Set a timeout and a cap on output (\`maxBuffer\`). Kill the process when the call is cancelled
  (pass the handler's \`signal\` to \`spawn\`).
- Read the program's exit code and stderr. A failure becomes a tool error with the last useful
  line of stderr and what to try.
- Prefer the program's machine-readable output (\`--json\`, \`--format tsv\`) to parsing text
  meant for people.
- Don't wrap a program that only needs one run; a script or Scient Compute fits that better.
`,
      "references/science-apis.md": `# Science APIs: limits and manners

Read this when a connector uses one of these services, or one like them. Facts were read on
2026-11-10 from each service's own pages, except where marked "(not re-read)". Limits change:
open the linked page before building, and read the rate-limit headers the API sends at run time.

## Manners for every API

- Ask only for what the task needs: choose fields (\`select=\`, \`fields=\`), small pages.
- One request at a time per host, with a gap under the limit (\`createHttp({minGapMs})\`; per
  host with \`hostGapMs\`). The limit is per user, per key or per address, across all their
  programs, so stay well under it.
- On 429 or 503, wait (\`Retry-After\` when given) and retry a few times, then tell the agent to
  slow down. \`http.mjs\` does this for GET and HEAD.
- Say honestly who is calling in \`User-Agent\`. Where an API asks for a contact email, make it
  a plain setting the user fills in; don't send the user's email without their OK.
- Use batch requests for lists of ids (a filter with \`|\`, NCBI \`id=1,2,3\`) instead of one
  request per id.
- For whole-corpus work (every paper in a field), use the service's bulk downloads, not the API.
- A key is usually optional but raises limits. Offer it as an optional \`user_config\` key.

## The services

| Service                                                                                                                                                                                                                                                                          | Key                                                                                                                                                                     | Limits                                                                                                                                                                               | Paging                                                                                                                                                            | Watch out for                                                                                                                                                                                                                                                                                                                                                  |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **OpenAlex**: scholarly works, authors, institutions. \`https://api.openalex.org\` ([docs](https://help.openalex.org/api/))                                                                                                                                                        | Optional, free. Send as \`Authorization: Bearer\` or \`api_key=\`. A key gives 10× the daily budget.                                                                        | 10 requests/s without a key, 30 with a free key. Budget in \`X-RateLimit-Remaining\`, \`X-RateLimit-Reset\`; also \`GET /rate-limit\`.                                                     | \`per_page\` ≤ 100; \`page\` × \`per_page\` ≤ 10,000. \`cursor=*\` then \`meta.next_cursor\` for more, but following a cursor needs a key (401 without).                    | \`select=\` takes top-level fields only. Filters: \`,\` is AND, \`\\|\` is OR. URLs over ~8 KB fail with 400. Abstracts come as an inverted index.                                                                                                                                                                                                                    |
| **NCBI E-utilities**: PubMed, PMC, Gene and more. \`https://eutils.ncbi.nlm.nih.gov/entrez/eutils/\` ([key and limits](https://support.nlm.nih.gov/knowledgebase/article/KA-05317/en-us))                                                                                          | Optional \`api_key=\` (from the user's NCBI account).                                                                                                                     | 3 requests/s per address without a key, 10/s per key, for all E-utilities together.                                                                                                  | ESearch \`retstart\`/\`retmax\` (retmax up to 10,000); for big sets, \`usehistory=y\` and page with \`WebEnv\` + \`query_key\` (not re-read).                               | Send \`tool=\` (the connector's name) and, if the user agrees, \`email=\` (not re-read). Many results are XML; EFetch formats differ by database. Large jobs belong off-peak or on the FTP baseline.                                                                                                                                                               |
| **arXiv**: preprints. \`https://export.arxiv.org/api/query\` ([terms](https://info.arxiv.org/help/api/tou.html), [manual](https://info.arxiv.org/help/api/user-manual.html))                                                                                                       | None.                                                                                                                                                                   | One request every 3 s, one connection at a time, across all the user's machines. Set \`hostGapMs: {"export.arxiv.org": 3000}\`.                                                        | \`start\` (from 0) and \`max_results\` (≤ 2,000 per call, 30,000 per query).                                                                                          | Answers are Atom XML, errors too (an entry with the error). Results change only when new papers arrive: cache.                                                                                                                                                                                                                                                 |
| **Crossref**: DOI metadata. \`https://api.crossref.org\` ([access](https://www.crossref.org/documentation/retrieve-metadata/rest-api/access-and-authentication/), [tips](https://www.crossref.org/documentation/retrieve-metadata/rest-api/tips-for-using-the-crossref-rest-api/)) | None for public and polite use; a paid Plus token for more.                                                                                                             | Public: 5 requests/s, 1 at a time. Polite (a \`mailto=\` or contact in \`User-Agent\`): 10/s, 3 at a time. Headers \`x-rate-limit-limit\`, \`x-rate-limit-interval\`, \`x-concurrency-limit\`. | \`rows\` ≤ 1,000. \`cursor=*\` then \`next-cursor\`; stop when a page has fewer than \`rows\`.                                                                            | 429 means slow down; 403 means you were blocked. Always \`select=\` the fields.                                                                                                                                                                                                                                                                                  |
| **Semantic Scholar**: papers, citations. \`https://api.semanticscholar.org/graph/v1\` ([API](https://www.semanticscholar.org/product/api), [tutorial](https://www.semanticscholar.org/product/api/tutorial))                                                                       | Optional, by request. Header \`x-api-key\`.                                                                                                                               | Without a key, one pool shared by everyone, throttled when busy: expect 429s. A new key: 1 request/s on all endpoints.                                                               | \`/paper/search\`: \`offset\`, \`limit\` ≤ 100, at most 1,000 results. \`/paper/search/bulk\`: a \`token\` from the previous answer, up to 1,000 per call.                  | Ask for fields with \`fields=\`; the defaults are thin. Use batch endpoints for lists of ids.                                                                                                                                                                                                                                                                    |
| **ClinicalTrials.gov**: trial registry, API v2. \`https://clinicaltrials.gov/api/v2/studies\` ([OpenAPI](https://clinicaltrials.gov/api/oas/v2))                                                                                                                                   | None.                                                                                                                                                                   | Not stated in the spec read; stay near 1 request/s.                                                                                                                                  | \`pageSize\` (default 10, max 1,000), \`pageToken\` from \`nextPageToken\`; repeat the other parameters on each page. \`countTotal=true\` gives \`totalCount\` on page one. | Records are large: choose \`fields=\`. The last page has no \`nextPageToken\`.                                                                                                                                                                                                                                                                                     |
| **Zotero**: the user's library. Web: \`https://api.zotero.org\` ([basics](https://www.zotero.org/support/dev/web_api/v3/basics)). Local: \`http://localhost:23119/api/\`                                                                                                             | Web: \`Zotero-API-Key\` header, made by the user at zotero.org/settings/keys; send \`Zotero-API-Version: 3\`. Local: none.                                                  | Web: obey \`Backoff\` (seconds) on any answer and \`Retry-After\` on 429; ≤ 4 requests at once. Local: no limit.                                                                         | \`limit\` ≤ 100 (default 25), \`start\`; \`Total-Results\` and \`Link: rel="next"\`.                                                                                      | Paths use the numeric user id from the keys page, not the username. The local API is read-only and needs the Zotero app running; local writes need a key granted in the app.                                                                                                                                                                                   |
| **Moodle**: course sites. \`https://<site>/webservice/rest/server.php\` ([web services](https://moodledev.io/docs/apis/subsystems/external))                                                                                                                                       | A web-service token (\`wstoken=\`), when the site allows it: the user may find it under Preferences → Security keys. Never get it with the password (\`/login/token.php\`). | Set by each site; go gently (≥ 0.5 s apart).                                                                                                                                         | Per function; most return everything at once.                                                                                                                     | \`moodlewsrestformat=json\`, or it answers XML. Errors usually arrive as HTTP 200 with \`exception\`, \`errorcode\` and \`message\` (not re-read): check the body. File URLs (\`/webservice/pluginfile.php/…\`) carry the token: never print or return them, fetch inside the tool. If the site turned web services off, use a website sign-in (\`auth-and-sessions.md\`). |

## When a service is not here

Find its API page and its terms first. Look for: the limit and what it is counted by, whether
a key helps, how to identify yourself, the largest page and how to get the next one, the error
format, and whether there is a bulk download for big jobs. Write what you found in the
connector's README with the date.
`,
      "references/sources.md": `# Sources

This skill is written in our own words. Its methods draw on these public works, read in
November 2026. No text was copied.

- Anthropic, \`mcp-builder\` skill (Apache-2.0), github.com/anthropics/skills: phases from plan to
  evaluation, tool naming, pagination fields, annotations, evaluation questions.
- Anthropic, "Writing effective tools for agents", anthropic.com/engineering: few
  workflow-shaped tools, short results with names, actionable errors, improving tools from
  evaluations.
- Model Context Protocol specification 2025-11-25 and 2026-07-28, modelcontextprotocol.io:
  lifecycle, \`server/discover\`, tools, stdio transport, authorization, elicitation rules.
- MCP Bundle manifest (\`.mcpb\`), github.com/modelcontextprotocol/mcpb: \`user_config\`,
  sensitive fields, \`\${user_config.…}\` and \`\${__dirname}\`.
- kalil0321/reverse-api-engineer (MIT): describe the data wanted, check real data rather than a
  200, hand captchas and 2FA to the user, no hard-coded credentials.
- Elenics/har-api-trace (MIT): start capture before sign-in, repeat the action with different
  inputs, replay reading requests only, remove headers one at a time, known hard cases, diff
  endpoint lists when a site changes.
- syall/api-reverse-engineering-toolkit (MIT): look for OpenAPI and GraphQL first, search
  script bundles, mark endpoints confirmed or unverified, never write a field you haven't seen.
- unbrowse-ai/unbrowse (MIT client): drop noise, compare two captures, trace each token to its
  source, success means a verified result, one new sign-in on 401.
- alufers/mitmproxy2swagger (MIT) and jonluca/har-to-openapi (MIT): path templates from
  captures; captures leak secrets.
- Integuru-AI/Integuru (AGPL-3.0, idea only): trace a request's dynamic values back to the
  requests that produce them until only the sign-in cookies remain.
- ChromeDevTools/chrome-devtools-mcp (Apache-2.0): reading request details in the user's own
  signed-in browser.
- Playwright authentication docs and Checkly's TOTP guide: saved browser state holds secrets;
  on expiry, sign in again with stored credentials, then ask the person.
- Service pages for the limits in \`science-apis.md\`: OpenAlex, NCBI, arXiv, Crossref, Semantic
  Scholar, ClinicalTrials.gov, Zotero, Moodle; and the open-source servers
  cyanheads/pubmed-mcp-server and cyanheads/clinicaltrialsgov-mcp-server (Apache-2.0),
  54yyyu/zotero-mcp and Faixiang/Moodle-MCP (MIT) for field experience.
`,
      "references/study-a-website.md": `# Study a website that has no documented API

Read this before building a connector for a site whose data the user sees in the browser
but no public API offers. The goal is the smallest set of the site's own requests that
returns the data the user wants, understood well enough to make it reliable, without changing
anything on the site.

## Rules for the whole study

- Only the user's own account, for their own use. Read the site's terms of use; if they forbid
  automated access, tell the user and stop.
- Read, don't change. Open pages, list and replay reading requests only. Before anything that
  could change data (submit, post, enroll, delete, mark read, pay), ask the user.
- Never get past a captcha, a 2FA prompt or a "verify you are human" page yourself. Hand it to
  the user: \`scient_account_sign_in\` waits while they do it.
- Go slowly: a pause between replays (half a second or more), no loops over many pages while
  studying.
- Keep secrets out of everything you write. \`preview_network\` hides cookies, tokens and
  \`Authorization\` values; don't copy any value you do see into notes, code, tests or chat
  summaries. Never save request captures or HAR files in the project or the connector.

## The tools

| Tool                               | Use it to                                                                                                                                                                                                   |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| \`preview_open\`, \`preview_navigate\` | Open the site in Scient's browser. \`preview_open\` signs in by itself with a saved sign-in; read its \`accountsNote\`.                                                                                         |
| \`scient_account_sign_in\`           | Sign in on your tab with the user's saved account, including authenticator codes. Returns \`needs-user\` when the person must act.                                                                            |
| \`scient_account_find_profile\`      | Find a browser profile already signed in to the site.                                                                                                                                                       |
| \`preview_snapshot\`, \`preview_act\`  | Read the page and click, type or choose, like the user would.                                                                                                                                               |
| \`preview_network\`                  | List the tab's recent requests (method, URL, status, type, time); with a request id, see its headers, request body and response body. Secrets are masked. Large bodies go to a file whose path is returned. |
| \`preview_evaluate\`                 | Run a small script in the page: read in-page config, list script URLs, or \`fetch()\` a reading request with the page's own cookies.                                                                          |
| \`scient_account_browser_session\`   | Export the site's cookies to private files for curl, for reading requests only.                                                                                                                             |

## The method

### 1. Say what data you need

Write the goal as data, not clicks: "my assignments due in the next 14 days: course, title,
due time with time zone, submitted or not". This tells you when you are done.

### 2. Look for a front door first

A documented way in is more stable than anything you find in the page. Check, in order:

- The site's or vendor's API docs and developer pages (search "<site or product> API"). Many
  campus systems are known products with APIs: Moodle web services, Canvas REST, Blackboard
  REST, Alma, Primo, DSpace, Pure, Figshare, Dataverse.
- A vendor MCP server or an existing connector (Extensions → Discover).
- Machine-readable descriptions on the site: \`/openapi.json\`, \`/swagger.json\`,
  \`/v3/api-docs\`, \`/.well-known/openapi.yaml\`, \`/api/docs\`.
- GraphQL: a \`/graphql\` endpoint that answers an introspection query (a reading POST).
- Feeds and exports: iCal calendar links (deadlines often have one), RSS, CSV or BibTeX
  exports, OAI-PMH for repositories.
- \`robots.txt\` and the sitemap, for the site's layout and what it asks of automated visitors.

If one of these gives the data, use it and skip the rest.

### 3. Watch the sign-in once

Open the sign-in page with nothing signed in, then sign in (\`scient_account_sign_in\`) and list
the requests. Note which responses set cookies, where the browser lands, and whether a token
goes into page storage. Then note what a signed-out visitor gets from a data URL: a redirect,
a 401, a login form, or a JSON error. That is the shape your connector must recognise as
"session ended".

### 4. Do the task by hand, twice

With the user's goal in mind, do it in the browser with \`preview_act\`: open the course,
filter the dates, page to the next set. Then do it again with different inputs (another
course, other dates). After each run, list the requests with \`preview_network\`.

Skip the noise: analytics and tracking, ads, fonts, images, style sheets, heartbeats and
polling, error reporting.

### 5. Find the request that carries the data

Open the likely requests by id and read their response bodies. The data is usually JSON from an
\`/api/\`, \`/ajax/\` or \`service.php\` URL, sometimes an HTML fragment, sometimes JSON embedded in
the page (\`__NEXT_DATA__\`, \`application/ld+json\`, a \`window.__STATE__\` object).

Compare the two runs: what changed in the URL, query or body are the inputs; what stayed the
same are constants or session values.

### 6. Trace every value back to where it came from

For each value in that request that isn't an input (an id, a CSRF token, a \`sesskey\`, a
signature, a version hash), find what produced it: an earlier response body, the page HTML,
in-page config (read it with \`preview_evaluate\`, e.g. \`window.M?.cfg?.sesskey\` on Moodle), or a
cookie. Repeat for those requests until only the cookies are left. Write the chain down:

\`\`\`
GET /my/                      → sesskey (in page config)
POST /lib/ajax/service.php?sesskey=…&info=core_calendar_get_action_events_by_timesort
     body: [{"methodname":"core_calendar_get_action_events_by_timesort","args":{…}}]
                              → events
\`\`\`

A value you can't trace may live in local storage, IndexedDB or a service worker, or be
computed by the page's script. Look before guessing.

### 7. Replay reading requests

- GET only, unless the request clearly only reads: a GraphQL \`query\` (not a \`mutation\`), a
  search POST, a Moodle \`get_…\` function. Ask the user when unsure.
- Fastest first test: \`preview_evaluate\` with \`fetch(url, {credentials: "include"})\` in the
  page, which uses the page's own cookies and origin.
- Then outside the browser, the way the connector will run: through \`scient_connector_check\`
  once the sign-in is linked (\`auth-and-sessions.md\`, "While building"), or with curl and the
  files from \`scient_account_browser_session\`.

### 8. Strip it down

Remove headers one at a time (\`Referer\`, \`Origin\`, \`X-Requested-With\`, custom \`X-…\`, \`Accept\`)
and replay. Mark each one required (the answer breaks), affects (the answer changes) or not
needed. Keep the required ones and an honest \`User-Agent\`. Don't try to imitate a browser's
fingerprint.

### 9. Check against what the page shows

The data must match the page: the same number of rows, and spot-check three items, including a
date (time zones), a name with non-English letters, and an empty case (a course with nothing
due must come back as empty, not as an error). Read field types from real answers (ids are
often strings). Don't write a field into the connector that you haven't seen in a real answer.

### 10. Write down the map

In the connector's \`README.md\`, under "How it talks to <site>": each request it uses, its
inputs, where each token comes from, what "signed out" looks like, the date you looked, and
which requests you saw work (confirmed) or only read about in the page's code (unverified).
No values. This makes the next fix fast (\`fixing.md\`).

## Hard cases

| You see                                            | Do                                                                                                                                                                                                                                                    |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A signature header or timestamp computed by script | List the page's scripts (\`preview_evaluate\`: \`[...document.scripts].map(s => s.src)\`), fetch the bundle, search it for the header name, and re-create it only if it is a plain hash of the request. If it hides a secret key, stop and tell the user. |
| GraphQL                                            | One URL for everything: tell requests apart by \`operationName\`. Persisted queries send a hash instead of the query; the hash changes when the site updates, so record it and expect fixes.                                                            |
| WebSockets or server-sent events                   | \`preview_network\` doesn't show their messages. Look for a plain request that gives the same data (often there is one for the first load).                                                                                                             |
| Binary bodies (protobuf, gRPC-web)                 | Look for a JSON variant or another page. Don't build on bytes you can't read.                                                                                                                                                                         |
| Infinite scroll                                    | Find the request that loads the next part and its cursor or offset; that becomes the tool's paging.                                                                                                                                                   |
| Only HTML, no data requests                        | Parse the HTML narrowly: stable ids, \`data-\` attributes, table headers. Check it on two pages. Prefer an export or feed if the site has one.                                                                                                          |
| A bot check, a block page, or many 429s            | Stop. Don't work around it. Tell the user; the site doesn't want automated access this way.                                                                                                                                                           |
| A sign-in that only the person can pass every time | Tell the user the connector will often need them to sign in; ask if that is still useful.                                                                                                                                                             |

## Done when

- [ ] Each of the user's tasks maps to one or a few traced, confirmed reading requests.
- [ ] You know what "signed out" looks like for each.
- [ ] Inputs, constants and session values are told apart; every token's origin is known.
- [ ] Results were checked against the page.
- [ ] The map is in the README, with no secrets.
`,
      "references/testing.md": `# Testing a connector

Read this before calling a connector done. "It started" and "it answered 200" are not
"it works". It works when an agent, given only its tools, gets the user's real answers from it.

## 1. It starts and lists its tools

\`scient_connector_check {folder}\` with no calls. It must:

- start without keys or a sign-in, and list every tool (\`missing\` names what setup still
  needs);
- list the same tools as \`manifest.json\`, with clear descriptions and strict schemas;
- leave nothing alarming in the log (stderr). Warnings at start are worth reading.

If it fails, the error and log say why; \`fixing.md\` lists the usual causes.

## 2. Real sample calls

Run calls through \`scient_connector_check {folder, connector?, calls}\`. Give \`connector\` once
the connector is saved and set up, so the check uses the user's keys and sign-in.

For each tool, cover:

- **A typical call** from the user's own tasks, with real inputs ("papers on CRISPR base
  editing since 2020", "my deadlines in the next 14 days").
- **The second page**, when it pages: \`next_page\` or \`next_cursor\` from the first call works
  and gives different items.
- **An empty answer**: an input with no results comes back as an empty list, not an error.
- **A wrong input**: a bad id or an out-of-range value gives a clear tool error that says what
  to do.
- **The largest realistic answer**: still short enough (a few thousand words at most).

Keep test calls few and read-only. Never call a tool that changes data unless the user asked
for it, on data they chose.

## 3. The data is right

Look at the results, not just the status:

- Compare with the source: the same items the website shows, or a second source (the DOI page,
  the course page). Spot-check three items field by field.
- Counts add up (\`total\`, page sizes).
- Dates and times are right, with the time zone. Names with accents or non-Latin letters come
  through.
- Nothing is silently dropped: optional fields missing on some items don't break others.
- No secrets in any result or log line (keys, cookies, tokens, file URLs with tokens).

## 4. Sign-ins

For a connector with a website sign-in:

- Without a sign-in, a tool call returns the "no sign-in yet" message, not a crash.
- With the linked sign-in, real calls return the user's data.
- The signed-out shape is recognised: run the tool's request logic against what the site sends
  a signed-out visitor (from your study), and check that it produces the
  \`SCIENT_SIGN_IN_EXPIRED\` error. Check also that a "no access to this" answer does not.

## 5. A short evaluation

Write three to five questions a researcher would really ask, that:

- need only reading;
- need two or more calls (search, then read; list, then filter);
- have one answer that won't change (a 2019 paper's first author and their institution, not
  "the most cited paper this year").

Solve each one yourself first with the tools, and note the answer. Then, when you can, have a
fresh agent (a subagent with only the connector's tools and the question) try them. Where it
fails or wastes calls, improve the descriptions, the defaults or the results, not the question.
Keep the questions in the connector's \`README.md\` for the next fix.

## What to tell the user

- What the connector does and its tools, in a line each.
- What you tested: the calls, and one real result in short.
- What you did not test: tools that change data, other computers (say which systems you ran it
  on), anything that needs the person (a captcha).
- What setup is still needed, if any, and how to take it back: Remove on the page of a new
  connector (Remove can be undone), **Undo last change** after a fix.
`,
      "references/tool-design.md": `# Tool design

Read this when you plan a connector's tools or change them. Agents choose tools by name and
description, call them with what the schema allows, and read every word they return. Good
tools make that easy and cheap.

## Start from the tasks

- Write down the user's two to five real tasks first ("what's due this week in all my
  courses", "find papers citing this one since 2020"). Each tool should finish a task or a
  clear step of one.
- Fewer, fuller tools beat one tool per endpoint. If agents would always call A then B, make
  one tool that does both. Example for a course site: not \`list_courses\`, \`get_course\`,
  \`list_assignments\`, \`get_assignment\`, but \`upcoming_deadlines {days}\`,
  \`course_materials {course}\`, \`read_file {file}\`.
- Don't make two tools that do nearly the same thing; the agent will pick wrong.
- Reading tools first. Add a tool that changes data only when the user asked for it.

## Names

- \`verb_noun\` in lowercase with underscores: \`search_works\`, \`get_work\`,
  \`upcoming_deadlines\`. Up to 64 characters, letters, digits and \`_\` only (the protocol allows
  \`-\` and \`.\` too, but some clients don't).
- Agents see each tool under the connector's name, so the service name need not be in the
  tool name.
- Keep names stable once saved. Skills and habits come to depend on them.

## Descriptions

- One to three sentences, written for a new colleague: what it does, what it returns, when to
  use it instead of its sibling, and any limit ("max 50 per page", "dates in the site's time
  zone, UTC").
- Each parameter gets a description with an example value. Name parameters so they can't be
  misread: \`course_id\`, not \`course\`; \`from_year\`, not \`from\`.
- Say in the description when a tool changes data: "Submits the assignment on Moodle. This
  changes the user's data: confirm with the user first."
- The server's \`instructions\` (in \`serve(...)\`) can hold one or two sentences on how the tools
  fit together.

## Inputs

- Strict schemas: \`type: "object"\`, \`required\`, \`additionalProperties: false\`, \`enum\` for
  fixed choices, \`minimum\`/\`maximum\`, \`minLength\`/\`maxLength\`, \`default\`. \`mcp.mjs\` checks
  these and tells the agent exactly what was wrong, so it can fix the call.
- Accept the forms people have: a DOI or a doi.org link, a course name or its id. Normalize
  inside the tool.
- One meaning per parameter. No free-form "options" objects.

## Results

- Short and readable. Return the fields that answer the task, with names, not bare ids, but
  keep the id the next tool needs (\`id: "W2741809807"\` next to the title).
- Ask the API for less where it can (\`select=\`, \`fields=\`), drop empty fields, cut long text
  (abstracts, pages) with a note saying it was cut.
- Dates as ISO 8601 (\`2026-11-10\` or \`2026-11-10T14:00:00+02:00\`); say the time zone.
- When agents need both a quick view and full detail, add \`detail: "short" | "full"\` with
  \`short\` as the default rather than two tools.
- Return plain objects from handlers. \`mcp.mjs\` sends them as JSON text, and also as
  \`structuredContent\` when the tool declares an \`outputSchema\`. The result must match the
  schema: leave a field out rather than send \`null\` unless the schema allows \`null\`.
- Size: aim for under ~5,000 words per result. \`mcp.mjs\` cuts text over 60,000 characters and
  says so, but that is a safety net, not a design.

## Paging

- Take \`limit\` (a small default such as 10 or 25, a firm maximum such as 50 or 100) and \`page\`
  or \`cursor\`.
- Return \`total\` when the API knows it, \`has_more\`, and \`next_page\` or \`next_cursor\`. Pass the
  API's own cursor back unchanged.
- Never fetch every page in one call unless the total is small and bounded. Say how to narrow
  the search when there are too many results.

## Errors

- Tool errors (\`throw new ToolError("…")\`, sent with \`isError: true\`) are for anything the agent
  can act on: bad input, nothing found, rate limited, key rejected, session ended. Each message
  says what happened and what to do next:
  - "No work found for 10.1234/xyz. Check the DOI, or find it with search_works."
  - "OpenAlex is limiting requests; wait 30 s and try again with fewer calls."
  - "The key was refused (401). Call scient_connector_setup with replaceKeys."
- No stack traces, no raw HTML pages, no secrets. Use \`safeUrl()\` from \`http.mjs\` for URLs in
  messages, and \`snippet()\` for a short piece of a body.
- An ended website session is special: its error starts with \`SCIENT_SIGN_IN_EXPIRED\`
  (\`auth-and-sessions.md\`). Use it only for a real end of session.
- Protocol errors (unknown tool or method) are handled by \`mcp.mjs\`.

## Annotations

Hints for the host and the agent, not protection. Set them honestly on every tool:

| Annotation        | Set to \`true\` when                                               |
| ----------------- | ---------------------------------------------------------------- |
| \`readOnlyHint\`    | It only reads.                                                   |
| \`destructiveHint\` | It can delete or overwrite (only meaningful when not read-only). |
| \`idempotentHint\`  | Calling it twice with the same input has no extra effect.        |
| \`openWorldHint\`   | It talks to an outside service (almost every connector).         |

Also give each tool a \`title\` people can read ("Search scholarly works").

## Tools that change data

- Separate tools with plain names (\`submit_assignment\`, \`add_to_collection\`), never a \`mode\`
  switch on a reading tool.
- For risky changes (submit, delete, send, pay), make the default a preview: \`confirm: false\`
  returns what would happen; \`confirm: true\` does it. The agent shows the user the preview.
- Never retry a write automatically (\`http.mjs\` retries only GET and HEAD). After a timeout,
  check whether it happened before trying again.

## State between calls

Avoid it. If a task needs a handle (an upload id, a search session), return it explicitly and
say when it expires; when it has, the error says so and how to start again.

## Before saving

- [ ] Each tool maps to a real task; no near-duplicates.
- [ ] Names, titles, descriptions and parameter descriptions are plain and exact.
- [ ] Schemas are strict; defaults are sensible; limits are stated.
- [ ] Results are short, named, paged, and match their \`outputSchema\`.
- [ ] Errors say what to do next and hold no secrets.
- [ ] Annotations are honest; writes are separate and say so.
- [ ] \`manifest.json\` lists the same tools as \`server.mjs\`.
`,
      "templates/README.md": `# {{DISPLAY_NAME}}

A connector for Scient: a small program that gives agents tools for one service. As it
comes, it is a working example that searches OpenAlex, a free index of scholarly works. Change
it into the connector you need.

It needs nothing installed. Scient runs it on its own copy of Node, on macOS, Windows and
Linux. It also runs on Node 20 or newer, and in Claude Desktop when exported as \`.mcpb\`.

## Files

| File            | What it is                                                                              |
| --------------- | --------------------------------------------------------------------------------------- |
| \`manifest.json\` | Name, how to start it, settings and keys it asks for, its tools. MCP Bundle format.     |
| \`server.mjs\`    | The tools. This is the file you change.                                                 |
| \`mcp.mjs\`       | The MCP side: messages over stdin and stdout, input checks, errors. Usually left as is. |
| \`http.mjs\`      | Polite web requests: pacing, timeouts, retries, hidden keys in messages.                |
| \`session.mjs\`   | The user's sign-in to a website, from Scient's Accounts. Delete it if unused.           |

## Placeholders

\`scient_connector_copy\` fills these in \`manifest.json\` and this README:

| Placeholder        | Filled with                                                                                                       |
| ------------------ | ----------------------------------------------------------------------------------------------------------------- |
| \`{{NAME}}\`         | The program name: lowercase letters, digits and dashes, e.g. \`moodle-huji\`. Agents see its tools under this name. |
| \`{{DISPLAY_NAME}}\` | The name people see, e.g. "HUJI Moodle".                                                                          |

## Make it yours (for the agent)

1. In \`server.mjs\`, replace \`search_works\` and \`get_work\` with tools shaped like the user's
   tasks. Keep each tool's \`inputSchema\` strict and its result short.
2. In \`manifest.json\`, set \`description\`, the \`tools\` list (names and one-line descriptions,
   the same as in \`server.mjs\`), and \`user_config\` for the settings and keys it needs.
   Change \`version\` when you change behaviour.
3. Check it with \`scient_connector_check\` and real sample calls, then save it with
   \`scient_connector_save\`. The \`connector-authoring\` skill has the details.

### A key

In \`manifest.json\`, declare it and hand it to the program through the environment:

\`\`\`json
"user_config": {
  "api_key": { "type": "string", "title": "Example API key", "description": "Where to get it.", "sensitive": true, "required": true }
},
"server": { "mcp_config": { "command": "node", "args": ["\${__dirname}/server.mjs"], "env": { "EXAMPLE_API_KEY": "\${user_config.api_key}" } } }
\`\`\`

In \`server.mjs\`, read \`process.env.EXAMPLE_API_KEY\`. When it is empty, start anyway and have
the tools that need it \`throw needsSetup("The Example API key")\`. Never put a key in a file,
in \`args\`, or in a message.

### A website the user signs in to

Add the site to \`manifest.json\`:

\`\`\`json
"_meta": { "com.scientfactory.scient": { "signIn": { "site": "https://moodle.example.edu" } } }
\`\`\`

Then use the session in \`server.mjs\`:

\`\`\`js
import { createSession } from "./session.mjs";

const session = createSession({ http });
// In a tool handler:
const events = await session.json("/lib/ajax/service.php?…", {}, { signal });
\`\`\`

\`session.fetch\` and \`session.json\` send the user's cookies, follow redirects, and throw the
\`SCIENT_SIGN_IN_EXPIRED\` error when the site sends them to its sign-in page. Scient then signs in
again and retries. The program never sees the password.

### Libraries

Zero dependencies is best: Scient cannot count on npm being on the user's computer. When a
library is truly needed and npm is there, install it inside this folder (\`npm install\` here,
with a \`package.json\` that has \`"type": "module"\`), so \`node_modules\` travels with the
connector. The official MCP SDK (\`@modelcontextprotocol/sdk\`) may replace \`mcp.mjs\` then.

## Run it by hand

\`node server.mjs\` waits for MCP messages on stdin and logs to stderr. Scient's check
(\`scient_connector_check\`) is the real test.
`,
      "templates/http.mjs": `// Polite HTTP for connectors, with no dependencies (Node 20+ fetch).
//
// - One request at a time per host, with a gap between requests (set it below the service's limit).
// - A timeout on every request, and the agent's cancel passed through.
// - GET and HEAD are retried on 429, 502, 503, 504 and network errors, honouring Retry-After,
//   within an overall deadline. Other methods are never retried: they may change data.
// - URLs in messages and logs have secret-looking query values hidden.

import { ToolError } from "./mcp.mjs";

const RETRY_STATUSES = new Set([429, 502, 503, 504]);
const SAFE_METHODS = new Set(["GET", "HEAD"]);
const SECRET_PARAM =
  /^(api[_-]?key|key|token|access[_-]?token|wstoken|auth|sig|signature|session|sid|password|secret)$/i;

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });

/** The URL with secret-looking query values replaced, for messages and logs. */
export function safeUrl(url) {
  try {
    const parsed = new URL(url);
    for (const name of [...parsed.searchParams.keys()]) {
      if (SECRET_PARAM.test(name)) parsed.searchParams.set(name, "hidden");
    }
    parsed.username = "";
    parsed.password = "";
    return parsed.toString();
  } catch {
    return "(a URL)";
  }
}

/** Seconds or an HTTP date, as milliseconds from now; undefined when absent or unreadable. */
function retryAfterMs(response) {
  const value = response.headers.get("retry-after");
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

const anySignal = (signals) => {
  const present = signals.filter(Boolean);
  if (present.length <= 1) return present[0];
  if (typeof AbortSignal.any === "function") return AbortSignal.any(present);
  const controller = new AbortController();
  for (const signal of present) {
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
  }
  return controller.signal;
};

/**
 * Makes a polite fetch.
 *
 * @param {object} [options]
 * @param {string} [options.userAgent] Say honestly who is calling, e.g. "openalex-connector/0.1".
 * @param {number} [options.minGapMs] Gap between requests to one host. 200 ms = at most 5 per second.
 * @param {number} [options.timeoutMs] Per attempt.
 * @param {number} [options.maxRetries] For GET and HEAD.
 * @param {number} [options.deadlineMs] Overall, retries and waits included.
 * @param {Record<string, number>} [options.hostGapMs] Per-host gaps, e.g. {"export.arxiv.org": 3000}.
 */
export function createHttp({
  userAgent,
  minGapMs = 200,
  timeoutMs = 30_000,
  maxRetries = 2,
  deadlineMs = 90_000,
  hostGapMs = {},
} = {}) {
  const queues = new Map(); // host -> promise of the last request's turn
  const nextAt = new Map(); // host -> earliest time for the next request

  /** Waits for this host's turn, so requests to one host go one at a time and spaced. */
  async function turn(host, signal) {
    const previous = queues.get(host) ?? Promise.resolve();
    let release;
    const mine = new Promise((resolve) => (release = resolve));
    queues.set(
      host,
      previous.then(() => mine),
    );
    await previous;
    const wait = (nextAt.get(host) ?? 0) - Date.now();
    try {
      if (wait > 0) await sleep(wait, signal);
    } catch (error) {
      release();
      throw error;
    }
    return () => {
      nextAt.set(host, Date.now() + (hostGapMs[host] ?? minGapMs));
      release();
    };
  }

  /**
   * Like fetch, with pacing, a timeout and retries. \`signal\` is the agent's cancel (from the tool
   * handler's context). Network failures become a ToolError the agent can read.
   */
  return async function politeFetch(url, init = {}, { signal } = {}) {
    const method = (init.method ?? "GET").toUpperCase();
    const host = new URL(url).host;
    const headers = new Headers(init.headers);
    if (userAgent && !headers.has("user-agent")) headers.set("user-agent", userAgent);
    const started = Date.now();
    for (let attempt = 0; ; attempt++) {
      const done = await turn(host, signal);
      let response;
      try {
        response = await fetch(url, {
          ...init,
          method,
          headers,
          signal: anySignal([signal, AbortSignal.timeout(timeoutMs)]),
        });
      } catch (error) {
        done();
        if (signal?.aborted) throw error;
        const timedOut = error?.name === "TimeoutError";
        const retry = SAFE_METHODS.has(method) && attempt < maxRetries;
        if (retry && Date.now() - started < deadlineMs) {
          await sleep(1000 * 2 ** attempt, signal);
          continue;
        }
        const why = timedOut
          ? \`no answer within \${Math.round(timeoutMs / 1000)} s\`
          : (error?.cause?.code ?? error?.message ?? "network error");
        throw new ToolError(
          \`Could not reach \${host} (\${why}) for \${safeUrl(url)}. Try again later.\`,
        );
      }
      done();
      if (!RETRY_STATUSES.has(response.status) || !SAFE_METHODS.has(method)) return response;
      const wait = retryAfterMs(response) ?? 1000 * 2 ** attempt + Math.random() * 250;
      if (attempt >= maxRetries || Date.now() - started + wait > deadlineMs) return response;
      await response.body?.cancel().catch(() => {});
      await sleep(wait, signal);
    }
  };
}

/**
 * Reads a JSON response, turning HTTP errors into a ToolError with a short, useful message.
 * \`what\` names the thing for the message, e.g. "OpenAlex".
 */
export async function readJson(response, what) {
  const type = response.headers.get("content-type") ?? "";
  const body = await response.text();
  if (!response.ok) {
    const wait = retryAfterMs(response);
    const hint =
      response.status === 429
        ? \`\${what} is limiting requests\${wait ? \`; wait \${Math.ceil(wait / 1000)} s\` : ""} and try again with fewer calls.\`
        : response.status === 401 || response.status === 403
          ? \`\${what} refused the request (\${response.status}). The key may be wrong or missing: call scient_connector_setup with replaceKeys.\`
          : response.status === 404
            ? \`\${what} has nothing at that address (404). Check the id.\`
            : \`\${what} answered \${response.status}.\`;
    throw new ToolError(\`\${hint} \${snippet(body)}\`.trim());
  }
  if (!/json/i.test(type) && !/^\\s*[[{]/.test(body)) {
    throw new ToolError(\`\${what} sent \${type || "something"} instead of JSON: \${snippet(body)}\`);
  }
  try {
    return JSON.parse(body);
  } catch {
    throw new ToolError(\`\${what} sent JSON that could not be read: \${snippet(body)}\`);
  }
}

/** The start of a body, on one line, for error messages. */
export const snippet = (text, max = 300) => {
  const line = String(text ?? "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\\s+/g, " ")
    .trim();
  return line.length > max ? \`\${line.slice(0, max)}…\` : line;
};
`,
      "templates/manifest.json": `{
  "manifest_version": "0.3",
  "name": "{{NAME}}",
  "display_name": "{{DISPLAY_NAME}}",
  "version": "0.1.0",
  "description": "Search scholarly works in OpenAlex and read their details. Replace with what this connector does.",
  "author": {
    "name": "Made with Scient"
  },
  "server": {
    "type": "node",
    "entry_point": "server.mjs",
    "mcp_config": {
      "command": "node",
      "args": ["\${__dirname}/server.mjs"],
      "env": {
        "OPENALEX_API_KEY": "\${user_config.api_key}"
      }
    }
  },
  "user_config": {
    "api_key": {
      "type": "string",
      "title": "OpenAlex API key",
      "description": "Optional. A free key from openalex.org/settings/api raises the daily limit.",
      "sensitive": true,
      "required": false
    }
  },
  "tools": [
    {
      "name": "search_works",
      "description": "Search scholarly works by words, years and open access."
    },
    {
      "name": "get_work",
      "description": "Read one work by OpenAlex id or DOI, with its abstract."
    }
  ],
  "compatibility": {
    "platforms": ["darwin", "win32", "linux"],
    "runtimes": {
      "node": ">=20.0.0"
    }
  },
  "_meta": {
    "com.scientfactory.scient": {}
  }
}
`,
      "templates/mcp.mjs": `// A small MCP server over stdio, with no dependencies. Runs on Node 20+ and on Scient's own
// Electron binary in Node mode, on macOS, Windows and Linux.
//
// It speaks both protocol eras:
// - Legacy (2025-11-25 and earlier): \`initialize\`, then requests. Versions are negotiated.
// - Current (2026-07-28): no handshake; \`server/discover\`, and every request names its version
//   in \`params._meta["io.modelcontextprotocol/protocolVersion"]\`.
//
// You normally don't edit this file. Define tools in server.mjs and call \`serve(...)\`.

import * as readline from "node:readline";

/** Tool errors whose text starts with this make Scient sign the user in again and retry once. */
export const SIGN_IN_EXPIRED = "SCIENT_SIGN_IN_EXPIRED";

const MODERN_VERSIONS = ["2026-07-28"];
const LEGACY_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const VERSION_META = "io.modelcontextprotocol/protocolVersion";
const SERVER_INFO_META = "io.modelcontextprotocol/serverInfo";
/** Agents see at most ~25k tokens of a tool result; keep well under it. */
const MAX_TEXT = 60_000;

/**
 * An error the agent should read: a plain sentence saying what went wrong and what to do next.
 * It becomes a tool result with \`isError: true\`, so the agent can correct itself.
 */
export class ToolError extends Error {
  constructor(message) {
    super(message);
    this.name = "ToolError";
  }
}

/** A tool error saying a setting or key is missing, pointing the agent at Scient's setup. */
export const needsSetup = (what) =>
  new ToolError(
    \`\${what} is not set up yet. Call scient_connector_setup for this connector; \` +
      "Scient asks the user in a private card. Never ask for keys in chat.",
  );

/** Logs go to stderr. Never write to stdout: it carries the protocol. */
export const log = (...parts) => {
  process.stderr.write(\`\${parts.map((p) => (typeof p === "string" ? p : inspect(p))).join(" ")}\\n\`);
};
const inspect = (value) => {
  if (value instanceof Error) return value.stack ?? value.message;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

// A stray console.log would corrupt the protocol stream; send it to stderr instead.
console.log = console.info = console.debug = (...parts) => log(...parts);

/** Cuts long text with a note that tells the agent how to get less. */
export const clip = (text, max = MAX_TEXT) =>
  text.length <= max
    ? text
    : \`\${text.slice(0, max)}\\n\\n[Cut at \${max} of \${text.length} characters. Ask for fewer results, a smaller page, or fewer fields.]\`;

// ---------------------------------------------------------------------------------------------
// Input checking: a small part of JSON Schema, enough for tool arguments. Messages name the field
// and say what is allowed, so the agent can fix its call.

const typeOf = (value) => (value === null ? "null" : Array.isArray(value) ? "array" : typeof value);

const matchesType = (value, type) => {
  if (type === undefined) return true;
  if (Array.isArray(type)) return type.some((t) => matchesType(value, t));
  if (type === "integer") return Number.isInteger(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  return typeOf(value) === type;
};

function checkValue(value, schema, path, problems) {
  if (!schema || typeof schema !== "object") return value;
  if (!matchesType(value, schema.type)) {
    problems.push(\`\${path} must be \${[].concat(schema.type).join(" or ")}, not \${typeOf(value)}\`);
    return value;
  }
  if (schema.enum && !schema.enum.includes(value)) {
    problems.push(\`\${path} must be one of \${schema.enum.map((v) => JSON.stringify(v)).join(", ")}\`);
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum)
      problems.push(\`\${path} must be at least \${schema.minimum}\`);
    if (schema.maximum !== undefined && value > schema.maximum)
      problems.push(\`\${path} must be at most \${schema.maximum}\`);
  }
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength)
      problems.push(\`\${path} must have at least \${schema.minLength} characters\`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength)
      problems.push(\`\${path} must have at most \${schema.maxLength} characters\`);
    if (schema.pattern !== undefined && !new RegExp(schema.pattern, "u").test(value))
      problems.push(\`\${path} does not look right (expected pattern \${schema.pattern})\`);
  }
  if (Array.isArray(value)) {
    if (schema.maxItems !== undefined && value.length > schema.maxItems)
      problems.push(\`\${path} may have at most \${schema.maxItems} items\`);
    if (schema.minItems !== undefined && value.length < schema.minItems)
      problems.push(\`\${path} needs at least \${schema.minItems} items\`);
    return value.map((item, i) => checkValue(item, schema.items, \`\${path}[\${i}]\`, problems));
  }
  if (typeOf(value) === "object" && schema.properties) {
    return checkObject(value, schema, path, problems);
  }
  return value;
}

function checkObject(value, schema, path, problems) {
  const out = { ...value };
  const properties = schema.properties ?? {};
  if (schema.additionalProperties === false) {
    for (const key of Object.keys(out)) {
      if (!(key in properties)) {
        const allowed = Object.keys(properties);
        problems.push(
          \`\${path === "" ? "" : \`\${path}.\`}\${key} is not an argument here\` +
            (allowed.length ? \` (allowed: \${allowed.join(", ")})\` : " (this tool takes none)"),
        );
      }
    }
  }
  for (const [key, child] of Object.entries(properties)) {
    const childPath = path === "" ? key : \`\${path}.\${key}\`;
    if (out[key] === undefined || out[key] === null) {
      if (child.default !== undefined) out[key] = structuredClone(child.default);
      else delete out[key];
      continue;
    }
    out[key] = checkValue(out[key], child, childPath, problems);
  }
  for (const key of schema.required ?? []) {
    if (out[key] === undefined) problems.push(\`\${path === "" ? "" : \`\${path}.\`}\${key} is required\`);
  }
  return out;
}

/** Checks arguments against a tool's inputSchema, fills defaults, and returns them. */
export function checkArguments(args, schema) {
  if (args !== undefined && args !== null && typeOf(args) !== "object") {
    throw new ToolError(\`Invalid arguments: they must be an object, not \${typeOf(args)}.\`);
  }
  const problems = [];
  const value = checkObject(args ?? {}, schema ?? { type: "object" }, "", problems);
  if (problems.length > 0) {
    throw new ToolError(\`Invalid arguments: \${problems.join("; ")}.\`);
  }
  return value;
}

// ---------------------------------------------------------------------------------------------
// Results

/** Turns what a handler returned into a CallToolResult. */
function toResult(tool, value) {
  if (typeof value === "string") return { content: [{ type: "text", text: clip(value) }] };
  if (value && Array.isArray(value.content)) return value; // Already a CallToolResult.
  // A plain object: JSON text for every client, plus structuredContent when declared.
  const text = clip(JSON.stringify(value ?? null));
  return tool.outputSchema && typeOf(value) === "object"
    ? { content: [{ type: "text", text }], structuredContent: value }
    : { content: [{ type: "text", text }] };
}

const errorResult = (message) => ({
  content: [{ type: "text", text: clip(message) }],
  isError: true,
});

// ---------------------------------------------------------------------------------------------
// The server

/** A JSON-RPC protocol error (unknown method or tool), as opposed to a tool error. */
class ProtocolError extends Error {
  constructor(code, message, data) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

/**
 * Starts the server on stdin/stdout.
 *
 * @param {object} options
 * @param {string} options.name Program name, e.g. "openalex".
 * @param {string} options.version
 * @param {string} [options.title] Name shown to people.
 * @param {string} [options.instructions] One or two sentences for the agent on using the tools.
 * @param {Array<{name: string, title?: string, description: string, inputSchema?: object,
 *   outputSchema?: object, annotations?: object,
 *   handler: (args: object, context: {signal: AbortSignal}) => unknown}>} options.tools
 */
export function serve({ name, version, title, instructions, tools }) {
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const listed = tools.map(({ handler: _handler, ...tool }) => ({
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    ...tool,
  }));
  const serverInfo = { name, version, ...(title ? { title } : {}) };
  const inFlight = new Map(); // request id -> AbortController
  let open = true;

  const send = (message) => {
    if (open && message !== undefined) process.stdout.write(\`\${JSON.stringify(message)}\\n\`);
  };
  const failure = (id, code, message, data) => ({
    jsonrpc: "2.0",
    id,
    error: { code, message, ...(data === undefined ? {} : { data }) },
  });

  async function callTool(params, signal) {
    const tool = byName.get(params?.name);
    if (!tool) throw new ProtocolError(-32602, \`Unknown tool: \${params?.name}\`);
    let args;
    try {
      args = checkArguments(params.arguments, tool.inputSchema);
    } catch (error) {
      return errorResult(error.message);
    }
    try {
      return toResult(tool, await tool.handler(args, { signal }));
    } catch (error) {
      if (signal.aborted) return errorResult("The call was cancelled.");
      if (error instanceof ToolError) return errorResult(error.message);
      log(\`\${tool.name} failed:\`, error);
      return errorResult(
        \`\${tool.name} failed unexpectedly: \${error?.message ?? String(error)}. \` +
          "The connector's log has details.",
      );
    }
  }

  async function handle(method, params, modern, signal) {
    switch (method) {
      case "initialize": {
        // Legacy handshake: answer with the client's version when we know it, else our latest.
        const asked = params?.protocolVersion;
        return {
          protocolVersion: LEGACY_VERSIONS.includes(asked) ? asked : LEGACY_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo,
          ...(instructions ? { instructions } : {}),
        };
      }
      case "server/discover":
        return {
          supportedVersions: MODERN_VERSIONS,
          capabilities: { tools: { listChanged: false } },
          ...(instructions ? { instructions } : {}),
          ttlMs: 300_000,
          cacheScope: "public",
        };
      case "ping":
        return {};
      case "tools/list":
        return modern ? { tools: listed, ttlMs: 300_000, cacheScope: "public" } : { tools: listed };
      case "tools/call":
        return callTool(params, signal);
      default:
        throw new ProtocolError(-32601, \`Method not found: \${method}\`);
    }
  }

  /** Answers one request; resolves to the response, or undefined when nothing is sent. */
  async function onRequest({ id, method, params }) {
    const asked = params?._meta?.[VERSION_META];
    const modern = asked !== undefined || method === "server/discover";
    if (asked !== undefined && !MODERN_VERSIONS.includes(asked)) {
      return failure(id, -32022, "Unsupported protocol version", {
        supported: MODERN_VERSIONS,
        requested: asked,
      });
    }
    const controller = new AbortController();
    inFlight.set(id, controller);
    try {
      const result = await handle(method, params, modern, controller.signal);
      if (controller.signal.aborted) return undefined; // Cancelled: send nothing for it.
      return {
        jsonrpc: "2.0",
        id,
        result: modern
          ? { resultType: "complete", ...result, _meta: { [SERVER_INFO_META]: serverInfo } }
          : result,
      };
    } catch (error) {
      if (controller.signal.aborted) return undefined;
      if (error instanceof ProtocolError) return failure(id, error.code, error.message, error.data);
      log(\`\${method} failed:\`, error);
      return failure(id, -32603, "Internal error");
    } finally {
      inFlight.delete(id);
    }
  }

  /** Resolves to the response for one message, or undefined for notifications and responses. */
  async function onMessage(message) {
    if (message === null || typeof message !== "object" || Array.isArray(message)) {
      return failure(null, -32600, "Invalid request");
    }
    if (typeof message.method !== "string") return undefined; // A response; we send no requests.
    if (message.id === undefined || message.id === null) {
      // A notification. Only cancellation matters to a tools-only server.
      if (message.method === "notifications/cancelled") {
        inFlight.get(message.params?.requestId)?.abort();
      }
      return undefined;
    }
    return onRequest(message);
  }

  const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  lines.on("line", (line) => {
    if (line.trim() === "") return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return send(failure(null, -32700, "Parse error"));
    }
    if (!Array.isArray(message)) return void onMessage(message).then(send);
    // A JSON-RPC batch (2025-03-26 clients may send one): one array of answers back.
    if (message.length === 0) return send(failure(null, -32600, "Invalid request"));
    void Promise.all(message.map(onMessage)).then((answers) => {
      const sent = answers.filter((answer) => answer !== undefined);
      if (sent.length > 0) send(sent);
    });
  });
  // The client closes stdin to stop us: finish quietly.
  lines.on("close", () => {
    open = false;
    for (const controller of inFlight.values()) controller.abort();
    process.exit(0);
  });
  process.stdout.on("error", () => process.exit(0)); // The client went away.
  process.on("unhandledRejection", (error) => log("Unhandled rejection:", error));
  process.on("uncaughtException", (error) => log("Uncaught exception:", error));
  log(\`\${name} \${version} ready (\${tools.length} tools).\`);
}
`,
      "templates/server.mjs": `// Example connector: search OpenAlex (a free index of scholarly works) and read one work.
// Replace these tools with the ones your connector needs; keep the shape:
// - a few tools shaped like the user's tasks, with plain descriptions and strict inputs;
// - short results with names, not raw API dumps; paging the agent can follow;
// - errors that say what to do next; keys only from the environment; logs to stderr only.

import * as fs from "node:fs";

import { createHttp, readJson } from "./http.mjs";
import { serve, ToolError } from "./mcp.mjs";

const manifest = JSON.parse(fs.readFileSync(new URL("./manifest.json", import.meta.url), "utf8"));
const API = "https://api.openalex.org";
const API_KEY = process.env.OPENALEX_API_KEY?.trim() ?? ""; // Optional: a free key raises the budget.

// OpenAlex allows 10 requests a second without a key; stay well under it.
const http = createHttp({
  userAgent: \`\${manifest.name}/\${manifest.version} (Scient connector)\`,
  minGapMs: 150,
});

async function openalex(path, params, signal) {
  const url = new URL(path, API);
  for (const [name, value] of Object.entries(params ?? {})) {
    if (value !== undefined && value !== "") url.searchParams.set(name, String(value));
  }
  // The key goes in a header, not the URL, so it never shows up in logs or error messages.
  const headers = API_KEY ? { authorization: \`Bearer \${API_KEY}\` } : {};
  return readJson(await http(url.toString(), { headers }, { signal }), "OpenAlex");
}

const shortId = (id) => String(id ?? "").replace("https://openalex.org/", "");
const shortDoi = (doi) => (doi ? String(doi).replace(/^https?:\\/\\/doi\\.org\\//i, "") : undefined);

/** Drops undefined fields, so results stay short. */
const compact = (object) =>
  Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined));

const authorLine = (authorships = [], max = 3) => {
  const names = authorships.map((a) => a.author?.display_name).filter(Boolean);
  return names.length > max ? \`\${names.slice(0, max).join(", ")} et al.\` : names.join(", ");
};

/** OpenAlex stores abstracts as {word: [positions]}; put the words back in order. */
const abstractText = (index) => {
  if (!index) return undefined;
  const words = [];
  for (const [word, positions] of Object.entries(index)) {
    for (const position of positions) words[position] = word;
  }
  return words.filter(Boolean).join(" ");
};

const SORTS = {
  relevance: undefined, // OpenAlex sorts by relevance when there is a search.
  most_cited: "cited_by_count:desc",
  newest: "publication_date:desc",
};

const searchWorks = {
  name: "search_works",
  title: "Search scholarly works",
  description:
    "Search OpenAlex for papers, books and datasets by words in the title, abstract or full " +
    "text. Returns short records (title, authors, year, venue, DOI, citations, free full-text " +
    "link). Use get_work for the abstract and all authors. Results come in pages: pass " +
    "next_page back as page for more.",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        minLength: 1,
        maxLength: 500,
        description: 'Words to search for, e.g. "CRISPR base editing".',
      },
      from_year: { type: "integer", minimum: 1000, maximum: 3000, description: "Earliest year." },
      to_year: { type: "integer", minimum: 1000, maximum: 3000, description: "Latest year." },
      open_access_only: {
        type: "boolean",
        default: false,
        description: "Only works with a free full text.",
      },
      sort: { type: "string", enum: Object.keys(SORTS), default: "relevance" },
      limit: { type: "integer", minimum: 1, maximum: 50, default: 10, description: "Per page." },
      page: { type: "integer", minimum: 1, default: 1 },
    },
    required: ["query"],
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    properties: {
      total: { type: "integer", description: "Matching works in OpenAlex." },
      page: { type: "integer" },
      has_more: { type: "boolean" },
      next_page: { type: "integer" },
      results: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            title: { type: "string" },
            authors: { type: "string" },
            year: { type: "integer" },
            venue: { type: "string" },
            doi: { type: "string" },
            cited_by: { type: "integer" },
            free_full_text: { type: "string" },
          },
          required: ["id"],
        },
      },
    },
    required: ["total", "page", "has_more", "results"],
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  async handler({ query, from_year, to_year, open_access_only, sort, limit, page }, { signal }) {
    if (from_year && to_year && from_year > to_year) {
      throw new ToolError("from_year is after to_year. Swap them or drop one.");
    }
    if (page * limit > 10_000) {
      throw new ToolError(
        "OpenAlex pages through the first 10,000 results only. Narrow the search (years, " +
          "open_access_only, more specific words) instead of paging further.",
      );
    }
    const filters = [
      from_year && \`from_publication_date:\${from_year}-01-01\`,
      to_year && \`to_publication_date:\${to_year}-12-31\`,
      open_access_only && "is_oa:true",
    ].filter(Boolean);
    const data = await openalex(
      "/works",
      {
        search: query,
        filter: filters.join(","),
        sort: SORTS[sort],
        per_page: limit,
        page,
        select:
          "id,doi,display_name,publication_year,authorships,primary_location,cited_by_count,open_access",
      },
      signal,
    );
    const total = data.meta?.count ?? 0;
    const hasMore = page * limit < Math.min(total, 10_000);
    return compact({
      total,
      page,
      has_more: hasMore,
      next_page: hasMore ? page + 1 : undefined,
      results: (data.results ?? []).map((work) =>
        compact({
          id: shortId(work.id),
          title: work.display_name ?? undefined,
          authors: authorLine(work.authorships) || undefined,
          year: work.publication_year ?? undefined,
          venue: work.primary_location?.source?.display_name ?? undefined,
          doi: shortDoi(work.doi),
          cited_by: work.cited_by_count ?? undefined,
          free_full_text: work.open_access?.oa_url ?? undefined,
        }),
      ),
    });
  },
};

/** Accepts an OpenAlex id (W123…), an openalex.org URL, a DOI or a doi.org URL. */
function workPath(id) {
  const value = id.trim();
  const openalex = /^(?:https?:\\/\\/openalex\\.org\\/)?(W\\d+)$/i.exec(value);
  if (openalex) return \`/works/\${openalex[1].toUpperCase()}\`;
  const doi = /^(?:https?:\\/\\/(?:dx\\.)?doi\\.org\\/|doi:)?(10\\.\\d{4,9}\\/\\S+)$/i.exec(value);
  if (doi) return \`/works/doi:\${doi[1].replace(/[?#%]/g, encodeURIComponent)}\`;
  throw new ToolError(
    \`"\${value}" is not an OpenAlex id or a DOI. Use an id like W2741809807 or a DOI like \` +
      "10.1038/nature12373 (search_works finds both).",
  );
}

const getWork = {
  name: "get_work",
  title: "Read one work",
  description:
    "Get one work from OpenAlex by OpenAlex id (W…) or DOI: title, all authors with their " +
    "institutions, year, venue, abstract, topic, citation counts and free full-text link.",
  inputSchema: {
    type: "object",
    properties: {
      id: {
        type: "string",
        minLength: 2,
        maxLength: 300,
        description: "An OpenAlex id like W2741809807, or a DOI like 10.1038/nature12373.",
      },
    },
    required: ["id"],
    additionalProperties: false,
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  async handler({ id }, { signal }) {
    let work;
    try {
      work = await openalex(
        workPath(id),
        {
          select:
            "id,doi,display_name,publication_year,publication_date,type,authorships," +
            "primary_location,primary_topic,abstract_inverted_index,cited_by_count," +
            "referenced_works_count,open_access",
        },
        signal,
      );
    } catch (error) {
      if (error instanceof ToolError && /\\(404\\)/.test(error.message)) {
        throw new ToolError(
          \`OpenAlex has no work "\${id}". Check it, or find it with search_works.\`,
        );
      }
      throw error;
    }
    const authors = (work.authorships ?? []).map((a) =>
      compact({
        name: a.author?.display_name ?? undefined,
        institutions:
          (a.institutions ?? [])
            .map((i) => i.display_name)
            .filter(Boolean)
            .join("; ") || undefined,
      }),
    );
    const abstract = abstractText(work.abstract_inverted_index);
    return compact({
      id: shortId(work.id),
      title: work.display_name ?? undefined,
      type: work.type ?? undefined,
      year: work.publication_year ?? undefined,
      date: work.publication_date ?? undefined,
      venue: work.primary_location?.source?.display_name ?? undefined,
      doi: shortDoi(work.doi),
      authors: authors.slice(0, 25),
      more_authors: authors.length > 25 ? authors.length - 25 : undefined,
      topic: work.primary_topic?.display_name ?? undefined,
      abstract:
        abstract && abstract.length > 4000
          ? \`\${abstract.slice(0, 4000)}… [abstract cut]\`
          : abstract,
      cited_by: work.cited_by_count ?? undefined,
      references: work.referenced_works_count ?? undefined,
      free_full_text: work.open_access?.oa_url ?? undefined,
      landing_page: work.primary_location?.landing_page_url ?? undefined,
    });
  },
};

serve({
  name: manifest.name,
  version: manifest.version,
  title: manifest.display_name,
  instructions:
    "Search with search_works, then read a work with get_work. Results are short on purpose; " +
    "ask for more pages only when the user needs them.",
  tools: [searchWorks, getWork],
});
`,
      "templates/session.mjs": `// The user's sign-in to a website, as Scient hands it to a connector. No dependencies.
//
// When the manifest has \`_meta["com.scientfactory.scient"].signIn = {site}\` and the user linked a
// sign-in in Accounts, Scient starts the program with:
//   SCIENT_SIGN_IN_SITE         the site's origin, e.g. https://moodle.example.edu
//   SCIENT_SIGN_IN_COOKIES      path to a JSON file: [{name, value, domain, path, expires, secure,
//                               httpOnly, sameSite}]
//   SCIENT_SIGN_IN_COOKIES_TXT  the same cookies in Netscape format (for curl or Python)
//   SCIENT_SIGN_IN_USER_AGENT   the user agent of the browser the cookies came from; sent with them
// The program never gets the password: Scient signs in, not the connector.
//
// When the session has ended, throw \`signInExpired(...)\` (session.fetch does it for you). The tool
// error then starts with SCIENT_SIGN_IN_EXPIRED; Scient signs the user in again, rewrites the
// cookie files, restarts this program and retries the call once.

import * as fs from "node:fs";

import { SIGN_IN_EXPIRED, ToolError } from "./mcp.mjs";
import { snippet } from "./http.mjs";

/** Paths that usually mean "you are being sent to sign in". Add the site's own when it differs. */
const LOGIN_PATH =
  /\\/(log-?in|log-?on|sign-?in|auth(enticate)?|sso|saml2?|cas\\/login|idp|oauth2?\\/authorize|adfs\\/ls|shibboleth(\\.sso)?|wayf)(\\/|\\.|\\?|$)/i;
const LOGIN_HOST = /(^|\\.)(login\\.microsoftonline\\.com|accounts\\.google\\.com|login\\.live\\.com)$/i;
const PASSWORD_FIELD = /<input[^>]+type\\s*=\\s*["']?password/i;

/** A tool error that tells Scient the sign-in has ended. */
export const signInExpired = (site, why) =>
  new ToolError(\`\${SIGN_IN_EXPIRED}: the sign-in to \${site} has ended (\${why}).\`);

/** A tool error for a connector that was never given a sign-in. */
const notSignedIn = () =>
  new ToolError(
    "This connector has no sign-in yet. Call scient_connector_setup for it; the user links " +
      "their account in Accounts. Never ask for the password in chat.",
  );

// ---------------------------------------------------------------------------------------------
// Cookie files

/** Reads Netscape cookies.txt lines into the JSON shape. \`#HttpOnly_\` marks httpOnly cookies. */
export function parseNetscapeCookies(text) {
  const cookies = [];
  for (const raw of text.split(/\\r?\\n/)) {
    let line = raw;
    let httpOnly = false;
    if (line.startsWith("#HttpOnly_")) {
      httpOnly = true;
      line = line.slice("#HttpOnly_".length);
    } else if (line.startsWith("#") || line.trim() === "") continue;
    const parts = line.split("\\t");
    if (parts.length < 7) continue;
    const [domain, includeSubdomains, path, secure, expires, name, ...value] = parts;
    cookies.push({
      name,
      value: value.join("\\t"),
      domain: includeSubdomains === "TRUE" && !domain.startsWith(".") ? \`.\${domain}\` : domain,
      // Without the include-subdomains flag the cookie belongs to that exact host.
      hostOnly: includeSubdomains !== "TRUE",
      path: path || "/",
      expires: Number(expires) || -1,
      secure: secure === "TRUE",
      httpOnly,
    });
  }
  return cookies;
}

/** Loads the cookie file Scient wrote; re-reads it when Scient rewrites it. */
function cookieSource(env) {
  const jsonPath = env.SCIENT_SIGN_IN_COOKIES;
  const txtPath = env.SCIENT_SIGN_IN_COOKIES_TXT;
  const path = jsonPath || txtPath;
  let stamp = "";
  let cached = [];
  return () => {
    if (!path) return undefined;
    let stat;
    try {
      stat = fs.statSync(path);
    } catch {
      return [];
    }
    // Scient rewrites the file (often by renaming a new one in): any of these changes.
    const now = \`\${stat.ino}:\${stat.mtimeMs}:\${stat.ctimeMs}:\${stat.size}\`;
    if (now !== stamp) {
      const text = fs.readFileSync(path, "utf8");
      cached = path === jsonPath ? JSON.parse(text) : parseNetscapeCookies(text);
      if (!Array.isArray(cached)) cached = [];
      stamp = now;
    }
    return cached;
  };
}

// ---------------------------------------------------------------------------------------------
// Cookie matching (RFC 6265, simplified: enough for one site's own cookies)

/** A host-only cookie goes to its exact host; a domain cookie to that domain and its subdomains. */
const domainMatches = (host, cookie) => {
  const domain = String(cookie.domain ?? "")
    .replace(/^\\./, "")
    .toLowerCase();
  if (domain === "") return false;
  return cookie.hostOnly === true
    ? host === domain
    : host === domain || host.endsWith(\`.\${domain}\`);
};

/** RFC 6265 5.1.4: a cookie set without Path belongs to the response's directory. */
const defaultPath = (url) => {
  const path = url.pathname;
  if (!path.startsWith("/") || path.lastIndexOf("/") === 0) return "/";
  return path.slice(0, path.lastIndexOf("/"));
};

const pathMatches = (path, cookiePath = "/") =>
  path === cookiePath ||
  (path.startsWith(cookiePath) && (cookiePath.endsWith("/") || path[cookiePath.length] === "/"));

const isLocal = (host) => host === "localhost" || host === "127.0.0.1" || host === "[::1]";

const alive = (cookie, now) =>
  cookie.expires === undefined || cookie.expires <= 0 || cookie.expires * 1000 > now;

/** Parses one Set-Cookie header into the JSON cookie shape. */
function parseSetCookie(header, url) {
  const [pair, ...attributes] = header.split(";");
  const eq = pair.indexOf("=");
  if (eq <= 0) return undefined;
  const cookie = {
    name: pair.slice(0, eq).trim(),
    value: pair.slice(eq + 1).trim(),
    domain: url.hostname,
    hostOnly: true,
    path: defaultPath(url),
    expires: -1,
    secure: false,
    httpOnly: false,
  };
  for (const attribute of attributes) {
    const [rawKey, ...rest] = attribute.split("=");
    const key = rawKey.trim().toLowerCase();
    const value = rest.join("=").trim();
    if (key === "domain" && value) {
      cookie.domain = \`.\${value.replace(/^\\./, "")}\`;
      cookie.hostOnly = false;
    } else if (key === "path" && value.startsWith("/")) cookie.path = value;
    else if (key === "max-age") cookie.expires = Date.now() / 1000 + Number(value);
    else if (key === "expires" && cookie.expires === -1) {
      const date = Date.parse(value);
      if (!Number.isNaN(date)) cookie.expires = date / 1000;
    } else if (key === "secure") cookie.secure = true;
    else if (key === "httponly") cookie.httpOnly = true;
    else if (key === "samesite") cookie.sameSite = value;
  }
  if (cookie.expires === 0) cookie.expires = 1; // Max-Age=0 deletes it.
  return cookie;
}

// ---------------------------------------------------------------------------------------------
// The session

/**
 * The user's session on the site Scient signed in to.
 *
 * @param {object} options
 * @param {(url: string, init?: RequestInit, context?: {signal?: AbortSignal}) => Promise<Response>} options.http
 *   A fetch, normally from createHttp() in http.mjs.
 * @param {RegExp} [options.loginPath] The site's sign-in page path, when the default misses it.
 * @param {boolean} [options.forbiddenMeansExpired] Treat every 403 as an ended session. Off by
 *   default: a 403 usually means "no access to this", and only counts when the page is a login form.
 * @param {(response: Response, body: string) => boolean} [options.isSignedOut] A site-specific
 *   check, e.g. a JSON body like {"errorcode":"invalidsesskey"}.
 * @param {NodeJS.ProcessEnv} [options.env]
 */
export function createSession({
  http,
  loginPath = LOGIN_PATH,
  forbiddenMeansExpired = false,
  isSignedOut,
  env = process.env,
}) {
  const site = env.SCIENT_SIGN_IN_SITE ? new URL(env.SCIENT_SIGN_IN_SITE).origin : undefined;
  const fileCookies = cookieSource(env);
  // Cookies the site set since the file was read (sessions that refresh on each request).
  let fileSnapshot;
  let jar = [];

  const cookies = () => {
    const fromFile = fileCookies();
    if (fromFile !== fileSnapshot) {
      fileSnapshot = fromFile;
      jar = (fromFile ?? []).map((cookie) => ({ ...cookie }));
    }
    return jar;
  };

  const cookieHeader = (url) => {
    const now = Date.now();
    const host = url.hostname.toLowerCase();
    return cookies()
      .filter(
        (c) =>
          domainMatches(host, c) &&
          pathMatches(url.pathname, c.path) &&
          (!c.secure || url.protocol === "https:" || isLocal(host)) &&
          alive(c, now),
      )
      .sort((a, b) => (b.path ?? "/").length - (a.path ?? "/").length)
      .map((c) => \`\${c.name}=\${c.value}\`)
      .join("; ");
  };

  const remember = (response, url) => {
    const headers =
      typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : [];
    for (const header of headers) {
      const cookie = parseSetCookie(header, url);
      if (!cookie) continue;
      jar = jar.filter(
        (c) => !(c.name === cookie.name && c.path === cookie.path && sameDomain(c, cookie)),
      );
      if (alive(cookie, Date.now())) jar.push(cookie);
    }
  };
  const sameDomain = (a, b) =>
    String(a.domain).replace(/^\\./, "") === String(b.domain).replace(/^\\./, "");

  const looksLikeLogin = (url) => LOGIN_HOST.test(url.hostname) || loginPath.test(url.pathname);

  /**
   * Fetches a page or API on the site with the user's cookies, following redirects itself so it
   * can see a bounce to the sign-in page. Relative paths are read against the site. Throws
   * signInExpired() when the session has ended. Cookies are only sent to the hosts they belong to.
   */
  async function sessionFetch(pathOrUrl, init = {}, context = {}) {
    if (!site) throw notSignedIn();
    if (cookies() === undefined) throw notSignedIn();
    let url = new URL(pathOrUrl, site);
    let method = (init.method ?? "GET").toUpperCase();
    let body = init.body;
    // Carried from hop to hop; credentials never follow a redirect to another origin.
    const headers = new Headers(init.headers);
    for (let hop = 0; hop < 10; hop++) {
      headers.delete("cookie");
      const cookie = cookieHeader(url);
      if (cookie) headers.set("cookie", cookie);
      // Some sites end a session that arrives from another browser than the one that made it.
      if (env.SCIENT_SIGN_IN_USER_AGENT && !headers.has("user-agent"))
        headers.set("user-agent", env.SCIENT_SIGN_IN_USER_AGENT);
      const response = await http(
        url.toString(),
        { ...init, method, body, headers, redirect: "manual" },
        context,
      );
      remember(response, url);
      const location = response.headers.get("location");
      if (response.status >= 300 && response.status < 400 && location) {
        const next = new URL(location, url);
        await response.body?.cancel().catch(() => {});
        if (looksLikeLogin(next)) {
          throw signInExpired(site, \`sent to the sign-in page \${next.origin}\${next.pathname}\`);
        }
        const toGet =
          response.status === 303 ||
          ((response.status === 301 || response.status === 302) && method === "POST");
        if (toGet) {
          method = "GET";
          body = undefined;
          headers.delete("content-type");
          headers.delete("content-length");
        }
        if (next.origin !== url.origin) {
          headers.delete("authorization");
          headers.delete("proxy-authorization");
        }
        url = next;
        continue;
      }
      if (response.status === 401 || response.status === 419 || response.status === 440) {
        await response.body?.cancel().catch(() => {});
        throw signInExpired(site, \`the site answered \${response.status}\`);
      }
      return checked(response);
    }
    throw new ToolError(\`\${site} redirected too many times. The site may have changed.\`);
  }

  /** Looks at the body for a sign-in form; returns a Response whose body can still be read. */
  async function checked(response) {
    const type = response.headers.get("content-type") ?? "";
    const textual = type === "" || /html|json|text|xml/i.test(type);
    if (!textual) return response;
    const text = await response.text();
    const loginForm = /html/i.test(type) && PASSWORD_FIELD.test(text);
    if (
      (loginForm && (response.ok || response.status === 403)) ||
      (response.status === 403 && forbiddenMeansExpired) ||
      isSignedOut?.(response, text)
    ) {
      throw signInExpired(
        site,
        loginForm ? "the site showed its sign-in form" : \`the site answered \${response.status}\`,
      );
    }
    const noBody = [204, 205, 304].includes(response.status);
    return new Response(noBody ? null : text, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }

  /** GETs JSON from the site (or sends \`init\`), with sign-in and error checks. */
  async function json(pathOrUrl, init = {}, context = {}) {
    const response = await sessionFetch(
      pathOrUrl,
      { ...init, headers: { accept: "application/json", ...init.headers } },
      context,
    );
    const text = await response.text();
    if (!response.ok) {
      throw new ToolError(
        response.status === 403
          ? \`\${site} says the account has no access to this (403). \${snippet(text)}\`
          : \`\${site} answered \${response.status}: \${snippet(text)}\`,
      );
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new ToolError(\`\${site} sent something other than JSON: \${snippet(text)}\`);
    }
  }

  return {
    /** The site's origin, or undefined when Scient gave no sign-in. */
    site,
    /** True when Scient gave this program a sign-in (it may still have ended). */
    get linked() {
      return site !== undefined && cookies() !== undefined;
    },
    fetch: sessionFetch,
    json,
    /** The Cookie header for a URL, for libraries that need it. Never log or return it. */
    cookieHeader: (url) => cookieHeader(new URL(url, site)),
  };
}
`,
    }),
  }),
]);
