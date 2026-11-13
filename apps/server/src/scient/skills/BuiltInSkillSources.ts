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

const references = `---
name: references
description: Use for any request about the references, citations, sources or bibliography of a paper, thesis, grant, review or report, for the whole document or a selected passage, or about the project Library's records. Covers checking or verifying references, fixing citations and bibliography entries, finding sources for claims, methods, instruments, software, data or guidelines, finding better or newer references, and judging whether cited work supports the text. Not for writing a literature review from scratch.
---

# References

The goal is a draft in which every citation points to a real work, described correctly, that still stands and supports the sentence citing it, and in which everything that needs support has it. The researcher owns the scholarship: find the problems, show the evidence, fix what is clearly wrong when asked, and leave real choices to them.

Finish the whole check in this turn, without stopping for progress updates. If something cannot be finished, say exactly what is left. This skill grants no tools or authority.

## Tools

- \`scient_references_check\` checks records. Give it the project path of a \`.md\`, \`.tex\` or \`.bib\` file, or no path for the Library. It reads the bibliography files a document names and the Library sources its citation keys name, resolves every DOI, PMID, arXiv ID and ISBN against its registry, and reports identifiers that do not resolve or name a different work, retractions and corrections, preprints with a published version, details that differ from the record, missing fields, and cited/listed mismatches. Its \`ledger\` lists every reference; \`complete: false\` means some were not checked, and its \`notes\` say why.
- \`scient_references_resolve\` applies a finding's \`fix\` exactly as the check returned it, writing the registry's value to the \`.bib\` entry or Library source, and ignores or restores findings. A stale fix means the file changed: check again.
- The Library comes before any search: \`scient_sources_list\` and \`scient_sources_get\` for records; \`scient_sources_search\`, \`scient_sources_read_text\` and \`scient_sources_quote_check\` for the full text of Library PDFs; \`scient_sources_add\` to add a work by identifier, which checks it against its registry, only when the user asked to add; \`scient_sources_bibliography\` to write \`references.bib\` and \`references.json\` from the Library.
- \`scient_paper_get\` saves a paper's PDF to the project (free copy first, then the user's library access) so you can read it. It also writes a queue file there, so it changes the project: never call it for a check-only request.
- Connected literature tools (PubMed, Semantic Scholar, OpenAlex and others) and web search find candidates. PubMed and Europe PMC suit biomedicine; arXiv, OpenReview, ACL Anthology, PMLR and proceedings sites suit computer science, where many conference papers have no DOI; zbMATH suits mathematics, where many references are books. Web search finds editions of guidelines, manuals and software best.

Work inside the project; do not search the rest of the computer, and do not scan or edit \`.scient\` files directly.

## What to check

- **Records.** Run \`scient_references_check\` first and read all of it before editing. Treat its ledger as your list: every reference must end up in your report. A difference is a lead, not a verdict: abbreviations, online and print years, and indexing gaps all cause them. A reference without a DOI, PMID, arXiv ID or ISBN was not checked against a registry; find its record yourself. If a result looks wrong, say so and check by hand.
- **Support.** For every citation, does the work support the sentence as written? Typical failures: narrower than claimed (association as cause, mice as humans, healthy volunteers as patients, a lab feasibility study as home efficacy), the opposite or a null result, the wrong paper, a review cited for a primary finding, a different number. Grade it supports, partly supports (say which part), does not support, contradicts, or not assessed.
- **Not only findings.** Methods, instruments, statistical procedures, software, datasets, guidelines, criteria and figures about the world each need the source a reader would check: the original or standard reference for what was used.
- **Versions and currency.** Guidelines, reporting standards, scoring manuals, criteria and software have versions, and figures about the world go out of date. For each, search for a later edition or estimate, even when the text names its version, and record what you found; report a newer one as a decision, and never replace a figure with an older one.
- **Evidence against.** When a sentence states a general or strong effect, look at later work before judging it supported: replications and meta-analyses since the cited year, and papers citing the source. Report important contrary evidence.
- **Gaps and better references.** Sentences, including paragraph openers, that state a finding, number or trend, or use a named method, instrument or tool, without a citation; and better choices: primary over review, published over preprint, newer where the field has moved. For each gap, give at least one checked candidate, or say what you searched.

Read the abstract for every judgement and the full text where the claim is specific or the abstract leaves it open.

## Rules

- **Never cite from memory.** Every reference you add or suggest, in the draft or in the report, was found in a scholarly record in this task, has a DOI or another stable identifier, and you read enough of it to judge support. Copy its details, including every author, from the registry record (the check's \`registry\`, or the Library source \`scient_sources_add\` created), never from memory. For works without an identifier (manuals, books, reports), confirm the edition from the publisher or mark the details unconfirmed.
- **State only what you observed**, and where: "the DOI does not resolve", not a guess about whose it is; "none found in PubMed and Crossref", not "none exists". Say for each judgement whether it rests on full text, abstract or metadata; full text means you opened the paper's text in this task. Write every page as "PDF page 7", the page a viewer shows for the file, never as "page 7" or "p. 7": the printed page can differ. If you know only the printed page, write "printed page 7". Confidence in words with a reason, never a percentage.
- **Not found is not fabricated.** Books, manuals, reports, theses and proceedings are often missing from indexes; search title, authors and venue before calling a reference likely fabricated.
- **No suitable source is a valid answer.** Propose narrowing the claim rather than attaching a weak citation.

## Changing the draft

If the user asked only to check, do not modify the draft, its bibliography or the Library, and do not call \`scient_paper_get\`: it saves files into the project. Read what the Library already holds (\`scient_sources_read_text\`, \`scient_sources_quote_check\`), and report a paper it does not hold as not read, saying what reading it would need. If they asked to fix:

- Apply: the check's fixes through \`scient_references_resolve\`; other details from the record; missing bibliography entries built from the record, identifying a cited-but-missing key from its sentence, key and year; a citation for something the text names (a method, instrument, software, dataset, guideline, or the authors it names); the paper a true claim actually comes from when it is attributed to the wrong one, including the primary study when a cited review reports it (find it rather than delete the claim); overclaims narrowed to what the cited source shows, in the author's words as far as possible. Narrowing a sentence to its own source is a fix, not a change to the argument. When the source supports a claim that later work disputes, attribute it in the text ("X et al. reported …") and propose the contrary evidence. Change an identifier only to one you confirmed resolves to the work. If an entry's identifier belongs to a different paper and the cited work cannot be found, never rewrite the entry to match that other paper: treat the source as nonexistent.
- Never leave a claim resting on a retracted, nonexistent or contradicting source as it is: narrow it to what the source shows or remove it, and list it as a decision. Do not rescue it by swapping in a newly found study.
- Propose, do not apply: newly found studies as evidence for a claim, contrary evidence, new sentences, version changes, published versions of cited preprints, and choices between alternatives. Do not add or delete parts of the author's argument; the author must stand behind every sentence in their paper.
- Never downgrade a stated venue, year or edition because the records lack it; mark it unconfirmed. Leave uncited bibliography entries in place and list them. Never shorten author lists, and keep verification notes in the report, not in bibliography fields.

Afterwards reread the changed passages, run \`scient_references_check\` again and, for LaTeX, build the document if you can; at least make sure new text escapes \`_\`, \`&\` and \`%\`.

## Report

When you changed files, save a Markdown report next to the manuscript (for example \`main.references-check.md\`) and reply with a short summary linking to it. For a check-only request, give the report in your reply and offer to save it. Put the most serious issues first, each with location, problem, evidence (short quote with its location, every page written as "PDF page N" or "printed page N", and what you read), fix applied or proposed, and confidence; then decisions for the user; then one line for every reference that was fine. Say plainly whether the check is complete. Before replying, confirm the report exists and every change you describe is in the files. Link the report and changed files by project path.
`;

