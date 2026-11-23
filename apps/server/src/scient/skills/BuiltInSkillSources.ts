export interface BuiltInSkillSource {
  readonly directoryName: string;
  /** Scient-owned product policy. Portable skill manifests cannot self-activate. */
  readonly defaultActive: boolean;
  readonly files: Readonly<Record<string, string>>;
}

const workspaceReadinessReview = `---
name: workspace-readiness-review
description: Review reproducibility and onboarding; can another researcher or agent understand this workspace, rerun its work and verify its outputs? Use improve-workspace-readiness to apply the findings. Ordinary project orientation, proofreading and release checks are other tasks.
---

# Workspace readiness review

Return a prioritized review of whether the next person could pick up the requested work, with file evidence for each finding. The review is read-only: read files, documentation and saved outputs, and leave analyses, builds, installs and anything that writes to the researcher. Judge against the project's own workflow rather than a score or a folder template.

Work out the project's purpose from its files and instructions, then trace one representative workflow end to end: instructions, inputs, environment, entry point, run record, output. Follow the paths and entry points the documentation names, not its headings, and give file and line evidence. Keep what is documented apart from what was actually run.

For research work, look at what matters for that workflow:

- where the inputs come from, their version, access conditions, licence or ethics record, and what the variables mean;
- raw versus derived data, and anything that overwrites inputs;
- environment versions and lockfiles, the real commands, relative paths and host requirements;
- randomness, seeds, how splits are made and where preprocessing is fitted; flag silent choices and leakage risks and leave the analysis design to the researcher;
- what links important tables and figures to a run and its inputs (saved notebook outputs via \`scient_notebook_read\`, Scient linked results via \`scient_results_check\`). Two files side by side don't prove one made the other.

Check reported counts against the current files or tool results, keeping inputs, filtered data and the analysed sample distinct. A count that depends on randomness with no run record is unverified; mark it so, since choosing a seed and rerunning is the researcher's decision.

Missing access leaves a step unverified; it doesn't show the data or an approval is absent. Read restricted data only when the requested work needs it, not to complete a checklist.

Finish with the purpose, what you covered, what is already in good shape, and the findings in priority order, each with its consequence, the smallest fix and links to the files. Say what you verified and how, and what stays uncertain. If the workspace is ready for the requested work, say so. Offer to apply the fixes; applying them is a separate request.
`;

const improveWorkspaceReadiness = `---
name: improve-workspace-readiness
description: Apply workspace-readiness findings or improve onboarding and reproducibility guidance once the user asks for changes, including “yes, apply those findings”. Use workspace-readiness-review for a read-only assessment. Research analyses, protocols, manuscripts and application behaviour are out of scope.
---

# Improve workspace readiness

Make the smallest supporting changes that let the next collaborator follow the real workflow, and leave the research itself exactly as it was. State the routine choices you make.

Work from the agreed review and recheck its evidence; without one, trace the relevant workflow before editing. Each change answers a real gap in that workflow; style reorganisation and invented documentation requirements are out.

Write instructions, paths and provenance only from what you can establish: take counts from the current files or run records, keeping inputs, filtered data and the analysed sample distinct, and link an output to a script or notebook only when a run record or other evidence does. Write unknown access, licences, ethics approvals or run history as unknown and carry on rather than stopping to ask.

Code behaviour, raw and derived data, analyses, protocols, results and the argument stay unchanged. An unseeded sample, an unclear split or a missing cohort definition is a research decision: flag it for the researcher and leave seeds and logic as they are. Call a change result-preserving only when it cannot alter results. Moves, deletions, renames and tooling changes stay within the scope the user agreed; check links and references before moving anything.

Check the edited instructions against the actual paths, inputs and entry points, resolving relative links from their own file, with exact case and paths that contain spaces. Documentation is tested by reading: rerunning workflows that write, installing environments or changing data is outside the job. Say which commands you only read and which you ran.

Reread the diff for scientific changes disguised as cleanup. Reply with links to the changed files, what each change does and how you checked it, and the findings you left unapplied with the decision or evidence each needs. If no edit is justified, say so and leave the files alone.
`;

const scientSkillAuthoring = `---
name: scient-skill-authoring
description: Make, write, review, shorten, improve or test a Scient skill; turn a recurring workflow into reusable agent guidance. Use connector-authoring when new service access or tools are needed. A review-only request produces findings, not an installed skill.
---

# Scient skill authoring

Deliver the skill the user asked for, in the home they asked for, with a description that makes it load at the right time and an honest account of how it was tested. Drafted, saved, active and actually discovered are different states; say which you reached. A review-only request ends with findings.

## Write it

Start from the user's real task and any example they gave. A skill earns its place when it captures know-how the agent would otherwise lack, for a task that recurs. Read \`references/writing-for-agents.md\` before drafting or reviewing; the essentials:

- The **description** is how an agent finds an automatic skill: the words the user would say, one trigger per distinct case, and the nearest neighbouring skill it should not be confused with. Make a skill explicit (chosen by the user) when it is a mode the user should deliberately enter.
- The body states the **outcome**, the steps or rules that aren't obvious, and a **finish line** the agent can check for each step ("every comment answered", not "respond to the comments").
- Say what to do rather than what not to do; use one well-known term where a sentence would do; leave out what the model already does and what tools and Scient's instructions already say. Write plain prose that keeps related actions together.
- Move rarely needed detail into resource files and say when to read them. Link copyrighted or restricted checklists rather than reproducing them.

## Save it in the right home

Use the home the user asked for. For a personal skill, read the existing one with \`scient_skill_read\` before changing it, save with \`scient_skill_save\`, and read \`status\`, \`active\` and \`message\`: a name that collides with a built-in or add-on skill is saved but withheld. For a project skill, write \`.scient/skills/<name>/SKILL.md\` in an initialized Scient project, with the frontmatter \`name\` matching the folder; the folder holds \`SKILL.md\` and its resources, without a \`scient.skill.json\`, and unrelated folders stay as they are. Whether a skill is on, and whether it runs automatically or only when chosen, are Settings choices, not frontmatter.

## Test it

Run the skill on the user's example, on a disposable copy if it writes files, and compare the result with what they wanted. Try a nearby request where it should not apply. File validation alone is not a test; if you can't test, say what is untested.

For a fuller comparison, when the user asks for one, run the same inputs in fresh contexts with and without the skill, keep expected answers out of the test agent's reach, and record whether the skill loaded separately from how well the task went.

Reply with where the skill lives (a link for files you wrote; the name and status for a personal skill), what you tested and what happened, and what remains untested. Claim automatic discovery only after you've seen an agent load it on its own.
`;

const connectorAuthoring = `---
name: connector-authoring
description: Connect a service, or build, fix, sign in to or test a Scient connector (MCP server) for a website, API, database, file collection or local program, when existing connectors and Scient tools don't give the access needed or a connector fails or returns wrong data. Use scient-skill-authoring for reusable know-how that needs no new tools.
---

# Connector authoring

Finish with a connector that answers the user's real questions, proven by a real read through the installed connector whose data you compared with the source, or with the exact step that blocked it. Startup and \`ok: true\` only prove the transport.

Start with what exists: \`scient_connector_list\` finds installed and catalogue connectors, and \`scient_connector_add\` adds one that fits. Build only the missing access, and use the user's actual tasks as acceptance cases.

Guardrails: passwords, tokens, cookies and captured sessions stay out of chat, code, manifests and logs; CAPTCHAs, two-factor prompts and bot protection are the user's to pass, never the connector's. A read-only diagnosis inspects status and code and stops there; \`scient_connector_check\` runs the connector and the calls you give it, so give it only reads.

## Build

1. Read the references the job needs (below). Design a few tools around the user's tasks: strict schemas, bounded outputs, stable identifiers, explicit paging and truncation, writes separate from reads.
2. \`scient_connector_copy\` gives a working folder (\`name\` for a new connector, \`connector\` for an installed local one). Read its README and code, replace the example tools and update the manifest. Scient supplies Node; keep any dependencies inside the folder, since npm may be absent.
3. Test the folder with \`scient_connector_check\`: startup, the tool list, then sample calls. Read each call's \`isError\` and \`text\`, plus \`missing\`, \`error\` and \`log\`, and compare the data with the source. Try a next page, an empty result and bad input where they apply. Done when each tool has a checked result and every page cap or cut field (such as shortened author lists) is written down.
4. For a keyed service, confirm in the folder check that a protected read returns a setup message without the key. For website sign-ins, read \`references/auth-and-sessions.md\`.
5. Save once with \`scient_connector_save\`. If the returned connector needs a key, run \`scient_connector_setup\` for it; if the user closes or declines the card, report where it stopped and leave it closed this turn. Then test one real read with \`scient_connector_check\` giving \`connector\` and no \`folder\`. Report installed, configured and verified as separate states. Persistent rate limits or bot protection end the attempt; report them.

## Repair

A hosted connector has no local code: follow its setup or sign-in status (\`scient_connector_control\`). For a local one, copy it and read \`references/fixing.md\`: reproduce the failing read, make the smallest change that keeps its tools' contracts, retest that case and the reads that already worked, and save over that same connector, leaving every other connector as it is.

Read \`references/testing.md\` before calling it done. Report what the connector does, its tools, a real result you inspected and the gaps, with links to its source. Tell the user they can remove it from its page in **Settings → Extensions** (**Remove**), and after a repair that **Undo last change** is there.

## References

Read with \`scient_skill_read_resource\` (this skill's name and the path):

- \`references/tool-design.md\`: schemas, paging, errors and writes.
- \`references/auth-and-sessions.md\`: keys, website sessions and expiry.
- \`references/study-a-website.md\`: before building for a site with no documented API.
- \`references/science-apis.md\`: scholarly APIs and their limits.
- \`references/local-tools.md\`: local files, databases and command-line tools.
- \`references/testing.md\`: acceptance and honest completion.
- \`references/fixing.md\`: diagnosis and repair.
`;

const pdfAuthoring = `---
name: pdf-authoring
description: PDF output. Make, edit or export a PDF of my paper, report, poster, grant, handout or form, including Markdown and HTML-to-PDF. Use latex-authoring for writing or troubleshooting .tex. Reading or extracting a PDF and building an ordinary webpage are other tasks.
---

# PDF authoring

Deliver the saved PDF, checked against what was asked for in content and layout, together with its editable source. If a build or the visual check can't be done, say which and give the useful files you have.

## Source

Keep the document's existing editable format and design. HTML builds with \`scient_pdf_build\`, Markdown exports with \`scient_document_export\`, and LaTeX builds with \`scient_latex_build\` (load \`latex-authoring\` for source work). For HTML print layout, read this skill's \`references/html-print.md\`.

To change a PDF's content, edit its source and rebuild; an existing PDF is not an HTML build input. For page operations or form filling, work on the PDF itself with a library such as \`pypdf\` in Scient Compute and write a new file, keeping the text and structure as they are rather than retyping or rasterizing; check that links, form fields, bookmarks, selectable text and untouched pages survive. If a text edit needs a source you don't have, say so.

Builds and exports write to \`outputPath\` and replace what is there, so choose it deliberately. A request only to check a PDF needs no rebuild or export; rendering page images in a temporary folder to look at them is fine.

## Check before finishing

1. Confirm the build wrote the PDF at the returned \`outputPath\` and read every warning. An open preview tab is not proof of a built file.
2. Check the page count against any limit, and that every section, figure, table and equation survived. Fix missing images and blocked assets, or name what is missing. Fit pages with all content kept and type at readable size.
3. Render the pages to images and look at them (\`references/visual-check.md\` has the commands and \`scripts/render_pdf.py\`). Look at every page of a short document; for a long one, the changed pages, page breaks and each distinct layout, and say which pages you skipped. Rebuild and look again after fixes.
4. Check what readers will notice: labels readable at print size, clipped tables, equations, glyphs, citations and cross-references. When the venue requires it, also check links, font embedding, image resolution and tagging; appearance alone doesn't show accessibility.

Reply with links to the PDF and its source, the page count, the pages you inspected, warnings and anything unfinished. If you couldn't look at the pages, say "visual inspection not performed" and why, and call the PDF unchecked.
`;

