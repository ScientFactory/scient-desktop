# Library and PDF import

The Library is your managed collection of scientific references, one for all
your projects. Use it for papers, books, datasets, protocols, guidelines, and
other works that you want to identify, review, cite, or make available to the AI
as research evidence. Each source has structured bibliographic metadata and can
include an imported PDF. Each project keeps the list of sources it uses.

A source is different from an ordinary project file. Notes, tables, code,
manuscripts, and PDFs can exist anywhere in the project as working material;
they do not automatically become bibliographic sources. A web page opened in
the Browser or information mentioned in chat is also not added automatically.
Import or create a source when you want it to become part of your explicit
reference library.

## Open the Library

Open a project, then choose **Library** from the right-panel add menu. Keep the
Library beside the conversation or expand it when you need more room. If the
folder is not yet set up as a Scient project, the Library offers the same optional
project setup used by **Add project**.

Use **This project / All Library** above the list to choose what to browse.
The choice stays available in an empty project and when you can only read.
An empty project says **No sources in this project**; **Choose from Library**
opens existing papers so you can **Add to project**. Collections in **Filter**
only narrow that scope. Rows show authors, year, unread status and real
warnings; hover a row or open its details for when and how it was added.

Source records and imported PDFs are stored in your personal Library on the
computer that runs the project, in the Scient data folder (`scient/library/`
under `~/.scient-next/userdata/` for the installed app). The project keeps the
list of sources it uses, with their citation keys and project notes, in
`.scient/library/pins.json`, so it travels with the project and with git. A
copy of each source's citation details is kept there too (type, title, authors
with their roles, full date, journal or book, publisher, volume, issue, pages,
URL, language and tags), so a collaborator, or a computer without your Library,
builds the same bibliography. When that computer's Library has the paper with
fewer details, the project's details fill the gaps; a detail someone removed on
purpose by editing the paper stays removed.