const systematicReview = `---
name: systematic-review
description: Use for systematic, scoping or rapid reviews in Scient, including planning the review question and eligibility criteria, running and logging database searches, removing duplicates, title and abstract or full-text screening, and reporting a PRISMA flow. Not for an ordinary literature summary or for checking a manuscript's references.
---

# Systematic Review

The goal is a review another researcher could repeat: every search logged exactly, every record accounted for, every decision recorded with who made it and why, and a PRISMA 2020 flow that matches the decisions. The researcher owns the review question, the criteria and the final calls. You do the work they ask for, carefully and in the open.

Change the review only when the user asks for that work. This skill grants no tools or authority.

## Tools

- \`scient_sources_systematic_reviews\` lists reviews, or reads one: its searches, exclusion reasons, PRISMA counts with a Mermaid PRISMA diagram (\`prismaMermaid\`), possible duplicate pairs, and the next records awaiting a decision with their abstracts.
- \`scient_sources_systematic_review_update\` makes every change: \`create-review\`, \`update-review\` (title, question, exclusion reasons), \`log-search\`, \`add-sources\`, \`mark-duplicate\`, \`mark-distinct\`, \`screen\`, \`clear-decision\`, \`delete-review\`.
- Records are Library sources. Bring them in with \`scient_sources_add\` (identifiers from a connector result or a list), a file import, or Zotero; group a search's records with \`scient_sources_organize\` (a collection per search) or \`scient_sources_bulk_update\`. Read full text with \`scient_paper_get\`, \`scient_sources_read_text\` and \`scient_sources_search\`.

Never scan or edit \`.scient\` files directly.

## Plan

Agree the question and the eligibility criteria with the user before screening (population, intervention or exposure, comparator, outcomes, study designs, dates, languages). Put the question in the review and set \`exclusionReasons\` from the criteria, so every exclusion names one of them.

## Search

Use the databases the user names. For each search, log the database, the exact search string as run, the date, and the number of results the database reported (\`resultCount\`), then the records you brought into the Library (\`sourceIds\` or a \`collectionId\`). If you could not bring in every result, say how many are missing and why; the flow counts them as removed for other reasons. Records found another way (reference lists, experts, websites) go in with \`add-sources\`.

## Remove duplicates

A record whose DOI or PMID is already in the Library is taken for that record unless what it brings disagrees (another title, another known type, another identifier), and the flow counts it as a duplicate. One that disagrees is kept as its own record, and the Library lists the pair with the reason (\`scient_sources_list\` with duplicates); settle it like the pairs below. A record shown from the review's snapshot with \`libraryMatch\` disagrees with a Library copy: link it (\`scient_sources_organize\` \`link-pin\`) only when the user confirms it is that work, or record \`keep-pin-separate\`. Then work through \`possibleDuplicates\`: mark a duplicate only when both records are the same work, keeping the more complete or published version; use \`mark-distinct\` for different works that share a title.

## Screen

- Title and abstract: judge each record against the criteria using only its title and abstract. Include when it may meet them; use maybe when you cannot tell, for example without an abstract; exclude only when it clearly fails one, with that criterion as the reason. Never infer an abstract you were not given.
- Full text: only records included at title and abstract. Get and read the full text; exclude with the criterion it fails. When a report cannot be obtained, use \`record-retrieval\` with \`not-retrieved\` (not an exclusion), and say so; \`sought\` means retrieval is still in progress.
- Screen in batches (\`screen\` takes up to 500 decisions) and read the result: \`skippedSourceIds\` were not applied. Your decisions are recorded as the agent's; the user can change any of them, and the latest decision counts.
- Do not present agent screening as independent dual screening. If the protocol needs a second reviewer, say which decisions still need one.

## Report

Read the review again before reporting. Give the PRISMA counts from the tool, not your own tally, and include \`prismaMermaid\` when the user wants the diagram in a document. State what is still pending (records awaiting screening, reports awaiting retrieval or assessment, maybes) and every search or decision the user should check.
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
    directoryName: "references",
    defaultActive: true,
    files: Object.freeze({
      "SKILL.md": references,
      "scient.skill.json": `{
  "apiVersion": "scient.skills/v1alpha1",
  "id": "scient.references",
  "version": "0.1.0",
  "category": "Research",
  "categoryDescription": "Check, find and cite the literature.",
  "displayOrder": 80,
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
    directoryName: "systematic-review",
    defaultActive: true,
    files: Object.freeze({
      "SKILL.md": systematicReview,
      "scient.skill.json": `{
  "apiVersion": "scient.skills/v1alpha1",
  "id": "scient.systematic-review",
  "version": "0.1.0",
  "category": "Research",
  "categoryDescription": "Check, find and cite the literature.",
  "displayOrder": 90,
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