const latexAuthoring = `---
name: latex-authoring
description: LaTeX and .tex files. Write or edit LaTeX; compile my paper; fix LaTeX errors, missing citations, equations or figures. Use overleaf-sync for transferring or resolving synced files, and pdf-authoring for other PDF formats. An Overleaf mention alone is not a sync request.
---

# LaTeX authoring

Deliver source that still builds and stays maintainable and, when compiling was asked for or is needed to verify a fix, a built PDF you have looked at. For source-only work, say whether you compiled.

Keep the document's class, engine, bibliography system and file structure, and work from its real root file. When a package or font is missing, report what is missing and keep the engine and journal class as they are.

## Citations and content

Cite only with keys from the project's bibliography or from verified source records; every BibTeX entry you add is copied from a record, never written from memory. For new citations in a Library-managed bibliography, add the source to the Library and cite it from there; for a hand-maintained \`.bib\`, copy the details from the registry or publisher record into that file, keeping it hand-maintained. A key that compiles is not evidence for its sentence; load \`references\` to check support.

When you change equations, symbols, units, numbers or labels, compare them with what the researcher gave you, and keep the argument as it was. Check figure paths (exact case and extension) from the root, and that every command you add has its package loaded.

## Build and look

Compile with \`scient_latex_build\` from the real root. Fix undefined citations and references and missing files even when a PDF was produced, look at overfull boxes, especially in two-column layouts, and confirm the PDF is where the result says.

Then render the pages to images and look at them: \`pdftoppm\` if it is installed, otherwise \`pdf-authoring\`'s \`scripts/render_pdf.py\` and \`references/visual-check.md\` (read them with \`scient_skill_read_resource\`). Look at every page of a short document; for a long one, the changed pages, page breaks and each distinct layout, and say which you skipped. Check figures, tables, equations, glyphs and cross-references, and rebuild and look again after fixes. A clean log doesn't show the page; if you couldn't look, say "visual inspection not performed" and why.

For a journal or arXiv submission, check that venue's current instructions (engine, bibliography output, packages, file layout).

Reply with links to the PDF and each edited source, the page count from the latest build, the pages you inspected, the remaining warnings and anything unfinished. If the toolchain is blocked, name the missing engine, package or font.
`;

const overleafSync = `---
name: overleaf-sync
description: Overleaf transfer. Bring in or link an Overleaf project; sync, push or pull my paper; resolve Overleaf conflicts or conflict marks, recover an interrupted sync or undo a send. Use latex-authoring for editing or compiling .tex without transferring files.
---

# Overleaf sync

The goal is to keep a paper in a Scient project and its Overleaf project in step, losing nobody's text, and to report plainly what moved each way. Link, preview or sync only when the user asked to transfer files; resolving conflict marks in a local file is a local merge.

## The folder

One Overleaf project is one document, in its own folder inside the Scient project, and everything in that folder syncs: new files, deletions and renames included. Keep code, data and private notes outside it, and write the paper's figures into it. Bring a project in as a new folder (\`scient_overleaf_connect\`, mode \`new-folder\`) unless an existing folder holds just the paper; when the connect result says a folder looks like more than a paper, tell the user and prefer a new folder.

In a separate worktree, the tools act on the copy the link belongs to and say so; worktree edits reach Overleaf only once merged into that copy.

When a tool says the Overleaf Git token is missing or refused, ask for it with \`request_secret\` and save it with \`scient_overleaf_token\`; the token never goes through chat.

## Syncing

1. \`scient_overleaf_status\` lists each link and its state offline. A check-only question ends here: \`scient_overleaf_preview\` saves open editors and can finish an interrupted sync, so it changes things.
2. \`scient_overleaf_preview\` shows what would come in and go out, and any conflicts (\`diff: true\` for text differences).
3. \`scient_overleaf_sync\` brings Overleaf's changes in, then sends the folder's. "Push" and "pull" both sync both ways; tell the user so rather than promising a one-way transfer.
4. Report from the result: what came in, what was sent, what was held or skipped (counted apart from sent), renames (Overleaf drops comments and tracked changes on renamed files) and any recovery the sync did first.

## Conflicts and merges

Decide as you would for a Git merge: follow the user's instructions and use only the choices each conflict allows. When both sides hold real work and \`markers\` is allowed, use it and merge them; when it isn't (binary files, renames, deletions), keep both versions and settle the choice with the user. Pass the review's \`remoteTree\` back as \`reviewedRemote\`; if Overleaf moved meanwhile, decide again for the new review. A file still holding conflict marks is held back; \`files.release\` sends it as it is only when the marks are its real content, and \`files.send\` sends a file that was held. Explain your choices to the user.

As soon as merged text exists locally, and before a sync that would send it, check the merge: citations, captions, figures and numbers keep both sides' content, and no conflict marks remain. Then build with \`scient_latex_build\` from the real root, fix undefined citations, references and missing files, and look at the rendered pages: \`pdftoppm\` if installed, otherwise \`pdf-authoring\`'s \`scripts/render_pdf.py\` (read it with \`scient_skill_read_resource\`). Look at the changed pages, or every page of a short paper. If you couldn't build or look, say so and why.

## Recovery

The version a sync replaced is kept: \`scient_overleaf_kept_copies\` lists and restores copies. \`scient_overleaf_undo\` puts back what Overleaf had before one send, then syncs; list the sends first. \`scient_overleaf_manage\` relinks, recovers an interrupted sync or cancels a running one. Restoring and undoing change files, so use them only for the recovery the user asked for. When a tool stops with an error, do what it says, or tell the user when only they can fix it.

Reply with links to the changed sources and any built PDF, what moved each way, the build and visual check, and anything unresolved. For a local-only merge, say that nothing was synced.
`;

const references = `---
name: references
description: >-
  References, citations or bibliography of a paper, thesis, grant, review or report, for the
  whole document or a passage, or the project Library's records. Check or verify references,
  fix citations and bibliography entries, find sources for claims, methods, instruments,
  software, data or guidelines, find better or newer references, and judge whether cited work
  supports the text. Use compare-sources for an evidence table of named papers and
  systematic-review for a database search and screening. Writing a literature review from
  scratch is a different task.
---

# References

The goal is a draft in which every citation points to a real work, described correctly, that still stands and supports the sentence citing it, and in which everything that needs support has it. The researcher owns the scholarship: find the problems, show the evidence, fix what is clearly wrong when asked, and leave real choices to them.

Finish the whole check in this turn. If something can't be finished, say exactly what is left.

## What the tools cover

\`scient_references_check\` checks records against registries, one identifier per entry. Its coverage has limits that it doesn't always flag:

- \`ledger\` lists the entries it handled, including ones it could not check; read \`notes\` even when \`complete\` is true.
- It stops at 500 references and 300 findings (\`omittedFindings\`); a second run covers the same ground.
- It reads only the file you give it, so LaTeX \`\\input\` and \`\\include\` files need their own check.
- Hand-typed citations in a Word file with reference-manager fields can be missing from it.
- It checks records only. A clean result says nothing about support.

\`scient_references_resolve\` applies a finding's \`fix\` as the check returned it; a stale fix means the file changed, so check again. Search the Library before anything else. Many computer-science conference papers and mathematics books have no DOI: use proceedings, publisher and zbMATH records for them, and the issuing body for editions of guidelines, manuals and software.

The writing calls are \`scient_references_resolve\`, \`scient_paper_get\` (saves a PDF), \`scient_sources_add\`, \`scient_sources_import_file\` (adds a project's .bib, .ris or CSL-JSON file to the Library, skipping entries it holds), \`scient_sources_cite\` (pins sources and updates \`references.bib\`) and \`scient_sources_bibliography\` (rewrites \`references.bib\`). Keep to the project folder, and leave \`.scient\` files to the tools.

## What to check

- **Records.** Run \`scient_references_check\` and read all of it before editing. Build your own inventory of the citations and reference list in scope and reconcile it with the ledger, so every reference ends up in your report. A difference is a lead, not a verdict: abbreviations, online and print years and indexing gaps all cause them. Find the record yourself for a reference without an identifier.
- **Support.** For every citation, does the work support the sentence as written? Typical failures: narrower than claimed (association as cause, mice as humans, healthy volunteers as patients, a lab feasibility study as home efficacy), the opposite or a null result, the wrong paper, a review cited for a primary finding, a different number. Grade it supports, partly supports (say which part), does not support, contradicts, or not assessed.
- **Not only findings.** Methods, instruments, statistical procedures, software, datasets, guidelines, criteria and figures about the world each need the source a reader would check: the original or standard reference for what was used.
- **Versions and currency.** Guidelines, reporting standards, scoring manuals, criteria and software have versions, and figures about the world date. Search for a later edition or estimate and record what you found. Keep the edition the work actually used and report a newer one as a decision; replace a statistic only with a newer estimate.
- **Evidence against.** When a sentence states a general or strong effect, look at later work before calling it supported: replications and meta-analyses since the cited year, and papers citing the source. Report important contrary evidence.
- **Gaps and better references.** Sentences, including paragraph openers, that state a finding, number or trend, or use a named method, instrument or tool, with no citation; and better choices: primary over review, published over preprint, newer where the field has moved. For each gap, give at least one checked candidate, or say what you searched.

Read the abstract for every judgement and the full text where the claim is specific or the abstract leaves it open. For a long document, take claims the argument rests on first, then numbers, then retracted or contested sources, then the rest.

The check is done when every reference in your inventory has a record status and a support grade (or a reason it has none), and every gap has a candidate or a search record.

## Evidence rules

- **Never cite from memory.** Every reference you add or suggest, in the draft or the report, comes from a scholarly record or publisher page found in this task, read far enough to judge support. Copy its details, every author included, from that record; give its DOI or other stable identifier when it has one, and mark any detail you could not confirm.
- **Report what you observed, and where:** "the DOI does not resolve", "none found in PubMed and Crossref". For each judgement, say whether it rests on full text (opened in this task), abstract or metadata. Say whether a page number is the PDF page or the printed page. Give confidence in words with a reason.
- **Missing from indexes is common** for books, manuals, reports, theses and proceedings. Search title, authors and venue before calling a reference likely fabricated.
- **No suitable source is a valid answer.** Propose narrowing the claim rather than attaching a weak citation.

## Changing the draft

A check-only request leaves the draft, its bibliography and the Library as they were: use none of the writing calls, read what the Library holds and open full text on the web (PubMed Central, arXiv, the publisher's page) without saving it, and report a paper you couldn't read as not read, with what reading it would need.

When asked to fix:

- **Apply:** the check's fixes through \`scient_references_resolve\`; other details from the record; missing bibliography entries built from the record, identifying a cited-but-missing key from its sentence, key and year; a citation for something the text names (a method, instrument, software, dataset, guideline, or the authors it names); the paper a true claim actually comes from when it is attributed to the wrong one, including the primary study when a cited review reports it (find it rather than delete the claim); overclaims narrowed to what the cited source shows, in the author's words as far as possible. Narrowing a sentence to its own source is a fix. When the source supports a claim that later work disputes, attribute it in the text ("X et al. reported …") and propose the contrary evidence. Change an identifier only to one you confirmed resolves to the work.
- **When the cited work can't be found** and its identifier belongs to a different paper, keep the entry as it is, report the work as not found and the claim as unsupported, and list it as a decision for the author.
- **A claim resting on a retracted, nonexistent or contradicting source** is always flagged. Narrow it if the cited source supports a narrower version; otherwise propose a supported revision or removal as a decision for the author, rather than swapping in a newly found study.
- **Propose, for the author to decide:** newly found studies as evidence, contrary evidence, new sentences, version changes, published versions of cited preprints, choices between alternatives, and anything that adds to or removes from the argument. The author must stand behind every sentence.
- **Keep what the author stated:** a venue, year or edition the records lack is marked unconfirmed; uncited bibliography entries stay and are listed; author lists stay complete; verification notes go in the report, not in bibliography fields.

Afterwards reread the changed passages, run \`scient_references_check\` again and, for LaTeX, build with \`scient_latex_build\` if you can; at least check that new text escapes \`_\`, \`&\` and \`%\`.

## Report

When you changed files, save a Markdown report next to the manuscript (for example \`main.references-check.md\`) and reply with a short summary and a link to it. For a check-only request, give the report in your reply and offer to save it.

Put the most serious issues first, each with location, problem, evidence (a short quote with its location and what you read), fix applied or proposed, and confidence. Then the decisions for the user, then the references that were fine (one line each, or grouped for a long list).

Say plainly whether the check is complete, with the coverage: references checked out of the total, claims checked for support, and anything skipped (caps, unvisited files, papers not read). Check that any file you saved holds what you describe.
`;