**What a project folder holds.** Pins, project notes and their earlier versions
(`.scient/library/note-history/`), systematic reviews with a copy of each named
record (`.scient/library/reviews/`), the managed bibliography files, and, after
a move, a sealed copy of the sources from before it. Scient also keeps an empty
lock file there, `.scient/library/pins.lock`, so two Scient windows or servers
using the folder never save its pins at the same moment; when
`.scient/library/.gitignore` does not exist it writes one with the single line
`/pins.lock`, so git leaves out that lock and nothing else. An ignore file that
is already there is never changed. PDFs added later, their
highlights, personal notes and collections are in your Library, not in the
folder. To give someone, or another computer, the project as it is now, save a
[project package](#project-packages).

### This project and All Library

The Library panel starts with this project's sources. Choose **All Library**
above the list to browse papers from every project. Use
**Add to project** to bring a paper from your Library into this project, and
**Remove from this project** to take it out; the paper stays in your Library
and in other projects. Importing or adding by identifier while **All Library** is shown
adds the papers to your Library only; the import's summary offers **Add to
project**.

Sort the list by **Last added**, **Publication year**, **Title** or **Author**
with the sort button beside the filter button.

A paper this project cites that is in the Trash says "Not in this Library":
the project keeps its citation details, so it can still be cited, but it has no
PDF here and nothing to move to the Trash. Removing it from the project asks
first, because it cannot be added back from this computer. A paper the project
cites that this computer's Library has never had, for example one a
collaborator added, is copied into your Library from those citation details,
without a PDF or abstract, the next time this project changes the Library.

### Two notes

Each paper has a **Note for this project**, for why you cite it here, kept with
the project, and **My note**, which follows the paper into every project and is
not saved in any project folder. Agents read and write My note too. A paper
that is not in this project has only My note.

Notes save against the note you read. Changing metadata or attaching a PDF does
not block a note save, including a save still finishing after you leave the editor.
A note for this project is never overwritten by a change made elsewhere. If
another window, another Scient on this computer or an agent changed it after
you started typing, the note shows **Saved elsewhere** with that text next to
yours: choose **Keep mine** or **Use saved**. Keep mine saves once against the
note shown under Saved elsewhere. If it changed again, both texts stay visible
for another choice; Scient does not keep retrying the refused save. **Earlier versions** next to the
heading lists the first note the project kept (however it was written) and the
last 20 versions, with who saved each and when (typing in one sitting counts as
one version); choosing one restores it as a new change, never in place of the
version before it. The versions travel with the project. After two papers this
project cites were merged, the merged paper keeps both citation keys and each
key keeps its own note: **Note for** above the note picks the key whose note
and earlier versions you see and restore. Two copies of the
folder synced by Dropbox or git are not coordinated: if both change a note, the
sync tool decides. Scient keeps the other text only if it still sees it in the
project's files the next time it saves the note.

### Reading and stars

Unread papers have a small dot before the title. Mark a paper read or unread,
or star it, in its details, from its row, or for many at once with **Mark**
after selecting them. Opening a paper does not mark it read. **Unread** and
**Starred** in the filter menu show only those papers.

### Moving a project's sources into your Library

A project made with an older version of Scient kept its own sources in
`.scient/sources/`. The first time you change the Library in such a project,
Scient moves its sources and PDFs into your personal Library, and the project
keeps the list of papers it uses. Scient also moves projects in the background
a few minutes after it starts. Until then the Library shows "The Library is
waiting to move out of this project." While the move runs, the Library shows a
line with its progress. A change you make during a large move may ask you to
try again when it has finished. When the move is done, a short line confirms
that the project's earlier sources are kept in the project. **Show locations**
expands the Library and archive paths, merge results and the limit on older
bulk-edit Undo history. **Review**, when shown there, opens the merges that
kept different values. Dismiss the line when you have read it. If a PDF from
the project was still open, the expanded details also say how many files will
be removed from the project later. If the move fails, the line
says why; Scient tries again with the next change to the Library or its next
background pass, and **Check again** shows the latest state. If the project's `.scient` folder is tracked in git, commit the
change: the project's live sources then no longer hold PDFs, though the copy
from before the move (below) still does until you delete it.

If you put a paper in the Trash during an interrupted move, resuming keeps it
there and finishes copying its PDFs, full text and highlights. **Restore** brings
them back with the paper. A paper deleted for good stays deleted.

**The copy from before the move.** Before the move deletes anything from
`.scient/sources`, it saves a sealed copy of the project's sources, with their
earlier revisions, the trash, collections, reviews, the exact PDFs and their
highlights, including highlights on papers excluded from this Library because
they were deleted for good, in
`.scient/library/retained-before-library/<move>/`, with a `README.md` and a
`manifest.json` listing every file and its checksum. Scient never reads it on
its own. Choose **⋯** > **Recover** > **Recover sources from before the move**,
or ask an agent, to bring it back into the project, on this computer or any
other; the next change then moves it
into that computer's Library. Scient checks every file and path in the copy
first and refuses one that was changed or names a place outside it. A restore
that stops partway finishes the next time it is asked for, or before the next
move. If it cannot finish because the copy has changed or is gone, the next
move waits and its line says why: put the copy back and restore again, or ask
an agent to abandon the unfinished restore, after which the move takes in what
was already put back. A restore puts each highlight file back only where no
file is, by a method that cannot replace one; on a drive that does not support
it (some network and older removable drives), the restore stops there and says
so, keeping its progress: run it again from a folder on a drive that does, or
abandon it. Restoring joins the old sources to what the project has now: current pins
and notes stay as they are, nothing is rolled back. The copy costs disk space (the PDFs are stored
twice) and, if the folder is tracked in git, adds to the repository unless you
leave it out. Scient adds no ignore rule and never deletes it; deleting the
folder yourself is safe once you no longer need it. It shows the project as it
was at the move, not later changes: for those, save a project package.

**Recovery.** Open **⋯** > **Recover** for **Recover sources from before the
move**, **Keep this project's sources in its folder**, or **Save a current
package**. Recovering the pre-move copy joins current notes and pins rather
than rolling them back; it works from a copied project without the original computer.

**Moving back.** Choose **Keep this project's sources in its folder** under
**Recover**. The sources and their PDFs are copied
back into the project's folder. This project's notes and its reviews come back
too. The papers also stay in your personal Library, because other projects may
use them. For a large Library this can take a while; the Library shows its
progress. After a move back the project keeps its own Library, and Scient does
not move it again on its own.

**A review with another version.** If a copy of the project (for example one
pulled from git) changed a systematic review differently, the review shows
"This review has another version from a copy of this project." Open it to see
both versions side by side: who changed each one last, and their searches,
records and decisions. Choose **Keep this version**, **Use the other**, or
**Combine**. Combine keeps the searches and records of both versions and
reopens any record the two decided differently, so you can decide it again. The
version you do not keep is stored aside, not deleted. After Combine, a short
report on the review lists what is left to decide until you dismiss it.

### Possible duplicates

When the same paper reaches your Library twice, for example from two projects,
Scient merges the copies on its own only when it is sure. If one merge in a
group fails, copies that were joined to the group only through that one wait
for the next pass. They must share a
DOI, PubMed, PMC, arXiv, OpenAlex or Semantic Scholar ID, the same Zotero
item, or the same PDF, and also have the same title (ignoring case, spacing
and punctuation) and the same known type. Every copy in a merge must be joined
to another this way and agree with all the others. Copies whose identifiers
disagree are never merged on their own, and neither is a copy that matches two
others that disagree with each other, nor two copies joined only through a
third that disagrees with both.

When you add a paper, import from Zotero or a reference file, add a PDF, or an
agent adds one, Scient checks it against the copies already in your Library.
Here, what the new paper does not say counts neither way. It is taken for a
copy that shares its identifier, Zotero item or PDF (for a book, its ISBN)
unless something it does say disagrees: another title, another known type (a
chapter is not its book, an article is not a dataset), another arXiv version,
or another identifier. A paper added again the same way gets the same check,
so a registry that has since corrected its title gives a new copy. When it
says too little to tell two copies that disagree with each other apart (a bare
DOI that two copies with different titles carry), Scient does not pick one. If
it disagrees, matches more than one copy, or the copy is one whose merge with it
you undid or whose merge details cannot be read, it is added as its own copy
and the pair is listed below with the reason, so a wrong DOI on one paper never
makes another paper stand in for it. The preview before a Zotero or PDF import
gives the same answer the import will.

Scient lists a pair for you to decide instead when:

- they share an identifier, a Zotero item or a PDF, but the titles or types
  differ, one has no title or no known type, one is a preprint and the other
  the published paper, they are different arXiv versions, other identifiers
  differ, or you undid their merge. The pair says why, for example "Same
  identifier, but the titles differ." or "Same PDF, but the titles differ."
  Chapters of one book that carry the book's PDF are not listed for sharing it,
  and neither is a chapter with its book.
- they have the same title, first author and year.
- they share an ISBN or ISSN and have the same title, or both are whole books
  with the same ISBN, and no identifiers disagree. Chapters of one book and
  articles of one journal are not listed just for sharing it.

Open them with **Possible duplicates** in the **⋯** menu. Each pair
shows both copies side by side, with what differs between them stressed.
Choose **Keep this one** on the copy to keep and **Merge**; Scient suggests
which to keep. Where the two have different values, the kept copy's value
stays. Projects that use either copy keep citing it. **Not duplicates** takes
the pair off the list for good. Both have **Undo**. A long list shows part at
a time; **Show more** at its end shows the next part. If the list changed in
the meantime, it starts again from the top, so nothing is skipped.

The **Merged** tab lists merges you can still undo under **Can undo**,
including those Scient made when a project moved into your Library, with the
details that differed. **All** lists every merge, also those you undid and
those that can no longer be undone, with the reason. **Undo** brings the other
copy back; changes you made to the kept copy after the merge stay, and Scient
says which. Scient never merges those two again on its own, not even when
another project moves in or when Undo stopped halfway; the pair is listed
again, and you can still merge them or mark them as not duplicates. After a
project moves into your Library, its summary line offers **Review** when some
merges kept different values.

Scient keeps the details of every merge for good, because they hold these
Undo decisions. If one of them cannot be read (for example a damaged file
from a sync), the screen says so, and Scient merges none of the copies it
names on its own until the file is repaired. If not even their names can be
read, it merges nothing on its own.

**A project's paper and your Library copy.** When a project copied from
someone else names a paper, as a citation or as a record in one of its reviews,
and your Library has a copy that disagrees with it, for example the same DOI on
a paper with another title, or more than one copy that matches, Scient does not
link them on its own. The project shows the paper as the project recorded it,
without your copy's PDF. Its details show **Library copy**: which copies Scient
compared it with and why it did not link them. A review's record opens its
details from the review, and it does not become a citation. Choose **Link to
this Library copy** when it is the same paper: the project then uses that copy
and its PDF, and keeps the paper's citation key, its note for this project and
its place in reviews. **Undo** in the confirmation goes back. Choose **Keep
separate** when it is not: Scient never links the paper to those copies on its
own, even if their details change later to agree, until you choose **Ask
again** or link it yourself. If those copies change so that they no longer
match at all, the paper still shows as kept separate, with **Ask again**, and
Scient does not add a copy of its own for it to your Library until you ask
again. Undoing a link brings back a **Keep separate** you
had chosen before it.

## Import from Zotero

1. Open Zotero on the same computer as the selected Scient environment, or
   save a Zotero API key in **Accounts** (see below).
2. In the **Library**, choose **Import sources → Import from Zotero**.
3. Select **My Library**, one of your Zotero groups, or a specific collection.
4. Select individual references, import the selected collection, or import the
   complete library.

Scient copies each reference's metadata, tags, child notes (as **My note**)
and every PDF attachment into your Library, and adds the references to this
project unless **All** is shown. A citation key the item
already has, from Zotero or Better BibTeX, is kept. Each source also joins a
Library collection named after each Zotero collection it is in. The Library
keeps one level of nesting, so **Chapter 2** inside **Thesis** stays inside it;
a collection nested deeper joins its ancestor one level down, and the import
result says which ones did. The original Zotero records and attachments are
never changed by an import.

Zotero must be open in the same environment where the project runs. For a
remote project, that means Zotero must run on the remote computer, not only on
the computer displaying Scient. If Zotero blocks local access, enable **Allow
other applications on this computer to communicate with Zotero** in Zotero's
advanced settings and try again.

### Zotero groups

The library menu in the import picker lists the group libraries you can read
after **My Library**: the groups Zotero on this computer syncs, or on zotero.org
the groups your key may read (allow group access when you create the key). A
key that reads groups but not your personal library works too; the picker then
opens on a group and leaves **My Library** out.
Choose a group to browse its collections and import from it; sources still go
into the current project. A group item and an item of yours stay two separate
sources, even when Zotero gives them the same key, and **Refresh from Zotero**
reads each source again from the library it came from.

### Your library on zotero.org

When Zotero is not open on that computer, Scient can use your library on
zotero.org instead. Create a key at zotero.org (**Settings → Security →
Create new private key**), allow it to read your library and files, and save
it in **Accounts** as the Zotero key. Allow write access too if you want to use
**Send to Zotero**. Scient keeps the key in Accounts and sends it only to
zotero.org. Turning the key **Off** in Accounts stops the Library from using it.
Zotero on the computer is used first when both are available.

### Keep sources up to date with Zotero

Choose **Import sources → Refresh from Zotero** to bring changes you made in
Zotero into sources imported from it. Fields you changed in Zotero are updated,
new notes and PDFs come in, and tags you added or removed in Zotero are added or
removed here. When you changed the same field both here and in Zotero, your
version here is kept and the refresh lists it: choose **Use Zotero's** or **Keep
mine**. An empty field in Zotero never clears one here, and an item you deleted
in Zotero stays in your Library.

### Send to Zotero

Choose **Send to Zotero** from a source's actions to add it to your zotero.org
library, or to update the Zotero item it came from with your changes here.
Only fields that differ are sent, and an empty field here never clears one in
Zotero. If the item was changed in Zotero after Scient last read it, nothing is
overwritten: refresh from Zotero first, then send again. This needs the Zotero
key in Accounts with write access. Changes are not sent automatically; there is
no two-way sync.

When your key may write to a group and the group lets you edit its library,
**Send to Zotero** asks where to send: **My Library** or that group. A source
sent to a library other than the one it came from gets a new item there and is
linked to it from then on. Scient refuses to send to a group the key can only
read.

Long imports can continue in the background. Completed items remain saved, and
an interrupted import can resume when the Library reopens. An item that is
already in your Library, by the rule in [Possible duplicates](#possible-duplicates),
is skipped, and the preview says so before you import. When a title, creator,
and year look similar but do not prove that two records are identical, Scient
asks whether to import the item separately.

## Import PDF files

1. In the **Library**, choose **Import sources → Import PDF files**.
2. Select one or more PDFs.
3. Review the imported records and correct any incomplete metadata.

Scient copies each PDF into your Library and creates an editable source record;
when you import a single new PDF, its details open so you can check them.
It first uses metadata embedded in the file. When the PDF contains one clear
DOI or explicitly labelled PMID, Scient can use that identifier to retrieve
better bibliographic metadata or an abstract from PubMed, Crossref, or Europe
PMC. It does not use fuzzy title matching, OCR, or an AI model to invent
missing facts. The date a PDF file was made is not taken as the publication
date; only a publication date the publisher embedded counts. A PDF remains
importable when metadata cannot be resolved; the unknown fields stay visible
for correction. A PDF that names no title is titled by its file name, and its
details say so until the paper's details are found or you edit the title.

To get faster, more reliable answers from Crossref, OpenAlex and Unpaywall, add
a contact email in **Settings ▸ Documents ▸ Library**. Scient sends it only to
those services, and sends no email while the field is empty.

Scient also uses your own research keys when you add them in **Accounts** under
**Research**: **OpenAlex** (get a free key at
[openalex.org/settings/api](https://openalex.org/settings/api)), **Google Books**
(an API key from the
[Google Cloud console](https://console.cloud.google.com/apis/credentials) with
the Books API turned on; if Google refuses the key, Scient asks without it),
**NCBI / PubMed**, **Semantic Scholar** and the
**Unpaywall email**. Without a key these services share a small allowance per
network address, which can run out while adding many sources. A key you turn
off in Accounts is not sent.

For remote projects, the selected PDFs are transferred to the selected project
environment. Metadata services receive only the exact public identifier used
for lookup, not the PDF itself. PubMed metadata is provided through NCBI
E-utilities and remains subject to the
[NCBI disclaimer and copyright notice](https://www.ncbi.nlm.nih.gov/home/about/policies/).

## Add by identifier

1. In the **Library**, choose **Import sources → Add by identifier**.
2. Paste one or more DOIs, PMIDs, arXiv IDs or ISBNs, one per line. Links such
   as `https://doi.org/…` or `arxiv.org/abs/…` and prefixes such as `PMID:` or
   `ISBN` work too, and a list may mix them.
3. Choose **Add** (or press Ctrl+Enter, ⌘+Enter on a Mac).

Scient looks up each identifier at its registry: doi.org for DOIs, PubMed for
PMIDs, arXiv for arXiv IDs, and Open Library, then Google Books, for ISBNs.
Each one that is found becomes its own source with the registry's title,
authors and date, marked as checked. The input then lists anything it did not
add and why: already in the Library (with **View**), not found, not an
identifier, or a registry that could not be reached. An identifier that exactly
one copy in your Library carries is that copy: it is reported as already in the
Library without asking the registry, so this works offline too. An ISBN finds a
whole book, never a chapter that shares it. When two or more copies carry the
identifier, Scient does not pick one; it looks the identifier up and judges by
the registry's title and type. If the registry cannot be reached and no catalogue
record is available, nothing is added and no copy is selected. An agent that adds
a source by its identifier alone gets the same answer. Entries of the last kind stay in the box so
**Add** tries them again. Up to 50 identifiers can be added at a time.

Open Library is edited by its readers, so a listing there without any author
is not trusted; Scient asks Google Books instead.

## Import a reference file

Bring a library from Zotero, Mendeley, EndNote, JabRef, Google Scholar or any
other reference manager by exporting it to a file and importing that file.

1. In the **Library**, choose **Import sources → Import a reference file**, or drop
   the file on the Library panel.
2. Select a BibTeX or BibLaTeX (`.bib`), RIS (`.ris`), CSL-JSON (`.json`) or
   EndNote XML (`.xml`) file.

Each entry keeps its citation key, authors, editors, identifiers (DOI, PMID,
PMCID, arXiv, ISBN, ISSN), tags and abstract. Notes in the file (`note` and
`annote`, RIS `N1`, EndNote notes) become the source's **My note**. LaTeX
accents and commands in `.bib` files are turned into plain text, `@string`
abbreviations and `crossref` entries are resolved, and Google Scholar's
"arXiv preprint" entries become preprints with their arXiv ID.

Entries already in the Library are left out, so importing the same file again
adds only what is new, even for entries with little more than a title. Up to 500 new references are imported at a time; for a
larger file, choose **Import the rest** (or import the file again) to continue.
PDFs the file links to (the `.bib` `file` field, RIS `L1` and `L4`, EndNote
PDF links) are attached to their sources when they are inside the project or
inside the folder the reference file is in (or a folder within it); a relative
path starts from that folder. Export from Zotero or JabRef with its files into
one folder and import from there. When you import through the web app or from
another computer, Scient does not know the file's folder, so only PDFs inside
the project are attached.

After the import, a short note lists entries that could not be read (with
their line), fields that have no place in a Scient source, such as `address`
or `edition`, and linked PDFs that were not attached, with the reason (not
found, outside the project and the file's folder, or not a PDF). Nothing else
is dropped silently. Identifiers
from a file are stored as given; Scient has not yet checked them against their
registries.

## Export the Library

Choose **More Library actions** (the **⋯** button next to **Import sources**),
then **Export** and a format: BibTeX, RIS, CSL-JSON or EndNote XML. When sources are selected, only they are
exported; otherwise, when a search or filter narrows the list, only the shown
sources are. Each source is written under its citation key.
Project notes stay private unless you turn on **Include notes**. Exported
BibTeX is UTF-8; words with inner capitals (`DNA`, `mRNA`) are braced so
styles keep their case.
Identifiers and the preprint type survive in every format. When a format has
no place for something (for example EndNote XML holds an arXiv ID or a PMID,
not both), a note after the export names what the file leaves out.

## Project packages

A project package is a folder with everything this project uses from your
Library, for a collaborator, a supervisor, another computer or a backup: the
pins with their citation details, project notes and their earlier versions,
the systematic reviews with every source they name (also sources only a review
names), the exact PDFs with their highlights, a paper's retraction or
withdrawal notices, and the collections those sources are in, with the
collections around them. Personal notes, reading state, saved searches and the
rest of your Library stay out; saved searches are yours, not the project's. It
is plain files: JSON, the PDFs and a `manifest.json` with every file's checksum.

Choose **⋯** > **Recover** > **Save a current package**. It saves to a new
folder, "Scient project package" with the date, in the folder you pick
(starting beside the project). Choose the project folder to save it inside
instead. When the project is on another computer, it is saved inside the
project by default. Git then commits it with the project, PDFs included, and
it takes disk space there.
Scient says what was left out because this Library did not have it.

People and agents can save or import a package at the requested path on the
computer running the project, including outside the project. No earlier panel
action is needed. A package cannot be saved or read in the project's `.scient`
folder, cannot overwrite an existing package, and cannot read payloads through
links that lead outside its folder.

To bring a package in, choose **⋯** > **Import a package**, then its folder
with **Choose a folder…**, or pick one of the package folders in the project. Scient
checks every file against the manifest first and refuses a package that
changed. A PDF missing from the manifest is reported as unavailable and is
never opened. Scient prepares each paper's PDF copies before joining it, so
other Library edits can finish while those copies are being made.
A paper joins one your Library already has only when the two are
clearly the same work (the same identifier, title and type) and you have not
marked them as not duplicates or chosen **Keep separate** for this project.
Keep separate still holds if the papers’ details later agree. These checks
also apply when the paper there has the same ID or was matched by an earlier
import, so a paper corrected since to another work is not joined. One that
only looks alike (the same title, first author and year), or that contradicts the paper there, is added as its own
paper, and nothing from it is attached to the other. A paper that changes here
while the import is joining it is left as it is and named; import the package
again to bring that one in.

What an import joins to a paper you already have:

- PDFs it lacks, and highlights: a highlight changed differently on both
  computers keeps yours, and clicking it shows **Another computer's version**
  with **Use this version**.
- Retraction, withdrawal and other notices it lacks, even when this computer
  checked the paper before, marked as from another computer's check; the more
  serious state shows. Its identifier check is taken only when this computer
  never checked it. An abstract is added when the paper has none.
- A project note: one this project already has stays, and the package's text
  and earlier versions join **Earlier versions**; a pin without a note takes
  the package's.
- A review that differs from this project's becomes a review with another
  version, to keep, replace or combine; so does a review whose decisions are
  the same but whose copy of the records differs, even a large review whose
  copy is split into several files. Records only the package's copy describes
  stay available when you choose that version.

Anything that could not be imported is named, never counted as imported. This
works with an empty Library and without the computer the package came from.
Importing a package is a deliberate import, so a paper in it that you deleted
for good comes back. A fresh checkout finds that imported copy even when its
citation details are incomplete; deleting it for good also stays deleted in
fresh checkouts until you deliberately import it again.

The import's message has **Undo**. To return later, choose **⋯** >
**Recover** > **Package imports**. It lists this project's imports with their
dates, counts and Undo when available. Open **What stayed** after Undo for
the full list of changed additions and evidence kept; **Show them** opens the
papers still in your Library. The list remains after closing and reopening
Scient. If a receipt cannot be read, the list names the skipped file and keeps
showing the healthy imports. If a current paper cannot be read, its import and
history still appear with a notice; the paper list may be incomplete.
Undo removes only unchanged project additions:
new pins, new collections, and a note it gave a pin that had none. Anything
changed since or used by another import stays. Every paper and PDF stays in
the Library, including papers used by other projects or by a pin whose note
you changed. The result says how many imported papers remain; **Show them**
opens the Library filtered to those papers. Use the ordinary **Move to Trash**
action if you no longer need one, or **Show all** to clear the filter.

Undo leaves, and lists, evidence the import joined: extra PDFs, notices,
abstracts, earlier note versions, highlights, collection memberships, reviews
and review versions. An old receipt without recorded versions keeps everything.
If a step fails, Undo says so and stays available to run again.

## Review and manage a source

Select a source to inspect its title, creators, publication details,
identifiers, abstract, tags, metadata warnings, and imported PDF. Opening the
PDF uses Scient's normal [PDF reader](pdf-reader.md), so you can move between
the library, source details, the document, and your conversation.

When the publisher or Retraction Watch has reported that a work was retracted,
withdrawn, flagged with an expression of concern or corrected, the source says
so in one line under its authors, with a link to the notice, and the Library
list shows it beside the source. Scient learns this from Crossref (or PubMed)
when the source is added and each time you refresh its metadata. If its DOI or
PMID no longer exists, or now names a different work, the source says that
instead.

Use **Edit** to correct the metadata. Use **Refresh metadata** when you want
Scient to recheck the existing PDF and exact DOI or PMID; review the warning
first because refreshed fields can replace manual corrections. Scient blocks
conflicting exact identifiers and asks before accepting a possible duplicate
as a separate source. An agent can refresh a source's metadata the same way;
the change is credited to the agent, and **History** can restore the earlier
version.

A source without a PDF that has a DOI or a link offers **Get PDF** in its
details, and the **⋯** menu offers **Get the missing PDF** (or **Get _N_
missing PDFs**) for every such source in the list; see
[Accounts](accounts.md) for how Scient reaches closed papers.

Use **Move to Trash** from the source actions to remove a source from your
Library; in **This project** a row's menu offers **Remove from this project**
instead, and **Move to Trash** is in the source's details and in **All**. Choose
**Undo** in the message that appears to put it straight back, or choose
**Trash** in the **⋯** menu at the top of the Library later to restore it. Its PDFs stay in
your Library while it is in the trash. **Empty trash** deletes the sources in
it for good, with their saved versions and any PDF no other source uses.
Removing a source never changes Zotero. Moving a paper to the Trash removes it
from your Library, not only from this project. Projects that have it, this one
included, keep its citation details and list it as "Not in this Library" until
you restore it; the message says how many other projects have it. Before
**Empty trash** deletes anything, it names the projects that still cite a paper
in the trash: deleted for good, the paper stays out of your Library, and those
projects keep citing it from their own copy of its citation details, listed as
"Not in this Library". An agent that deletes a paper for good is told the same.
Only a deliberate import puts it back: adding the paper again, or importing a
project package that has it. Moving another project into your Library, or an
old copy of a project, brings back neither the paper nor its PDF. Opening a
fresh checkout keeps it deleted even when the project's saved citation details
contain only a title. The Trash also holds the copies that merges took away: only the merge's **Undo** brings
those back, and once the trash is emptied those merges can no longer be undone.

Every change to a source is kept as a version. Choose **History** from the
source actions to see who changed what and when, and **Restore** an earlier
version; restoring saves it as the newest version, so nothing is lost. Scient
keeps the first version and the latest 49 of each source. A PDF removed from a
source stays available to restore until the trash is emptied.

If a source's file cannot be read, the Library still lists the others and says
which file it skipped.

## Highlight and annotate PDFs

Select text in any PDF in your project, including a source's PDF, and choose
**Highlight** or **Note** in the bar that appears. Highlights stay on the page
the next time you open the PDF; a passage with a note is underlined. Click a
highlight to add or change its note, **Remove** it (choose **Undo** in the
message to bring it back), or **Quote in my document**. A highlight a project
package brought with a different note shows **Another computer's version**;
**Use this version** makes it current, as a new change.

**Quote in my document** puts the passage into the Markdown or LaTeX document
in this project that you used last, as a quotation followed by its citation:
`[@key, p. 4]` in Markdown, `\cite[p.~4]{key}` in LaTeX. The key is the
source's citation key, so the quote is cited from your Library. A PDF that is
not a source is named by file and page instead. If no document is open, the
quote is copied as Markdown so you can paste it.

A source's details list the highlights and notes on its PDFs in reading order.
Choose a passage to open the PDF at it. Passages an agent added say so.

Highlights belong to the PDF's content, not its file name: the same PDF moved
or copied elsewhere in the project keeps them. If a PDF is replaced by a
different version, Scient shows each highlight only where its text can still be
found on its page. Highlights on a source's PDF are kept in your Library, so
they show in every project that uses the paper. Highlights on other PDFs in the
project are stored in the project, in `.scient/annotations/`, so they travel
with it.

## Search the full text

Scient reads the text of every page of every PDF in the Library and keeps it
in your Library, so you can search inside the papers. Type at least three
characters in the Library search: under the sources whose title, authors or
other details match, **In full text** lists passages from the PDFs that match,
with their page. While a filter is on, only the sources it keeps are searched.
Choose a passage to open the PDF with the matching words highlighted. Put a
phrase in quotes to require it; longer words also match words that start with
them, so `randomis` finds "randomised".

Reading runs in the background after a PDF is added. While it is still going,
the results say how many PDFs are left. A scanned PDF without a text layer
cannot be searched.

A quote you take from a Library PDF with **Ask in chat** records which file it
came from, so it can be found again exactly.

## Ask the Library

To ask a question that should be answered from your papers, open the Library's
**⋯** menu and choose **Ask the Library** (shown once the Library has
sources). It puts this sentence at the start of the chat's message box, before
anything you have already typed:

> Answer from the papers in my Library: search their full text, cite the paper
> and page for each claim, check any quotes, and say so if my Library does not
> answer it.

Type your question after it and send it. The answer gives the paper and page
for each claim, and quotes are checked against the PDF text first. When the
papers do not answer the question, the agent says so plainly; if it then uses
the web, it says that too.

You do not need the button for this. Whenever a question is about the
literature and the project has a Library, the agent follows the same rules by
default. The button makes them explicit for one question.

## Save from the Browser

In the Browser, choose **Save to Library** from the tab's menu. Select a
passage first to keep it in the source's note.

- On an article page, Scient reads the DOI, PMID, arXiv ID or ISBN the page
  states, checks it at its registry and saves the work with the registry's
  details, the same check an agent's add gets. A page that names an identifier
  that does not exist is not saved.
- When the page's own title does not match the work its identifier names, or
  the page has no title, it is saved as a web page instead, so a passage is
  never filed under a paper the page may only claim to be.
- Any other page is saved as a web page with its title and address.
- On a PDF tab, Scient downloads the PDF with the tab's sign-in and imports it
  like a PDF you dropped on the Library.

A saved passage starts with the address of the page it was selected on.
Saving a page that is already in the Library adds only a new passage to its
note.

## Organize sources

**Collections** group sources for a chapter, a project aim or a reading list.
A source can be in several collections, and putting it in one never changes the
source itself. Open the filter button beside the search box and choose
**Collection** to show one collection or to create a new one. In a source's
details, the **Collections** row shows where it belongs; use **+ Collection** to
add it to more. Deleting a collection keeps all of its sources, and **Undo** in
the message brings the collection back.

A collection can hold one level of subcollections. Show a top-level collection
and choose **New subcollection…** from the actions beside the filter row.
Showing a collection lists its subcollections' sources too. Two parents can
each have a subcollection with the same name.

**Tags** are short labels such as a method or a screening decision. In a
source's details, use **+ Tag** to add an existing tag or create a new one, and
the ✕ on a tag to remove it. Selecting a tag shows every source with that tag.
Tags match without regard to capitals, so `RCT` and `rct` are the same tag.

The filter button also narrows the list by type and by whether a source has a
PDF, and, once Scient has looked them up, by **Study design** and **Topic**,
each with how many sources have it. Study design comes from PubMed for papers
it indexes (randomized trial, meta-analysis, systematic review, cohort study,
case-control study, case report, review, or another design); a paper with
only a DOI is found in PubMed by its DOI. Topics are a preprint's arXiv
categories and the main OpenAlex topics of a paper. Scient looks them up in
the background, a few dozen papers per request, and again when you refresh a
source's metadata; a source's details show them under **Categories**, and
selecting one lists the sources that share it. The lookups use the contact
email from Library settings when one is set, and need no key. While a filter is on, a row under the search box shows each part, how many
sources match, and actions to rename or delete the collection or to save the
search. **Saved searches** keep the search text and filters under a name;
choose one from **Saved searches** to run it again.

To change many sources at once, choose **Select** from a source's actions, or
Command-click (Ctrl-click on Windows and Linux) a source. Then select more and
use the bar at the top of the list to add or remove a tag, add them to or take
them out of a collection, set their type, or move them to the Trash. Tag and
type changes are saved as a new version of each source, so they appear in its
history and can be restored like any other edit. **Undo** in the message that
appears reverses the whole change: each source gets back its type, the tags
that were added or removed, and its collections. A change someone made to a
source since then is kept, and the message says what was kept. If part of an
Undo fails, the message says so and **Try again** finishes the rest. With more
than 500 sources selected, the bar shows how far the change is and **Stop** ends
it after the sources in progress; what changed by then stays changed, and one
**Undo** reverses it. If the connection drops in the middle, the message says
which sources have an unknown outcome, and Undo does not cover those. Another
change to sources is refused until this one finishes. The latest 250 bulk changes can
be undone; a change to more than 500 sources counts as one for every 100 of them.

Collections, saved searches, study designs and topics are kept in your
Library, so they show in every project; choose **All** to see every source in
a collection.

## Run a systematic review

Choose **Systematic reviews** (in the **⋯** menu at the top of the Library)
to plan and record a systematic, scoping or rapid review. Each review keeps its
searches, duplicate decisions and screening decisions in the project, in
`.scient/library/reviews/`, and draws its PRISMA 2020 flow from them. The
review also keeps a copy of the details of every record it names, so it can be
screened on a computer whose Library does not have them. The
records it screens are ordinary Library sources, so import them first (for
example a database export, identifiers, or Zotero) and put each search's records
in a collection.

- **Records**: use **Log search** for each database search: the database, the
  search string exactly as run, the date and the number of results the
  database reported, with the collection or selected sources it brought in.
  Logging the same database, string and date again replaces that search. Add
  records found another way, such as from reference lists, with **Add
  records**. Sources the Library already merged on import count as
  duplicates; **Possible duplicates** lists pairs with the same title for you
  to resolve with **Keep first**, **Keep second** or **Not duplicates**.
- **Screening**: decide each record at **Title and abstract** and then at
  **Full text** with **Include**, **Maybe** or **Exclude** (choose a reason
  from the review's list or type another). With the record focused, press I,
  M or E. **Skip** moves a record to the end; **Undo** in **Recent decisions**
  reopens one. Only records included at title and abstract reach full text.
  At full text, choose **Not retrieved** for a report you could not obtain:
  it is counted as not retrieved, not as excluded. Deciding a report means you
  retrieved it.
- **PRISMA** shows the PRISMA 2020 flow: records screened and excluded,
  reports sought for retrieval and not retrieved, reports assessed for
  eligibility and excluded with their reasons, and studies included. Work not
  done yet is shown separately as awaiting screening, retrieval or assessment;
  a record marked **Maybe** is still awaiting. **Copy as Mermaid** copies it
  for a Markdown document. In reviews made before retrieval was recorded, a
  full-text exclusion with the reason "Full text not available" counts as not
  retrieved.

Choose **Edit review** from the review's actions to set its title, review
question and the exclusion reasons offered when you exclude a record. Deleting a
review never removes its sources, and **Undo** restores it. An agent
can do all of this too, using the built-in **systematic-review** skill; its
decisions are marked "by agent" and you can change any of them. Agent screening
is not an independent second reviewer.

## Choose a citation style

Each project has one citation style. It formats the reference shown for each
source, the reference you copy, and Markdown exported to Word. To choose it,
open the Library's **⋯** menu and choose **Citation style…**, or select the
style name next to **Reference** on a source. Search by journal or style name
(for example "Nature", "Cell", "IEEE" or "Harvard") and pick a result; the
project's current style is at the top. **Remove** goes back to having no
project style.

The search covers the more than 10,000 styles of the
[Citation Style Language](https://citationstyles.org/) repository, through the
Zotero Style Repository. Twenty common styles come with Scient and work without
a network: APA 7, Chicago (author-date and notes), Cite Them Right Harvard,
IEEE, Nature, Science, Cell, AMA, MLA, ACS, NLM/Vancouver, Elsevier Vancouver,
BMJ, The Lancet, NEJM, PNAS, PLOS, Elsevier Harvard and Springer author-date.
When the catalogue cannot be reached, the picker says so and searches those.

The chosen style is saved in the project, under `.scient/citations`, so the
project formats references the same way offline, for a collaborator and in CI.
Most journal styles borrow the layout of another style; Scient saves that style
too. If the style's file goes missing, is damaged or formats nothing, or the
project's style cannot be read, Scient names the problem and the style it used
instead; it never switches style without saying so.

## Copy a formatted reference

Open a source and choose **Copy reference**. The reference is in the project's
citation style; a project without one uses **Vancouver** or **APA 7**, chosen
on this computer as before. Formatting uses the metadata stored in the project
and does not require Zotero to remain open. The style changes only the
displayed reference, not the saved source.

Incomplete metadata can produce an incomplete citation, so review visible
warnings before using it in a manuscript. Scient does not silently fill
unknown values.

## Cite sources in your documents

Every source has a **citation key**, such as `lovelace1843notes`. A key that
came from Zotero (including Better BibTeX) or a `.bib` file is kept; otherwise
Scient makes one from the first author, the year and the first word of the
title, adding a letter when another source already has it. A key never changes
by itself. To rename one, edit the source and change **Citation key**; citations
in the project's Markdown and LaTeX documents follow the new key. Code, math,
links and LaTeX comments or verbatim text are left as written. If a document
cannot be changed (for example a linked file), Scient lists it so you can
update it yourself.

- **Markdown:** type `[@` and pick a source from the list (by key, author, year
  or title). Press Enter or Tab to insert it; Escape closes the list.
- **LaTeX:** **Insert citation** lists Library sources after the document's own
  `.bib` entries.
- **Open a source from a citation:** click it while reading, or Control-click
  (Command-click on a Mac) while writing.

Scient keeps `references.bib` and `references.json` (CSL-JSON) at the project
root up to date with the Library, so LaTeX, Pandoc and Overleaf can use them.
Add `\bibliography{references}` to a LaTeX document, or
`bibliography: references.bib` to a Markdown document's front matter. If you
edit one of these files yourself, Scient keeps your edits and says so in the
Library: choose **Import new entries** to add entries you typed to the Library,
or **Use Library version** to write the file again from the Library. Scient
never writes over a `references.bib` it did not create, or over a change you
save while it is writing. If a write fails part way (for example on a full
disk), the earlier text is kept beside it as `references.bib.kept-…`, and the
Library says where until you delete that copy. These files hold the same entries as **Export** to
BibTeX or CSL-JSON, without abstracts: abstracts make the files several times
larger and no document needs them. The Library keeps every abstract, and
**Export** (or an agent's export) still writes them.

### Export to Word with a citation style

Markdown exported to Word formats its citations and bibliography with Pandoc.
The style comes from, in order:

1. the document's own `csl:` in its front matter: `apa`, `vancouver`, or the
   path of a `.csl` file in the project;
2. the [project's citation style](#choose-a-citation-style);
3. **Settings → Documents → Word → Citation style** (Chicago author-date, APA 7
   or Vancouver).

If the project's style cannot be read, the export's notices name it and the
style used instead. Citations whose keys the document's own references do not
define come from the Library. Changing the style changes only the exported
file, never a source.

## Check references

Choose **Check references** in the Library's **⋯** menu, or in the menu of a Markdown
or LaTeX document. Scient checks the Library, or the chosen `.md`, `.tex` or
`.bib` file together with the bibliography files it names and the sources its
citation keys name: this project's keys, including papers it only keeps as
citation details. A fix to a Library source changes that source in your Library. Each DOI, PMID, arXiv ID and ISBN is looked up
in its registry, the same way sources are checked when they are added.

The results list what needs attention, most serious first:

- **Problems**: an identifier that does not exist or belongs to a different
  work, a retracted work, and a citation with no bibliography entry.
- **Warnings**: a correction or expression of concern, a title, year, venue,
  volume or pages that differ from the registry, a missing required field, a
  duplicate key, and two entries for the same work.
- **Notes**: a preprint that has a published version, and an entry nobody cites.

**Apply** writes the registry's value into the `.bib` entry or the Library
source; **Apply _N_ fixes** does this for every fix in the list. If the file or
source changed since the check, the fix is refused and the check should be run
again. An entry whose key another entry also uses gets no fix until each has
its own key. **Open** goes to the source or the line in the file, and a notice or
published version opens in your browser. **Ignore** hides a finding from later
checks of the same file; **Show ignored** lets you restore it.

The check compares records only. It does not judge whether a cited work
supports the sentence that cites it, and a reference without an identifier is
counted but not looked up. When a registry does not answer, the results say the
check is incomplete.

## Work with agents

In a project conversation, an agent can search and read the same Library you
see, this project's sources or all of them, maintain both notes, add papers to
this project or remove them, mark them read or starred, merge duplicates, update metadata, attach or detach a project PDF,
move a source to the trash and restore it, restore an earlier version, or add a
new one. It can also organize the Library the way you can: create, rename and
delete collections and subcollections, save searches, list a collection, a
tag, a study design or a topic, change tags, type or collections on many
sources at once, sort sources into themes (it creates the collections and
fills them in one change, which **Undo** reverses whole, removing the
collections it made), and run a systematic review. It
can import a reference file from the project (`scient_sources_import_file`),
which attaches the same linked PDFs and reports the same unreadable entries and
fields not kept, and write the
Library to a project file in any of the four formats (`scient_sources_export`),
never replacing an existing file unless asked to. It saves and imports project
packages, lists this project’s imports with dates, counts and what stayed,
and undoes an import by its receipt and restores the copy from
before a move with `scient_sources_organize`. To change a note for this project
it must say which note it read; if the note changed since, nothing is written
and it gets the current note to reconcile. When two pins cite one paper (after
a merge), it names the pin by its citation key to read or change that pin's
note and its earlier versions. Everything an agent changes is credited to it
and can be undone the same way as your own changes.

An agent cites sources with `scient_sources_cite`: it gets the citation to
write (`[@key]` or `\cite{key}`) after Scient checks each source against its
registry, and it reports problems such as a DOI that does not resolve, a
retraction, or a published version of a preprint, without refusing the
citation. `scient_sources_bibliography` writes or checks the managed
bibliography files and can import or replace hand edits, as you can; it also
sets the project's citation style, which `scient_sources_list` finds by
journal or style name.

Before an agent adds a source, Scient looks up its DOI at doi.org, its PMID in
PubMed, its arXiv ID at arXiv or its ISBN in Open Library and Google Books. An
agent can also add a list of identifiers at once, as you can with **Add by
identifier**. If the identifier does not exist, or it belongs to a paper with a
different title, nothing is added and the agent is told what the registry
found. When the identifier checks out, Scient stores the registry's title,
authors, date and journal instead of the agent's. The source's details show
that an agent added it and whether its identifier was verified, not yet checked
because the registry could not be reached, or missing. After an agent changes a
source, its details say "Edited by agent". You can edit or remove these sources
like any other.

Agents check references with the same tool the dialog uses
(`scient_references_check`), and apply fixes or ignore findings with
`scient_references_resolve`. The built-in **references** skill guides an agent
through a full reference review: records first, then whether each source
supports its sentence, missing citations, newer versions and contrary evidence.
It applies only fixes you asked for and proposes the rest. When you ask only
for a check, it leaves your draft, your bibliography and your Library as they
are: it reads the papers already in your Library, fetches none, and lists the
ones it could not read. A page it names is the PDF page, counted from the first
page of the file, unless it says "printed page".

Results from the PubMed, Semantic Scholar and OpenAlex connectors become
sources the same way: the agent passes the paper's PMID, Semantic Scholar ID or
OpenAlex ID, and Scient fetches the record and checks it at the DOI's registry.
A paper whose DOI does not exist is refused; one that only the catalogue knows,
with no DOI, PMID or arXiv ID, is added as unverified.
You can paste those IDs or links when you add by identifier, too.

When you ask an agent to get papers for your library, it fetches them with
`scient_paper_get` or `scient_papers_queue` and files each PDF on the paper's
source: the copy that shares its DOI or arXiv ID and does not disagree with
what the paper lookup and the registry say about its title and type, by the
rule in [Possible duplicates](#possible-duplicates). A paper that is not in the
Library yet is added from its DOI's registry record, the same check as above. Scient prefers the published version and falls
back to a free accepted manuscript or preprint; the source's details then say
"PDF is a preprint" or "PDF is the accepted manuscript". Each PDF also records
how it arrived: a free copy, the publisher, your university sign-in, or your
library's link.

Agents can read your highlights and notes, and highlight or note a passage by
quoting it when you ask; Scient finds the words in the PDF's text even when
spacing or line breaks differ, and tells the agent when they appear more than
once. An agent can also change, remove or restore a highlight. Its highlights
appear in the open PDF when you come back to the window.

Agents also search and read the PDFs' text, and check quotes against it before
they give them to you: `scient_sources_search` finds passages,
`scient_sources_read_text` reads a paper page by page, and
`scient_sources_quote_check` says whether a quote is exactly in a paper (or the
same once spacing, ligatures and line-break hyphens are evened out), on which
page, and what the paper says instead when it is not there. An agent can also
save a web page with `scient_sources_save_page`, keeping a passage as you would.

The conversation's [permission mode](permission-modes.md) and provider approval
flow still apply to writes. Library tools stay scoped to the current project:
they do not grant arbitrary host file paths or turn uncertain metadata into
verified evidence. Agents can browse and import from Zotero, refresh from it
and send to it with the same rules as you; they change Zotero only when you ask
them to send.

## Current limits

The Library supports Zotero (on this computer or on zotero.org), direct PDF import
and reference files (BibTeX, RIS, CSL-JSON, EndNote XML). It does not yet
provide evidence grading. Automatic two-way sync with Zotero is not supported; Send to Zotero does not upload PDFs. Highlights need selectable
text: a scanned PDF without a text layer, chat attachments and generated PDFs
cannot be highlighted yet.
Your Library lives on one computer: each computer and each remote environment
has its own, and they are not synced yet. A project moved back into its own
folder cannot be moved into your Library again yet.