const systematicReview = `---
name: systematic-review
description: >-
  Systematic, scoping or rapid reviews in Scient: planning the review question and eligibility
  criteria, running and logging database searches, removing duplicates, title and abstract or
  full-text screening, and reporting a PRISMA flow. Use compare-sources for a comparison of a
  few named papers and references for checking a manuscript's references; an ordinary
  literature summary is a different task.
---

# Systematic Review

The goal is a review another researcher could repeat: every search logged exactly, every record accounted for, every decision recorded with who made it and why, and a PRISMA 2020 flow that matches the decisions. The researcher owns the question, the criteria and the final calls. Do the work they ask for, in the open, and finish it in this turn; change the review only for that work.

## Tools

\`scient_sources_systematic_reviews\` reads a review: its searches, exclusion reasons, PRISMA counts and diagram (\`prismaMermaid\`), possible duplicate pairs, and up to 25 records awaiting a decision per read. \`scient_sources_systematic_review_update\` makes every change. Records are Library sources: bring them in with \`scient_sources_add\`, a file import or Zotero, and group a search's records with \`scient_sources_organize\` (a collection per search) or \`scient_sources_bulk_update\`. Read attached full text with \`scient_sources_read_text\` and \`scient_sources_search\`; to fetch a missing PDF, give \`scient_paper_get\` the DOI or URL and the record's \`sourceId\`, and check it is attached before using the Library text tools. Leave \`.scient\` files to the tools.

## Plan

Agree the question and eligibility criteria with the user before screening (population, intervention or exposure, comparator, outcomes, study designs, dates, languages). Criteria the user already gave are used exactly as given. Put the question in the review and set \`exclusionReasons\` from the criteria, so every exclusion names one of them.

Say which review type you are following:

- **Systematic review:** PRISMA 2020 reporting.
- **Scoping review:** Population, Concept and Context instead of PICO; PRISMA-ScR reporting; chart the evidence; risk of bias only if asked.
- **Rapid review:** name every shortcut (one database, one screener, English only) and the check that compensates for it.

## Search

Use the databases the user names. Build each search from free-text terms and the database's controlled vocabulary (such as MeSH) where it has one. Page through to the end of the results, or say where you stopped and why.

Log each search once with \`log-search\`, carrying all its records: \`database\` with its platform (PubMed, Ovid MEDLINE), \`query\` exactly as run, \`searchedOn\`, \`resultCount\` as the database reported it, limits and filters in \`notes\`, and the records you brought into the Library (\`sourceIds\` or a \`collectionId\`). Logging the same database, query and date again replaces the earlier log, so log the whole search, not page by page. When you couldn't bring in every result, record how many are missing and why in \`notes\`; the flow counts them as removed for other reasons. Records found another way (reference lists, experts, websites, trial registries) go in with \`add-sources\`.

## Remove duplicates

Importing can return an existing Library record, and a record already in the user's Library is not necessarily a duplicate within this review. Keep each search's raw hit count in its log and reconcile the PRISMA counts against it. Records that disagree with their Library copy are kept separately and listed as pairs (\`scient_sources_list\` with duplicates). Work through those pairs and the review's \`possibleDuplicates\`: mark a duplicate only when both records are the same work, keeping the more complete or published version, and use \`mark-distinct\` for different works that share a title. For a record showing \`libraryMatch\`, read the duplicate notes in \`references/methods.md\` before linking it. Two reports of the same trial are separate reports of one study: keep both and note the link.

## Screen

- **Pilot first.** Screen a varied sample (about 10 to 20 records, or the protocol's pilot), note any criterion that was hard to apply and how you applied it, then carry on with the rest. Show the pilot in your report for the researcher to check.
- **Title and abstract:** judge each record from its title and abstract alone. Include any record that may meet the criteria, including one with no abstract whose title doesn't rule it out; exclude only when the available text clearly fails a criterion, naming it. Keep \`maybe\` for a decision deferred for adjudication, then resolve it or list it as outstanding. Judge only the text you were given.
- **Full text:** only records included at title and abstract. Read the full text and exclude with the criterion it fails. A report that can't be obtained gets \`record-retrieval\` with \`not-retrieved\`, not an exclusion; \`sought\` means retrieval is still under way.
- Screen in batches (\`screen\` takes up to 500 decisions) and read the result: \`skippedSourceIds\` were not applied.
- **Finish line:** each stage has no pending records, no \`maybe\` decisions (a maybe drops out of the pending count) and no outstanding retrieval. Report whatever is unresolved, by stage.
- **Who decided.** Your decisions are recorded as the agent's; the user can change any of them, and the latest counts. Agent screening is single screening, so report it as provisional until the protocol's independent screening is done; for a full systematic review that means a second person independently checks every full-text eligibility decision. For a rapid review, name the shortcut and its check.

## Report

Read the review again just before reporting and take every count from that read: searches, records, duplicates, includes, maybes, exclusions and pending. Give the PRISMA counts from the tool, and \`prismaMermaid\` when the user wants the diagram in a document.

The tool's final box counts included _reports_ although it is labelled studies: in a document, label it "Reports included" and give "Studies included" separately once reports are linked to studies. Use the PRISMA 2020 template that fits (registers are counted separately from databases). Mark the flow provisional while selection, retrieval or study linkage is unresolved.

State what is still pending (records awaiting screening, reports awaiting retrieval or assessment, maybes) and every search or decision the user should check, and link any files you saved.

For work after screening (extraction, risk of bias, synthesis, certainty), read \`references/methods.md\` first (with \`scient_skill_read_resource\`) and do only the phases the user asked for.
`;

const compareSources = `---
name: compare-sources
description: >-
  Compare two or more papers or sources on a question (what each tested, on whom, how, what it
  found, its limits) as a table the user can check and reuse, or turn such a comparison into a
  cited paragraph or methods justification in a document they name. The papers can be in the
  Library or named by title, DOI or citation key. Use references to check a manuscript's
  references and systematic-review for a systematic review.
---

# Compare Sources

The goal is a comparison the researcher can check cell by cell: every cell says what the paper reports, where, and what you read to say it. The researcher owns the conclusions: show how the papers differ and why, and leave the judgement to them.

Finish the comparison in this turn. If something can't be finished, say exactly what is left.

## Find the sources

Compare the sources the user named. Find each in the Library (\`scient_sources_list\`, \`scient_sources_get\`) by title, citation key or source ID. When a name fits several sources, ask which one they mean. When it fits none, identify it by its DOI, PMID, arXiv ID, ISBN or publisher record (search first for a title). Ask only if you still can't tell which work is meant.

Writing to the Library is the user's call. When they asked you to fetch or add sources, or said to get what you need, add missing ones with \`scient_sources_add\` and save missing PDFs with \`scient_paper_get\`, passing the Library \`sourceId\` so the PDF attaches; check it is attached before reading it through the Library. Otherwise work from what the Library holds and from open text with a stable link, and mark which cells rest on the abstract. If the user asked you to write nothing, also use the existing citation keys and give the comparison in chat.

## Choose the columns

The question sets the columns. With no question given, compare what the papers have in common (usually design, population, methods, outcomes, findings and limitations), say which focus you chose, and continue. For empirical work the columns are often design, population or setting, intervention or exposure, comparator, outcome and how it was measured, the key result, and risk of bias or limitations. Add a column only when the question needs it.

## Read

Read each paper with the Library tools: the abstract of every source, and the full text wherever a cell is specific (a number, population, measure, method or limitation). Record for each source whether its cells rest on full text (opened in this task), the abstract or metadata only. A source whose PDF is missing or has no readable text (\`no-pdf\`, \`no-text\`, \`unreadable\`) rests on its abstract at most. If a number sits in a figure or table that text extraction garbles, look at the page image or mark the cell \`Could not assess\`.

## Write the comparison

Save it as a Markdown document in the project, such as \`comparisons/<short-title>.md\`, as a new file unless the user asked you to update one. Name the project's \`references.bib\` in its front matter (\`bibliography: ../references.bib\` from \`comparisons/\`) so citations resolve. In order:

1. The question, and the sources compared.
2. The table, one row per source and one column per aspect.
3. One short section per finding worth using: what it is, which papers show it, and the citations.
4. Coverage: for each source, full text, abstract or metadata only, the pages read, and what was not read and why. Then the date.

Every cell:

- **Kind.** Reported (what the paper says); derived, with the derivation and units ("difference 4.2 percentage points: 12.1% vs 7.9%"); or interpretation, beginning "Interpretation:". The reader can always tell which.
- **Numbers.** Each result with its measure, the population or denominator, the time point, whether it was adjusted, and its uncertainty (confidence or credible interval, or standard error). An SD is the spread of the data, not uncertainty. Odds ratios, risk ratios, hazard ratios and mean differences are different measures, as are estimates of different quantities: keep them in their own terms, with no computed winner or pooled number. Say when a paper's primary outcome is not the outcome of the question.
- **Citation.** Every substantive cell cites its source with the citation \`scient_sources_cite\` returns, and a locator you actually saw: the PDF page the tool reported, plus the printed page when one is printed (\`[@smith2020, p. 1123] (PDF page 4)\`), or the section, table or figure for a source without pages. \`scient_sources_cite\` also pins the source and updates \`references.bib\`, so it is a Library write; report any problem it flags, such as a retraction.
- **Empty is never blank.** \`Not reported\` when you checked the relevant text and it doesn't say; \`Could not assess\` when its text was unavailable or unreadable; \`Not checked\` when you didn't look. A search that finds nothing is not proof of absence.
- **Quotes** are short, checked with \`scient_sources_quote_check\`, and copied from the text it returns.

Between the papers:

- Flag when two may report the same study or overlapping data (same trial, cohort, dataset, authors and period), when one pools the others (a meta-analysis that includes the trials beside it), or that you can't tell. One study counts once as agreement.
- Explain differences (population, setting, measures, outcomes, datasets, analysis) rather than declaring a winner, in terms of what you observed: "not reported in the full text", not "not done".

The comparison is done when every cell has content or one of the three empty labels, every substantive cell has a citation and locator, and the coverage section covers every source. Reread the document, confirm every citation names a source you read, and reply with a short summary and a link to it.

## Use it in the user's work

When the user asks, write a cited paragraph or methods justification from the comparison into the document they name, at the place they say. Use the comparison's citations and claims only, in the document's citation style: \`scient_sources_cite\` with \`format\` \`markdown\` or \`latex\`; for other formats, the document's own citation mechanism, or clearly marked references and a note on what you couldn't insert. Change only that passage (plus the bibliography updates \`scient_sources_cite\` makes), reread every inserted sentence against the table, and show the user what you inserted.
`;

const statisticsReview = `---
name: statistics-review
description: Check the statistics in my results, table or analysis before I send it; are the tests, uncertainty and conclusions right? Use check-reported-numbers to match draft numbers to outputs, ml-evaluation-audit for model evaluation, and reporting-guideline-check for a journal checklist.
---

# Statistics review

The goal is a review the researcher can act on: every reported test checked, each problem located and explained, with a concrete fix. It is a review, so leave the draft and the analysis as they are unless asked to change them, and finish it in this turn. Questions for the researcher go at the end, after the finished review.

## Read

Read the results and whatever explains them: methods, table notes, the analysis plan or preregistration, and linked outputs or notebooks (\`scient_notebook_read\` shows saved outputs without rerunning anything). Work out the question, the design, the outcome, the comparison and the analysed population. Note what is missing instead of guessing it.

## Check

Keep a ledger of every reported test and estimate: where it is, the estimate with its uncertainty, n, the test statistic, df where the test has them, and the p-value. Then look for the problems that matter in practice:

- **Wrong test for the design.** Check that each test fits how the data were collected and what they look like. Identify the independent sampling or assignment unit (participant, animal, cluster) and check that the analysis handles clustering and repeated measurements; check each n against its stated unit, and df against the model and test.
- **Incomplete or inconsistent reporting.** An effect without its size or interval, spread and precision confused (SD, IQR vs SEM, CI), p-values printed as \`.000\` (should be \`p < .001\`), or a p-value that cannot follow from its statistic and df. Recompute what you can from the reported values. Call a mismatch only when the reported details (df, sidedness, corrections) determine the calculation and the result falls outside rounding; if a missing detail could explain the difference, say which detail is needed and mark the value unverified. Use Scient Compute for the arithmetic.
- **Multiplicity and selection.** Many outcomes, subgroups or analyses with no plan or correction, outcomes that differ from the plan, or selection that reuses the data being tested.
- **Conclusions the numbers don't support.** A difference claimed from one significant and one non-significant result without a test of the difference; non-significance read as no effect; causal claims without a design and stated assumptions that support them; statistical significance read as importance; post-hoc power used to explain a null.

Say also what is done well, so the researcher knows what to keep. Every number in the review comes from the draft, the outputs or your own recomputation. Done when every ledger row has a status (checked, problem, or not checkable and why).

## Report

For a project draft, save \`<draft-stem>.statistics-review.md\` next to it, without overwriting an existing file. Put the most consequential problems first, each with location, what is wrong, why it matters and the fix. Then give the ledger and what you couldn't check. Reply with a short summary and a link to the report. For a short passage pasted into chat, answer in chat.
`;

const checkReportedNumbers = `---
name: check-reported-numbers
description: Check every number in my abstract, text, tables and figure captions against the project's CSVs, notebook outputs, logs or analysis tables; find mismatches and numbers with no source. Use statistics-review for methods and conclusions, references for other papers' numbers, and workspace-readiness-review for project reproducibility.
---

# Check reported numbers

The goal is to know, for every number in the draft, whether the analysis outputs support it, and to say honestly how many were checked. Propose corrections in the report and edit the draft only when asked. Finish in this turn and put questions at the end.

## Inventory first

Go through the draft section by section (abstract, text, tables, captions, supplements in scope) and list every reported number, counting repeats separately: counts, percentages, means and spreads, estimates and intervals, p-values, durations, units. Count them before matching anything, so the coverage you report is a count, not an impression. The inventory is done when every section in scope has been read and every number in it has a row. Numbers that aren't results (citation years, section numbers, external facts) can be grouped and counted rather than traced.

## Trace each number

Find where each number comes from: a file and row or cell, a notebook output (\`scient_notebook_read\` shows saved outputs without rerunning), a log line. If the project uses Scient linked results, \`scient_results_check\` reports values that are out of date or edited. Match by meaning, not by resemblance: the same measure, population, time point and adjustment. When several outputs could be the source, prefer the one the methods describe and the run record supports; if they disagree and nothing says which is final, report a source conflict rather than picking the closest value. A file being newer or named "final" is a hint, not proof.

Recompute what is derived: percentages from their numerators and denominators, totals, differences, unit conversions. Use full-precision source values where they exist and round the result to the draft's precision; when only rounded inputs exist, carry their rounding bounds through and call a mismatch only when the draft value falls outside them. No blanket tolerance. Use Scient Compute for the arithmetic. Check against the outputs as they stand: a number that appears only after refitting a model or changing a filter has no source.

Give each number a status: matches, mismatch, source conflict, no source found, source stale or unreadable, or not checked (with the reason). A number without a source is unsupported, not necessarily wrong. Tracing is done when every inventory row has a status.

## Report

Before reporting, check that the ledger has a row for every number in the inventory; fix it if not. For a project draft, save \`<draft-stem>.numbers-check.md\` next to it, under a new name if that file already exists. Put the mismatches that change a result or conclusion first, each with location, draft value, source value and location, and the proposed correction. Then give the coverage (numbers found, checked, matched, unresolved, excluded) and the full ledger. Reply with a short summary and a link to the report.
`;

const reviewerResponse = `---
name: reviewer-response
description: Draft my point-by-point response or rebuttal to journal reviewers, or check my existing response, against the revised manuscript and our actual decisions. Use references for citation support, statistics-review for analyses, and reporting-guideline-check for checklist compliance. Not for an independent peer review of someone else's paper.
---

# Reviewer response

The goal is a response the authors can send after filling in only what genuinely needs them: every comment answered, every claimed change really in the manuscript, and nothing promised or invented. The authors own the decisions; the response carries them out. Finish the drafts in this turn and put open questions for the authors at the end.

## Read

Read the decision letter, every review, the authors' notes or decisions, the original and revised manuscripts, supplements and any outputs the responses rely on. Follow the journal's required format if it gives one.

## Ledger

Split the reviews into answerable points in reviewer order, with identifiers such as R1.2 (assign them if the reviewers didn't number their points), keeping each point's original wording. Include minor and editorial requests. For each point record what the authors decided: done, decided but not yet done, declined (with their reason), or needs an author decision. The ledger is done when every point in every review has a row and one of these statuses.

## Check every claimed change

For each change the authors say they made, find it in the revised manuscript or supplement and note where it is (section and a short quote, or page and line from the version you read). If you can't find a claimed change in the revision you were given, treat it as unverified, not done, and say which version you checked. Check that numbers quoted in the response match the outputs and the revised text. This step is done when every claimed change has a location or is marked unverified. If you applied LaTeX or bibliography changes, build and check references as far as is in scope, and say what you couldn't check.

## Write the response

For each point, answer directly first, then give the reason and where the change is. Keep reviewer text, response and quoted manuscript text visually distinct. Be courteous; where the authors disagree, or the reviewer is mistaken, say so politely with the evidence rather than conceding. Where reviewers ask for opposite things, explain to each how the authors resolved it.

Claim only what the manuscript shows. Answer work that is decided but not yet done conditionally ("we will revise …") or with a clearly marked placeholder for the authors. Analyses, results, citations, approvals and agreements come from the authors or the files; where one is missing, leave a marked placeholder for the authors to supply, never an invented one. Before finishing, reread the whole response, including the opening and closing paragraphs, for completion claims the manuscript doesn't support.

## Deliver

If the user asked you to check an existing response rather than draft one, report your findings and write files only if asked. Otherwise save \`reviewer-response.md\` beside the manuscript, and \`manuscript-changes.md\` with the ledger, the evidence for each change, proposed edits not yet applied (before and after) and the decisions still needed. Use the journal's template or a file the user named when given, and pick a new name rather than replacing an existing file. Edit the manuscript only if asked. Reply with a short summary, what still blocks submission, and links to the files.
`;

const mlEvaluationAudit = `---
name: ml-evaluation-audit
description: "Audit whether I can trust this machine-learning score before submission: train/test splits, leakage, tuning, baselines, metrics and variation across runs. Use check-reported-numbers for score transcription, statistics-review for general inference, reporting-guideline-check for a checklist, and workspace-readiness-review for reproducibility."
---

# ML evaluation audit

The goal is an honest answer to "would this score hold up on new data like the intended use?", with every problem located and, where the data allow, measured. It is an audit: leave code, data, splits and project notes as they are and propose fixes instead of retraining, unless asked. Finish in this turn and put questions at the end.

## Read

Read the claim, the methods, the pipeline code and configuration, split files, predictions and run logs. Work out the intended use, the unit that must be independent between training and test (patient, subject, site, document, time period), when predictions would be made in practice, and which inputs exist at that moment. Mark unknowns instead of guessing them.

## Check

- **Leakage across the split.** Where identifiers allow, compute how many test units also appear in training (count, denominator and percentage) rather than saying leakage is possible. Check duplicates and near-duplicates. Trace every fitted step (imputation, scaling, feature selection, resampling, encoding, learned representations) and confirm it was fitted on training data only, within each fold. Look for features that encode the label or would not be available at prediction time.
- **Tuning and selection.** Hyperparameters, features, thresholds, checkpoints and calibration chosen without touching the final test set; repeated test access or best-of-many runs reported as one.
- **Baselines and metrics.** Methods compared on the same cases and splits, with simple baselines. Metrics that suit the task and the claim: for a rare outcome, judge results against the prevalence and a trivial baseline, and report discrimination, precision-recall and calibration rather than accuracy alone (the chance level for precision-recall is the prevalence, for ROC AUC 0.5); for multiclass or regression, the averaging and the naive baseline.
- **Uncertainty.** Variation from training (seeds, splits) is different from sampling uncertainty on the evaluation population (an interval or resampling at the independent unit, keeping pairs when models share test cases). Say which of these the available runs and predictions can show; a single run reported without either is a finding.
- **Claims.** Generalisation, superiority and readiness for use, each against the evidence actually shown.

Do counts and metric checks in Scient Compute on the project's data, writing nothing to project files. Read saved notebook outputs with \`scient_notebook_read\` and rerun notebooks only when asked. If Scient recorded the evaluation runs, \`scient_results_list\` shows them, and \`scient_results_check\` checks values linked into the manuscript. Every run, count and interval in the audit comes from the project or your own computation. Done when each area above has a located problem, a finding of sound with its evidence, or the reason it couldn't be checked.

## Report

For a project audit, save \`<draft-stem>.ml-evaluation-audit.md\` beside the manuscript (or \`ml-evaluation-audit.md\` beside the evaluation code), without overwriting an existing file. Lead with the problems that most change the trust in the score, each with location, evidence (including the numbers you computed), impact and the proposed fix. Then list what was checked and found sound, and what couldn't be checked. Reply with a short summary and a link to the report.
`;

const reportingGuidelineCheck = `---
name: reporting-guideline-check
description: Which reporting guideline fits my manuscript? Check my paper against the current CONSORT, STROBE, PRISMA, TRIPOD+AI, STARD, ARRIVE, CARE, SPIRIT or another checklist, item by item with manuscript locations. Use systematic-review to conduct a review, statistics-review or ml-evaluation-audit for methods, and references for citation support.
---

# Reporting guideline check

The goal is to name the right reporting guideline for the study actually done, with its current edition confirmed, and to show item by item what the manuscript already reports and what is missing. Complete reporting is not the same as good methods; say so where it matters. Leave the manuscript unchanged and finish in this turn, with questions at the end.

## Choose the guideline

Read the title, abstract, methods and any protocol, registration or journal instructions. Choose by what the study did, not what it calls itself: a trial report or protocol, an observational study, a systematic review, a prediction model, a diagnostic accuracy study, an animal experiment, a case report, or something else. Check whether an extension applies, such as for AI, cluster designs, non-inferiority or scoping reviews, and whether the field has its own standard (for example COBIDAS for neuroimaging or REFORMS for ML-based science). For health research, start with the EQUATOR Network directory (equator-network.org); for other fields, with the venue and the issuing group. Follow the issuing group's instructions on how an extension relates to its base: some add items to the base checklist, some are complete checklists of their own, and some replace an earlier version. Record which items you audited and which edition they came from.

Take the current edition and its items from the official source, since guidelines are updated, and record the edition, link and date you checked. If the journal requires an older edition, audit against that one and note the difference. If the official checklist can't be opened, still finish: give a clearly labelled provisional review of the main reporting areas and say that item-level compliance couldn't be confirmed.

If the user only asked which guideline fits, answer that in chat with the reasons and the confirmed edition.

## Audit

Go item by item. For each, give a short description in your own words (link the checklist rather than copying its text), where the manuscript reports it (section and quote, or page; say whether a page is printed or PDF), and a status: reported, partly reported, not reported, not applicable (with the reason), or not checked. Read the relevant sections and supplements before calling something missing; a heading is not the content. Credit what is there before listing gaps. Suggested wording states only facts the manuscript gives; mark what the authors must supply.

Before reporting, check that every official item has a row and that your summary counts match the table.

## Report

For a manuscript audit, save \`<draft-stem>.reporting-guideline-check.md\` next to it without overwriting an existing file: the choice and its reasons, the confirmed source, the most important gaps first, then the full item table. Reply with a short summary and a link.
`;

const diagnoseAnalysis = `---
name: diagnose-analysis
description: >-
  Diagnose analysis code or a pipeline that gives a wrong, changed or inconsistent result,
  fails, or got slow: a number or figure that moved, results that differ between runs or
  machines, a script or notebook that errors. Use when the user says something is off,
  broken or "why did this change?". Use statistics-review to judge whether the method itself
  is sound.
---

# Diagnose analysis

A discipline for hard problems in analysis code. Keep raw data as it is throughout; work on copies and in Scient Compute.

## 1. Build a check that goes red

**This is the skill.** If you have a **tight** pass/fail check that goes **red** on _this_ problem, you will find the cause; everything after it consumes that check. Without one, reading code is guessing. Spend most of your effort here, and be creative:

- a short script that recomputes the suspicious number and compares it with the value the user trusts (an earlier output, a published table, a hand calculation);
- the pipeline run on a small fixture or subset, diffed against a known-good output;
- the same input through the old and new code (git history, an earlier notebook output) or two environments, with the outputs diffed;
- for "sometimes different": many runs with and without a fixed seed, to measure how often it happens.

Make it fast and deterministic (small inputs, fixed seeds, pinned versions). Done when one command or Compute run you have already executed detects the user's exact symptom (the same wrong number, the same error) against a stated expectation, as fast as the symptom allows. For an intermittent problem, the finish line is a recorded reproduction rate under fixed conditions; for a slowdown, measured timings against a baseline. If you truly can't build one, say so, list what you tried, and ask for what would make it possible (the trusted earlier output, the data version, the environment). Form no theory before this check exists.

## 2. Reproduce and minimise

Run the check and confirm it shows the problem the user described, not a different one nearby. Then shrink it: remove inputs, steps and options one at a time, rerunning after each, until every remaining piece is needed for the check to go red.

## 3. Hypothesise

Write 3 to 5 ranked hypotheses before testing any. Each must be falsifiable: "if X is the cause, changing Y makes the problem disappear". In analysis code the usual suspects are joins and merges that drop or duplicate rows, filters and missing-value handling, grouping and sort order, type and unit conversions, defaults that changed between package versions, randomness, and the input data itself changing. Show the ranked list to the user, since they may know what changed; carry on with your ranking if they aren't there. Done when the list is written down, before the first probe.

## 4. Test one change at a time

Each probe tests one prediction. Prefer inspecting intermediate results (row counts, keys, summaries at each step) over adding prints everywhere. Tag any temporary print or file with a marker such as \`[DEBUG-a4f2]\` so you can remove them all at the end. Done when one hypothesis's prediction held and the check goes green when you change what it names, with the others ruled out or ranked below it.

## 5. Fix and lock it

If the user asked only why, report the cause, the reproducing check and the exact fix you propose, showing on a copy that it restores the expected result. When they ask for the repair, fix the cause, not the symptom, and keep the check as a lasting one where the problem actually occurs (a test, or an assertion in the pipeline such as an expected row count or unique key): watch it fail before the fix and pass after. If the fix changes results the user has reported, give the old and new values side by side; whether to update a paper or figure is their decision.

## 6. Clean up and report

Remove every tagged debug change, and after a repair confirm the original problem no longer reproduces. Reply with the cause (the hypothesis that held, with the evidence), the fix (applied or proposed), the check, the results that change, and links to any changed files.
`;

const grillMe = `---
name: grill-me
description: >-
  Grill me on a plan before I commit to it: a research question, study design, analysis
  plan, preregistration, grant aim, experiment or any decision. Use when the user asks to
  be grilled, stress-tested or challenged, or wants to think a plan through before running
  or writing anything. To prepare questions for someone else to answer, use to-questionnaire.
---

# Grill me

Interview the user relentlessly until you both share one understanding of the plan, with nothing left silently assumed. Map the plan as a **design tree**: every decision branches into the decisions that hang off it. For research, the tree usually runs through the question and estimand, the population and unit of analysis, the design and comparison, outcomes and how they are measured, sample size, the analysis model, missing data, multiplicity, bias and confounding, and ethics and data access; follow the branches this plan actually has.

Work the tree in **rounds**. The **frontier** is every decision whose prerequisites are already settled: the questions you can ask now without guessing at answers you haven't heard. Ask the whole frontier in one round, number each question, and give your recommended answer with its reason. Then wait for the user's answers.

Format a round like this:

\`\`\`
❓ **Q1 - <question title>**: <the question, with the options where there are some>

➡️ <your recommended answer, and why>

---

❓ **Q2 - <question title>**: ...
\`\`\`

Word each question so that "yes" accepts your recommendation.

Each round of answers reshapes the tree: settled decisions unblock the questions that depended on them. Recompute the frontier and ask the next round. A question that depends on another one still open belongs to a later round.

Finding **facts** is your job; the **decisions** are the user's. Before asking, look up what the project already says (its files, data dictionary, protocol, the Library, earlier analyses) and what the field says (guidelines, typical effect sizes, standard methods), and bring those facts into your recommendation with their source. Ask the user only for what they must decide or only they know.

The session is done when the frontier is empty: every branch visited. Then summarise the agreed plan, decision by decision, and ask the user to confirm it. Write it up (as a plan, a preregistration draft or methods text) or start the work only after they confirm, and only if they ask.
`;

const toQuestionnaire = `---
name: to-questionnaire
description: >-
  Turn a question I can't answer alone into a questionnaire for someone else to fill in,
  such as a statistician, supervisor, collaborator, ethics committee, data owner or core
  facility. Use when the user asks for a questionnaire or a structured set of questions to
  send to someone or take into a meeting. Use grill-me when the user wants to be questioned
  themselves.
---

# To questionnaire

Turn what the user can't settle alone into a **questionnaire**: a Markdown document they send to one person to fill in, or go through together in a meeting. The recipient holds knowledge the user lacks; the questionnaire draws it out.

**Grill the send, not the subject.** Ask the user only about the send, which they can always answer: who it goes to, and what they need back. First read what the project already says (notes, protocol, analysis plan, data dictionary, earlier correspondence), so you ask only what the files don't answer and the questions carry the right context.

1. **Who is it going to?** Their role, expertise and relationship to the user. This sets the tone and how much context the document must carry. Done when you know who the recipient is and what they know that the user doesn't.
2. **What do you need back?** The specific decisions or facts the user needs from this person. Done when you have a concrete list of what the user must be able to do or decide afterwards.
3. **Write it.** Questions aimed at the gap between steps 1 and 2, in the structure below, saved as \`questionnaire-<topic>.md\` in the project. Done when the file exists and every item from step 2 has a question.

Ask steps 1 and 2 together in one message when the files don't already answer them.

## Structure

- **Title**, then **Purpose** (why it exists and the decision riding on it), **From / To**, and **How your answers will be used**.
- **Context:** one paragraph for someone who wasn't in the user's head, with the facts they need to answer well (design, sample, the data as it stands), taken from the project, not invented.
- **How to answer:** deadline and rough effort; "I don't know" and partial answers are welcome.
- **Questions** under \`##\` headings by theme once there are more than a handful, most important first, since the recipient may answer only once. Each question asks one thing, with space for the answer directly beneath (\`>\`), and a one-line _why this matters_ only where the question could be misread or invite a throwaway answer.
- **Anything else?** A closing question for what we didn't think to ask.

Reply with a link to the file and the questions you weren't sure belong in it.
`;

const teach = `---
name: teach
description: >-
  Teach me a method, tool or topic over several sessions, in a learning folder in this
  project. Use when the user wants to learn to do something themselves, not to have it done.
---

# Teach

The user wants to learn something over several sessions: a statistical method, a tool, a field. Teach it in a **learning folder** in the project (\`learning/<topic>/\`, unless the user names another place), whose files carry the state from one session to the next. Read them at the start of every session.

## The learning folder

- \`MISSION.md\`: why the user wants this, what they will use it for, and what "able to do it" looks like for them. All teaching is grounded in it.
- \`RESOURCES.md\`: the trustworthy sources you found (textbooks, papers, official documentation, courses), each with a link and one line on what it is good for.
- \`lessons/0001-<name>.html\`: the lessons, numbered.
- \`reference/<name>.html\`: compressed cheat sheets the user will come back to: syntax, decision guides, formulas, a glossary of terms. Once a glossary exists, every lesson uses its terms.
- \`learning-records/0001-<name>.md\`: what the user has shown they can do, misconceptions you found, and anything that should change later sessions.
- \`NOTES.md\`: how the user likes to be taught.

## First session: the mission

If \`MISSION.md\` is empty or missing, start by asking why they want to learn this and what they will apply it to. Look at the project first: their data, analysis and draft usually show what the method is for, so ask only what the files don't answer. Write the mission, and update it (with a learning record) when their goal changes. The mission is done when it names the goal, the use, and a concrete "able to do it"; then teach the first lesson in the same session.

## Sources

Ground every lesson in sources you found in this task, not in memory: the project's Library first, then the official documentation, standard textbooks and methods papers. Cite them in the lessons with links, and give each lesson one primary source to read next, the best you found.

## Lessons

A lesson teaches one tightly scoped thing in the user's **zone of proximal development**: the next step their learning records show they are ready for, tied to the mission. Keep it short enough to finish in one sitting, ending with a tangible win. Wherever possible use the user's own data or a small realistic example from their field.

Teach the knowledge needed for the skill, then practise it with a **feedback loop**: a quiz or a small task with immediate feedback, such as code they run in Scient Compute with the expected output to compare. Build lasting memory, not just in-the-moment fluency: ask the user to recall rather than reread, return to earlier material in later lessons, and mix related problems. In quizzes, make every option similar in length and vary where the right answer sits.

Make each lesson a clean, readable HTML page that prints well, linking to related lessons and reference sheets, with a shared stylesheet in the folder so the course looks consistent. End each lesson by inviting questions. A lesson is done when it covers one topic, uses the user's data or field, has a feedback loop with the expected answers, cites its sources and names the primary source to read next.

A session is done when the learning record is written and the reference sheets are updated. Reply with a link to the new lesson and what comes next.
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
  "version": "0.2.0",
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
  "version": "0.2.0",
  "category": "Workspace readiness",
  "categoryDescription": "Review and improve a workspace so people and agents can understand it and work safely.",
  "displayOrder": 20,
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
    directoryName: "scient-skill-authoring",
    defaultActive: true,
    files: Object.freeze({
      "LICENSE-upstream.txt": `references/writing-for-agents.md is adapted from "writing-for-agents" in Matt Pocock's skills (https://github.com/mattpocock/skills, commit abeeaf9), used under the MIT licence below.

MIT License

Copyright (c) 2026 Matt Pocock

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`,
      "SKILL.md": scientSkillAuthoring,
      "references/writing-for-agents.md": `# Writing for agents

How to write the text an agent follows: a skill, an instructions file, a document a skill points to.

## The description is a pointer

When agents browse or search the available skills, the name and description are what they choose from, so the wording, not the body, decides when an automatic skill is used. An explicit skill appears only when the user selects it. Put the word users actually say first ("grill", "references", "statistics"), give one trigger per distinct case the skill handles, and drop synonyms that rename the same case. Keep descriptions short. A skill that never loads can't be fixed by improving its body.

## Steps and reference

A skill holds **steps** (what the agent does, in order) and **reference** (rules and facts it consults). Put first what every run needs; move what only some runs need into a resource file, with a line saying when to read it. Keep a concept's rule, exceptions and caveats together under one heading. A body that is too long thins the agent's attention even when every line is true.

## Finish lines

End every step on a **completion criterion** the agent can check: "every number in the draft has a ledger row" beats "check the numbers". A vague finish line ("understand the data") invites stopping early. Demanding, checkable criteria ("every comment answered", "the count of references checked out of the total") drive thorough work without listing every action.

## Say what to do

Name the behaviour you want ("answer conditionally until the change is in the manuscript") rather than the one you don't. A prohibition puts the unwanted behaviour into the agent's mind. Keep "never" for hard guardrails, and pair it with the positive target.

## Leading words

Use a short, well-known term instead of a sentence: _ledger_, _frontier_, _preregistered_, _independent unit_, _tight_ loop, a check that goes _red_. The model already knows what they mean, so one word anchors a whole behaviour. Reach for an existing term before coining one.

## Prune

- **No-ops:** delete any sentence the model would obey anyway. If a word is too weak to change behaviour ("be careful"), use a stronger one rather than adding a sentence.
- **One source of truth:** say each thing once.
- **Don't copy the environment:** tool descriptions, schemas, \`--help\` output and Scient's own instructions are already visible. Write only what the agent can't look up: the unwritten convention, the reason for a choice, the trap no tool reports.
- **Remove stale lines:** text written to patch one failure in one test, provenance notes and dated remarks don't belong in the instructions.
`,
      "scient.skill.json": `{
  "apiVersion": "scient.skills/v1alpha1",
  "id": "scient.skill-authoring",
  "version": "0.2.0",
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
    directoryName: "connector-authoring",
    defaultActive: true,
    files: Object.freeze({
      "SKILL.md": connectorAuthoring,
      "references/auth-and-sessions.md": `# Credentials and sessions

For API keys and tokens, declare a sensitive string in the manifest's \`user_config\` and map it into \`server.mcp_config.env\`; that is the only home for a secret (never args, code or project files). The connector starts and lists tools without credentials, and protected handlers return \`needsSetup\`. Set \`required: true\` only when the connector is useless without the key. The user enters keys through \`scient_connector_setup\`, not chat or \`request_secret\`.

For a new API that needs a key: check startup and the setup-message path in the folder, save the connector, complete setup, then inspect a real read on the installed connector. A folder check can't accept a new key. Use \`replaceKeys\` only with evidence the key was rejected; an ordinary 403 can mean access denied or policy rather than a bad key.

For a website session, declare \`_meta["com.scientfactory.scient"].signIn.site\` as its origin; setup links an Accounts sign-in. \`scient_connector_check {folder, signIn, calls}\` tests an unsaved folder with that account; after saving, use \`connector\`. With no account yet, add one with \`scient_account_add\` (website or university sign-in). A declined or timed-out card ends setup for this turn; report it once.

The session helper receives \`SCIENT_SIGN_IN_SITE\`, private cookie-file paths and a browser user agent. Hold cookies, CSRF and session tokens in memory only, and trace where each token comes from; never copy them into the connector, logs, fixtures or results. Sign-in happens through Scient's Accounts flow, including any human-only challenge; the connector itself never posts password forms.

Detect expiry from the site's observed signed-out response; a generic 403 isn't enough. The \`SCIENT_SIGN_IN_EXPIRED\` marker makes the host sign in and replay the call, so emit it only for a read that is known safe to repeat. A write with an uncertain outcome needs a readback, not a replay. Test expiry with synthetic responses.

Bind credential-bearing requests to the intended origin. The inherited session helper strips standard authorization headers on redirects, but not custom secret headers: with custom credentials, either follow no cross-origin redirects or implement and test an explicit origin allowlist, and stop unexpected redirects before sending. The browser user agent is for compatibility, never for passing a bot check.

For OAuth-only APIs the template has no OAuth lifecycle. Use a vendor-hosted MCP connector, a supported package's OAuth flow or a service-issued personal token, and report the limitation if none fits. Password grants and stored client secrets are out of bounds.
`,
      "references/fixing.md": `# Repair an installed connector

Read the status and reproduce the failed read before editing. For local code, \`scient_connector_copy {connector}\` returns the working \`folder\` and may include \`status\`, \`lastError\`, \`problem\`, \`log\` and \`source\`; use \`source\` to find copied package code when it is present. Work in that folder, not in the app's private store.

\`scient_connector_check {folder, connector, calls}\` tests with the connector's existing credentials. If the failure doesn't reproduce, say so and keep a suspected fix apart from a demonstrated one. Read the source before replaying any call that could write.

Let the evidence choose the remedy: real entry paths for module errors; the declared .mjs or module format for import errors; folder-local dependencies; setup for missing keys; sign-in for genuine expiry; schema or parser updates for changed data. A 403 or an HTML login-like page alone doesn't prove a key expired. A bot check ends the attempt; report it.

Keep tool names, inputs, outputs and the behaviour that already worked. Done when the failing case and representative reads that already worked both pass. Save with \`{folder, connector}\` to replace that exact installed connector. A copied vendor package becomes the user's maintained copy; say so, and mention **Undo last change**.

Hosted connectors have no source to repair: use their sign-in or setup remedy, or report the service failure. Restarting or enabling the connector under repair can be part of an authorized fix, not of a check-only review. Leave other connectors as they are, and report a persistent failure rather than cycling sign-ins.
`,
      "references/local-tools.md": `# Local files, databases and programs

Take user-selected files and directories from manifest settings and paths from environment variables, so the connector works on any machine. Set \`_meta["com.scientfactory.scient"].workingDirectory: "project"\` only when the task should run in the chat's project.

Resolve requested paths under the allowed root and check containment after canonicalizing symlinks; a string-prefix check is insufficient. Read by default; writes get separate tools and destinations. Return bounded text or output paths rather than whole binary files.

Open databases read-only and bind query parameters. For a live database, go through the application's supported API; copying a locked database needs its WAL or backup semantics. Database passwords are sensitive environment settings. Check the actual Node runtime before choosing \`node:sqlite\` (absent on Node 20) or a packaged driver.

Spawn command-line programs with an executable and an argument array, not agent-built shell strings. Set a timeout, an output cap and cancellation, and check the exit code. On Windows, call a real .exe or run a Node script through \`process.execPath\`; untrusted arguments stay out of .cmd and .bat command lines. Report a missing executable and how to install it.

Use \`node:path\`, exact path case, and test paths with spaces and non-Latin names. Keep dependencies inside the connector folder. Record the runtime and OS you actually exercised; a declaration for another platform is not a passing test there.
`,
      "references/science-apis.md": `# Scholarly API coverage

Before implementing, read the service's current official documentation for endpoints, authentication, rate limits and paging, and record the URL, date and tested endpoint in the connector README. Use the response's rate-limit headers, timeouts and bounded backoff; the budget is shared across the user's programs. Treat quotas in old examples as history, not guarantees.

- [OpenAlex](https://docs.openalex.org/): offset paging stops at 10,000 results, so \`has_more: false\` there doesn't mean the search is complete; the template reports \`truncated\` with a reason. Check the current authentication and paging rules (cursor paging may need an API key). For a complete search, implement documented cursor paging or disjoint partitions and reconcile totals, and disclose unfinished work. Author lists and abstracts can also be cut.
- [NCBI E-utilities](https://www.ncbi.nlm.nih.gov/books/NBK25501/): PubMed ESearch exposes only the first 10,000 IDs, and \`retstart\` or history alone doesn't get past that. Use NCBI's supported large-search or bulk route, or validated non-overlapping queries; keep raw counts and deduplicate overlaps. Verify the cap for each database.
- [Crossref](https://www.crossref.org/documentation/retrieve-metadata/rest-api/): DOI metadata is not full text; follow its cursor and rate-limit rules.
- [arXiv](https://info.arxiv.org/help/api/user-manual.html): keep the identifier version, parse Atom, and pace calls to its shared limits.
- [Semantic Scholar](https://api.semanticscholar.org/api-docs/): ranked search and bulk search differ in coverage and pagination; choose for the task.
- [ClinicalTrials.gov](https://clinicaltrials.gov/data-api/api): trial records are not publications; keep the registry ID, update date and page token.
- [Zotero](https://www.zotero.org/support/dev/web_api/v3/basics): keep library and item IDs, versions and next-page links, and back off when asked; the local and web APIs differ in capabilities.

Every result states its source, stable IDs, coverage, pages completed and any cap or omitted fields. An HTTP 200 or a search total doesn't prove all records came back. Resolve conflicting identifiers before merging works.
`,
      "references/study-a-website.md": `# Study a website without a documented API

Work within the user's requested service and account. Look for official APIs, vendor connectors, exports and feeds before reproducing browser requests. Respect the site's terms, and report a prohibition or an unclear access boundary. Bot protection or a human-only challenge ends the attempt.

Watch the real task with two different inputs. Use \`preview_network\` request IDs to inspect the responses that carry data, and \`preview_evaluate\` only to read configuration or replay requests that clearly only read. A POST search can read and a GET can change state, so replay only what you know is safe.

Trace every non-input value to a page, response or cookie, and hold CSRF and session values in memory. Notes and code get endpoints and field names only; HARs, raw page dumps, cookie exports, request captures and private payloads stay out of the project. A masking tool doesn't make private values copyable.

Compare the reading requests with what the page shows: counts, dates and time zones, identifiers, non-Latin names and an empty case. Open a next page and work out its cursor or offset. Implement only fields you have observed or seen documented. Learn the signed-out response shape without deliberately ending the user's session.

Test outside the browser with a folder check and an Accounts sign-in (see \`references/auth-and-sessions.md\`); the connector itself never posts login forms. Write a small endpoint map in its README: inputs, response shape, token origins without values, expiry signals, the date, and which behaviour is confirmed versus inferred. If only in-browser execution works, report the standalone connector as blocked.
`,
      "references/testing.md": `# Prove a connector works

Before saving, check startup, the listed schemas and their agreement with the manifest. Startup must survive a missing key; for a newly required key this is the pre-save check, and setup and real authenticated calls follow the save.

Give \`scient_connector_check\` calls as \`{tool, arguments}\`, at most ten per check. \`ok: true\` proves only transport and startup. Read each \`isError\`, result text, \`missing\`, error and log; a clean setup error for absent credentials is not a data read.

Test the real task, a next page with different records, an empty result and invalid input. Include the largest realistic result and a cap boundary, and verify counts, dates and time zones, non-Latin names, optional fields, stable IDs and explicit truncation. Spot-check returned fields against their source. Keep calls few and read-only, unless the user authorized a specific write on chosen data.

For sessions, test linked and unlinked reads and the observed signed-out or forbidden shapes. Use synthetic credentials and responses for expiry replay, timeouts, custom-header redirects and secret-disclosure checks. Test idempotency on synthetic responses, never by repeating a live write; a write's unknown outcome stays unknown until independently read back.

After save and setup, make one installed read with \`connector\`; the folder alone doesn't prove installed paths and credentials. Keep two or three task questions and their checked answers in the connector README. A fresh-agent evaluation is optional and happens only on request; claim it only after running it.

Done when the report gives saved, configured and working status separately, one inspected real result, the calls tested, remaining caps, write paths left untested, and the runtime and host actually exercised. Node portability alone doesn't qualify Windows, Linux, or Intel and Apple Silicon Macs. State any account or service blockers. Tell the user to open the connector's page in Extensions and choose **Remove** to remove it; after a repair, mention **Undo last change**.
`,
      "references/tool-design.md": `# Design tools around tasks

Build a few tools that return the user's answers, not a catalogue of endpoints. During repairs keep established names, arguments and result fields. Put the task, useful distinctions and limits in the tool descriptions.

Use strict object schemas, bounded strings and arrays, sensible defaults and enums, and keep manifest tools in step with the runtime listing. Return readable names alongside stable IDs, with enough provenance to check identity and version. Dates are ISO-formatted with the source time zone. Results match \`outputSchema\`, and a missing field is distinct from zero.

For lists, return the total when known, the items returned, the next page or cursor, and truncation or cap information. The last accessible page isn't necessarily the end of the dataset. Pass the service's cursor through unchanged and keep the query parameters. Any cut to authors, abstracts or searches is reported, never hidden behind a claim of completeness.

Return actionable \`ToolError\` messages built from allowlisted status and error codes, keeping arbitrary service bodies, exceptions and request values out of errors and logs. \`safeUrl\` masks only recognised query names; it is not a general secret scrubber. The template helpers omit response bodies; keep it that way.

Separate read tools from write tools and set their annotations honestly. The HTTP method alone doesn't show a call is read-only: a search POST can read and a GET can mutate. For consequential writes, offer a preview where the service supports one. Existing authorization for the exact action is enough; ask only about an unapproved change.

After an expiry, timeout or uncertain response to a write, read back its effect instead of retrying; if the outcome can't be established, report it as unknown. The host may replay a request after the sign-in-expired marker whatever the tool's annotations, so emit that marker only where no write could have committed; the template MCP helper emits it only for tools marked read-only. Helpers can't add idempotency the service doesn't guarantee.
`,
      "scient.skill.json": `{
  "apiVersion": "scient.skills/v1alpha1",
  "id": "scient.connector-authoring",
  "version": "0.2.0",
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
      "templates/README.md": `# {{DISPLAY_NAME}}

A connector for Scient: a small program that gives agents tools for one service. As it
comes, it contains an OpenAlex example. Verify current API access with a real read before
calling it working. Change it into the connector you need.

It needs nothing installed. Scient runs it on its own copy of Node, on macOS, Windows and
Linux. It also runs on Node 20 or newer, and in Claude Desktop when exported as \`.mcpb\`.

## Files

| File            | What it is                                                                              |
| --------------- | --------------------------------------------------------------------------------------- |
| \`manifest.json\` | Name, how to start it, settings and keys it asks for, its tools. MCP Bundle format.     |
| \`server.mjs\`    | The tools. This is the file you change.                                                 |
| \`mcp.mjs\`       | The MCP side: messages over stdin and stdout, input checks, errors. Usually left as is. |
| \`http.mjs\`      | Polite web requests: pacing, timeouts, read retries, omitted response bodies.           |
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
\`SCIENT_SIGN_IN_EXPIRED\` error when the site sends them to its sign-in page. For explicitly read-only tools, Scient then signs in
again and retries. The included MCP helper (\`mcp.mjs\`) suppresses this replay marker for other tools;
check an uncertain write outcome before retrying. The program never sees the password.

### Libraries

Zero dependencies is best: Scient cannot count on npm being on the user's computer. When a
library is truly needed and npm is there, install it inside this folder (\`npm install\` here,
with a \`package.json\` that has \`"type": "module"\`), so \`node_modules\` travels with the
connector. The official MCP SDK (\`@modelcontextprotocol/sdk\`) may replace \`mcp.mjs\` then.

## Run it by hand

\`node server.mjs\` waits for MCP messages on stdin and logs to stderr. Scient's check
(\`scient_connector_check\`) is the real test.

## Helper limits

These helpers omit arbitrary response bodies and unexpected exception details from errors.
ToolError strings and deliberate logs must still be written without secrets. \`safeUrl\` masks
only recognized parameter names. Do not treat it as a general redactor.

\`search_works\` is offset browsing, not a complete-export tool. At its boundary it returns
\`truncated: true\` and a reason even when \`has_more\` is false. \`get_work\` still caps authors
at 25 and abstracts at 4,000 characters; inspect the omission fields/markers.

Do not use custom secret headers across redirects with the inherited session helper. It only
strips standard authorization headers; an explicit permitted-origin rule needs separate work.
The app's host can replay expiry markers. Only tools honestly marked read-only may emit one;
the included MCP helper blocks it for the other tools. This is not an idempotency guarantee.

Check OpenAlex's current authentication and quota documentation before relying on the
example in a production connector.
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
          : "network error";
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
        : response.status === 401
          ? \`\${what} refused authentication (401). Check setup; replace a key only if it was rejected.\`
          : response.status === 403
            ? \`\${what} denied access (403). Check account permissions or service policy.\`
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

/** Response bodies may contain credentials or private data; never put them in errors. */
export const snippet = () => "[response body omitted]";
`,
      "templates/manifest.json": `{
  "manifest_version": "0.3",
  "name": "{{NAME}}",
  "display_name": "{{DISPLAY_NAME}}",
  "version": "0.1.1",
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
      if (error instanceof ToolError) {
        if (
          error.message.trimStart().startsWith(SIGN_IN_EXPIRED) &&
          tool.annotations?.readOnlyHint !== true
        ) {
          return errorResult(
            "The session ended during a call that may change data. Its outcome is unknown. " +
              "Check whether it took effect before retrying; sign in separately.",
          );
        }
        return errorResult(error.message);
      }
      log(\`\${tool.name} failed unexpectedly; exception details omitted.\`);
      return errorResult(
        \`\${tool.name} failed unexpectedly. Private exception details were omitted. \` +
          "Check the request and connector implementation.",
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
      log(\`\${method} failed; exception details omitted.\`);
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
  process.on("unhandledRejection", () => log("Unhandled rejection; details omitted."));
  process.on("uncaughtException", () => log("Uncaught exception; details omitted."));
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

// Conservative pacing; check current OpenAlex quota and authentication requirements.
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
    "link). Use get_work for the abstract and up to 25 authors. Check more_authors for omissions. Results come in pages: pass " +
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
      truncated: {
        type: "boolean",
        description: "More matches exist beyond this tool's paging cap.",
      },
      truncation_reason: { type: "string" },
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
    const hasMore = page * limit < total && (page + 1) * limit <= 10_000;
    const truncated = page * limit < total && !hasMore;
    return compact({
      total,
      page,
      has_more: hasMore,
      truncated,
      truncation_reason: truncated
        ? "Offset paging stops at 10,000; narrow the query or implement cursor paging for complete coverage."
        : undefined,
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
    "Get one work from OpenAlex by OpenAlex id (W…) or DOI: title, authors with their " +
    "institutions (up to 25 authors; more_authors counts omitted names), year, venue, abstract, topic, citation counts and free full-text link.",
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
          throw signInExpired(site, "sent to the sign-in page");
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
  Object.freeze({
    directoryName: "pdf-authoring",
    defaultActive: true,
    files: Object.freeze({
      "SKILL.md": pdfAuthoring,
      "references/html-print.md": `# HTML for print

Use HTML for a PDF only when it is the requested or established source. Keep layout in local CSS and assets at project-relative paths with exact case: the controlled renderer blocks remote resources, so fonts, scripts, styles and images must be local.

Set the paper size and margins with \`@page\` and use print CSS rather than a fixed browser viewport. Let long tables break and repeat their headers. Keep captions with figures, and reserve \`break-inside: avoid\` for small blocks, not whole long sections or tables. Remove fixed heights and overflow clipping that hide print content.

Have equations and graphics finished in the saved source before building: rendered math rather than a remote MathJax script, and content that is present without animation frames, scrolling or lazy loading. Prefer local SVG for diagrams and vector plots; use image resolution suited to the final print size and venue.

Check page breaks, dynamic content and missing assets on the returned PDF; a browser screenshot can't show print pagination. If the connected desktop renderer fails, keep the source and report the exact render or publication failure; opening the HTML and choosing Export PDF is a fallback for the user, not a completed export.
`,
      "references/visual-check.md": `# Render and inspect the PDF

Look at the final saved PDF, not a stale build or an HTML screenshot. Put page images in a new temporary folder outside the project.

If \`pdftoppm\` (Poppler) is installed: \`pdftoppm -r 150 -png final.pdf <new-folder>/page\`.

Otherwise use PyMuPDF, from an existing environment that has it or a disposable one; Scient's default Python has only \`pypdf\`, which cannot render pages. Install into the disposable environment, never into the user's or Scient's own Python:

\`\`\`sh
# macOS or Linux
python3 -m venv "\${TMPDIR:-/tmp}/pdf-review-env"
"\${TMPDIR:-/tmp}/pdf-review-env/bin/python" -m pip install pymupdf
"\${TMPDIR:-/tmp}/pdf-review-env/bin/python" render_pdf.py final.pdf <new-folder> --pages 1,2,5
\`\`\`

\`\`\`powershell
# Windows
py -3 -m venv "$env:TEMP\\pdf-review-env"
& "$env:TEMP\\pdf-review-env\\Scripts\\python.exe" -m pip install pymupdf
& "$env:TEMP\\pdf-review-env\\Scripts\\python.exe" render_pdf.py final.pdf <new-folder> --pages 1,2,5
\`\`\`

\`render_pdf.py\` is this skill's \`scripts/render_pdf.py\` (read it with \`scient_skill_read_resource\` and save it in the temporary folder). Omit \`--pages\` for every page; the output folder must not exist yet, so use a new one after each rebuild. It prints the page count and the image paths.

Open the images with your image-view tool and actually look at them. If you can't render or view them, say that visual inspection was not performed and why. Page images don't show live links, font embedding or tags; check those in the PDF structure when they are required.
`,
      "scient.skill.json": `{
  "apiVersion": "scient.skills/v1alpha1",
  "id": "scient.pdf-authoring",
  "version": "0.4.0",
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
      "scripts/render_pdf.py": `"""Render selected PDF pages without changing the PDF; output directory must be new."""
import argparse
import json
from pathlib import Path

import pymupdf


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("pdf", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--pages", help="Comma-separated 1-based PDF page numbers; default all")
    args = parser.parse_args()
    with pymupdf.open(args.pdf) as document:
        if not document.is_pdf or document.needs_pass:
            parser.error("Use an unlocked PDF.")
        try:
            pages = sorted(set(int(item) for item in args.pages.split(","))) if args.pages else list(range(1, document.page_count + 1))
        except ValueError:
            parser.error("--pages needs comma-separated integers.")
        if not pages or any(page < 1 or page > document.page_count for page in pages):
            parser.error(f"Pages must lie between 1 and {document.page_count}.")
        args.output.mkdir(parents=True, exist_ok=False)
        paths = []
        for number in pages:
            output = args.output / f"page-{number:04d}.png"
            document[number - 1].get_pixmap(dpi=150, alpha=False).save(output)
            paths.append(str(output.resolve()))
        print(json.dumps({"pageCount": document.page_count, "renderedPages": pages, "images": paths}))


if __name__ == "__main__":
    main()
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
  "version": "0.4.0",
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
  "version": "0.2.0",
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
  "version": "0.3.0",
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
      "references/methods.md": `# Beyond screening

Do only the phases the user requested, and record protocol amendments before implementing choices. The review tools store searches and selection; extraction, bias and certainty assessments live in project files.

- **Extraction:** keep a project table with report ID, study ID, population, design, comparator, outcomes, time points, estimates, uncertainty, adjustment, analysis sample and missing data, with a full-text locator per value. Pilot the form and independently check critical numbers. Mark each value reported, derived or missing.
- **Bias:** choose the framework and version that fit the design and question, such as RoB 2 for randomized trials, ROBINS-I for nonrandomized interventions and QUADAS for diagnostic accuracy. These are revised from time to time, so confirm the current edition and the protocol's choice on the official site. Link restricted checklists rather than copying them, and base each domain judgement on the full text, with the evidence and the reviewer's adjudication recorded.
- **Synthesis:** use Scient Compute for calculations and figures. Before pooling, check outcome and estimand, units, time point, adjustment and study independence; count shared controls and multiple reports of one study once. Choose the model and the handling of dependence with the researcher, and report heterogeneity and sensitivity analyses. When pooling isn't justified, write a structured narrative synthesis; for scoping reviews, chart the evidence against the question.
- **Certainty:** when requested, assess the body of evidence per outcome with GRADE or the protocol's framework, documenting reasons and reviewer decisions. Certainty rests on all its domains: risk of bias is only one, and significance or study count is none.

Report which phases are complete, independently checked or still agent drafts. A complete review also reports its methods, automation and deviations; a PRISMA diagram alone doesn't supply them.

## Library duplicates shown from a review snapshot

A record with \`libraryMatch\` disagrees with a Library copy. Link it (\`scient_sources_organize\`, \`link-pin\`) only when the user confirms it is the same work; otherwise record \`keep-pin-separate\`, which holds even if the copies later stop matching, until \`clear-pin-separate\`.

## Sources

[PRISMA 2020](https://www.prisma-statement.org/prisma-2020), [PRISMA-S](https://www.prisma-statement.org/prisma-search), [PRISMA-ScR](https://www.prisma-statement.org/scoping), [Cochrane Handbook](https://www.cochrane.org/authors/handbooks-and-manuals/handbook/current), [Cochrane rapid reviews](https://methods.cochrane.org/rapidreviews/cochrane-rr-methods), [risk-of-bias tools](https://www.riskofbias.info/), [QUADAS](https://www.quadas.info/) and [GRADE](https://www.gradeworkinggroup.org/). Some instruments have restricted licences; check before reproducing items.
`,
      "scient.skill.json": `{
  "apiVersion": "scient.skills/v1alpha1",
  "id": "scient.systematic-review",
  "version": "0.2.0",
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
  Object.freeze({
    directoryName: "compare-sources",
    defaultActive: true,
    files: Object.freeze({
      "SKILL.md": compareSources,
      "scient.skill.json": `{
  "apiVersion": "scient.skills/v1alpha1",
  "id": "scient.compare-sources",
  "version": "0.2.0",
  "category": "Research",
  "categoryDescription": "Check, find and cite the literature.",
  "displayOrder": 100,
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
    directoryName: "statistics-review",
    defaultActive: true,
    files: Object.freeze({
      "SKILL.md": statisticsReview,
      "scient.skill.json": `{
  "apiVersion": "scient.skills/v1alpha1",
  "id": "scient.statistics-review",
  "version": "0.1.0",
  "category": "Analysis",
  "categoryDescription": "Check research methods, results and manuscript reporting.",
  "displayOrder": 110,
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
    directoryName: "check-reported-numbers",
    defaultActive: true,
    files: Object.freeze({
      "SKILL.md": checkReportedNumbers,
      "scient.skill.json": `{
  "apiVersion": "scient.skills/v1alpha1",
  "id": "scient.check-reported-numbers",
  "version": "0.1.0",
  "category": "Analysis",
  "categoryDescription": "Check research methods, results and manuscript reporting.",
  "displayOrder": 120,
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
    directoryName: "reviewer-response",
    defaultActive: true,
    files: Object.freeze({
      "SKILL.md": reviewerResponse,
      "scient.skill.json": `{
  "apiVersion": "scient.skills/v1alpha1",
  "id": "scient.reviewer-response",
  "version": "0.1.0",
  "category": "Analysis",
  "categoryDescription": "Check research methods, results and manuscript reporting.",
  "displayOrder": 130,
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
    directoryName: "ml-evaluation-audit",
    defaultActive: true,
    files: Object.freeze({
      "SKILL.md": mlEvaluationAudit,
      "scient.skill.json": `{
  "apiVersion": "scient.skills/v1alpha1",
  "id": "scient.ml-evaluation-audit",
  "version": "0.1.0",
  "category": "Analysis",
  "categoryDescription": "Check research methods, results and manuscript reporting.",
  "displayOrder": 140,
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
    directoryName: "reporting-guideline-check",
    defaultActive: true,
    files: Object.freeze({
      "SKILL.md": reportingGuidelineCheck,
      "scient.skill.json": `{
  "apiVersion": "scient.skills/v1alpha1",
  "id": "scient.reporting-guideline-check",
  "version": "0.1.0",
  "category": "Analysis",
  "categoryDescription": "Check research methods, results and manuscript reporting.",
  "displayOrder": 150,
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
    directoryName: "diagnose-analysis",
    defaultActive: true,
    files: Object.freeze({
      "LICENSE-upstream.txt": `This skill is adapted from "diagnosing-bugs" in Matt Pocock's skills (https://github.com/mattpocock/skills, commit abeeaf9), used under the MIT licence below.

MIT License

Copyright (c) 2026 Matt Pocock

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`,
      "SKILL.md": diagnoseAnalysis,
      "scient.skill.json": `{
  "apiVersion": "scient.skills/v1alpha1",
  "id": "scient.diagnose-analysis",
  "version": "0.1.0",
  "category": "Analysis",
  "categoryDescription": "Check research methods, results and manuscript reporting.",
  "displayOrder": 160,
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
    directoryName: "grill-me",
    defaultActive: true,
    files: Object.freeze({
      "LICENSE-upstream.txt": `This skill is adapted from "grilling" in Matt Pocock's skills (https://github.com/mattpocock/skills, commit abeeaf9), used under the MIT licence below.

MIT License

Copyright (c) 2026 Matt Pocock

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`,
      "SKILL.md": grillMe,
      "scient.skill.json": `{
  "apiVersion": "scient.skills/v1alpha1",
  "id": "scient.grill-me",
  "version": "0.1.0",
  "category": "Planning and learning",
  "categoryDescription": "Think a plan through, get expert input and learn new methods.",
  "displayOrder": 170,
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
    directoryName: "to-questionnaire",
    defaultActive: true,
    files: Object.freeze({
      "LICENSE-upstream.txt": `This skill is adapted from "to-questionnaire" in Matt Pocock's skills (https://github.com/mattpocock/skills, commit abeeaf9), used under the MIT licence below.

MIT License

Copyright (c) 2026 Matt Pocock

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`,
      "SKILL.md": toQuestionnaire,
      "scient.skill.json": `{
  "apiVersion": "scient.skills/v1alpha1",
  "id": "scient.to-questionnaire",
  "version": "0.1.0",
  "category": "Planning and learning",
  "categoryDescription": "Think a plan through, get expert input and learn new methods.",
  "displayOrder": 180,
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
    directoryName: "teach",
    defaultActive: true,
    files: Object.freeze({
      "LICENSE-upstream.txt": `This skill is adapted from "teach" in Matt Pocock's skills (https://github.com/mattpocock/skills, commit abeeaf9), used under the MIT licence below.

MIT License

Copyright (c) 2026 Matt Pocock

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`,
      "SKILL.md": teach,
      "scient.skill.json": `{
  "apiVersion": "scient.skills/v1alpha1",
  "id": "scient.teach",
  "version": "0.1.0",
  "category": "Planning and learning",
  "categoryDescription": "Think a plan through, get expert input and learn new methods.",
  "displayOrder": 190,
  "supportedScopes": ["user"],
  "defaultInvocationPolicy": "explicit",
  "origin": {
    "kind": "scient"
  }
}
`,
    }),
  }),
]);
