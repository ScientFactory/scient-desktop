# Sources and PDF import

Sources is the project's managed library of scientific references. Use it for
papers, books, datasets, protocols, guidelines, and other works that you want
to identify, review, cite, or make available to the AI as research evidence.
Each source has structured bibliographic metadata and can include an imported
PDF.

A source is different from an ordinary project file. Notes, tables, code,
manuscripts, and PDFs can exist anywhere in the project as working material;
they do not automatically become bibliographic sources. A web page opened in
the Browser or information mentioned in chat is also not added automatically.
Import or create a source when you want it to become part of the project's
explicit reference library.

## Open Sources

Open a project, then choose **Sources** from the right-panel add menu. Keep the
library beside the conversation or expand it when you need more room. If the
folder is not yet set up as a Scient project, Sources offers the same optional
project setup used by **Add project**.

Source records and imported PDFs are stored under `.scient/sources/` inside the
project. They remain project-owned rather than being hidden in a separate
personal library.

## Import from Zotero

1. Open Zotero on the same computer as the selected Scient environment, or
   save a Zotero API key in **Accounts** (see below).
2. In **Sources**, choose **Import sources → Import from Zotero**.
3. Select **My Library** or a specific Zotero collection.
4. Select individual references, import the selected collection, or import the
   complete library.

Scient copies each reference's metadata, tags, child notes (as the source's
note) and every PDF attachment into the project. A citation key the item
already has, from Zotero or Better BibTeX, is kept. Each source also joins a
Library collection named after each Zotero collection it is in; nested ones
are named like **Thesis / Chapter 2**. The original Zotero records and
attachments are never changed by an import.

Zotero must be open in the same environment where the project runs. For a
remote project, that means Zotero must run on the remote computer, not only on
the computer displaying Scient. If Zotero blocks local access, enable **Allow
other applications on this computer to communicate with Zotero** in Zotero's
advanced settings and try again.

### Your library on zotero.org

When Zotero is not open on that computer, Scient can use your library on
zotero.org instead. Create a key at zotero.org (**Settings → Security →
Create new private key**), allow it to read your library and files, and save
it in **Accounts** as the Zotero key. Allow write access too if you want to use
**Send to Zotero**. Scient keeps the key in Accounts and sends it only to
zotero.org. Turning the key **Off** in Accounts stops Sources from using it.
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

Long imports can continue in the background. Completed items remain saved, and
an interrupted import can resume when Sources reopens. Exact duplicates are
skipped. When a title, creator, and year look similar but do not prove that two
records are identical, Scient asks whether to import the item separately.

## Import PDF files

1. In **Sources**, choose **Import sources → Import PDF files**.
2. Select one or more PDFs.
3. Review the imported records and correct any incomplete metadata.

Scient copies each PDF into the project and creates an editable source record.
It first uses metadata embedded in the file. When the PDF contains one clear
DOI or explicitly labelled PMID, Scient can use that identifier to retrieve
better bibliographic metadata or an abstract from PubMed, Crossref, or Europe
PMC. It does not use fuzzy title matching, OCR, or an AI model to invent
missing facts. The date a PDF file was made is not taken as the publication
date; only a publication date the publisher embedded counts. A PDF remains
importable when metadata cannot be resolved; the unknown fields stay visible
for correction.

To get faster, more reliable answers from Crossref, OpenAlex and Unpaywall, add
a contact email in **Settings ▸ Documents ▸ Library**. Scient sends it only to
those services, and sends no email while the field is empty.

For remote projects, the selected PDFs are transferred to the selected project
environment. Metadata services receive only the exact public identifier used
for lookup, not the PDF itself. PubMed metadata is provided through NCBI
E-utilities and remains subject to the
[NCBI disclaimer and copyright notice](https://www.ncbi.nlm.nih.gov/home/about/policies/).

## Import a reference file

Bring a library from Zotero, Mendeley, EndNote, JabRef, Google Scholar or any
other reference manager by exporting it to a file and importing that file.

1. In **Sources**, choose **Import sources → Import a reference file**, or drop
   the file on the Sources panel.
2. Select a BibTeX or BibLaTeX (`.bib`), RIS (`.ris`), CSL-JSON (`.json`) or
   EndNote XML (`.xml`) file.

Each entry keeps its citation key, authors, editors, identifiers (DOI, PMID,
PMCID, arXiv, ISBN, ISSN), tags and abstract. Notes in the file (`note` and
`annote`, RIS `N1`, EndNote notes) become the source's project note. LaTeX
accents and commands in `.bib` files are turned into plain text, `@string`
abbreviations and `crossref` entries are resolved, and Google Scholar's
"arXiv preprint" entries become preprints with their arXiv ID.

Entries already in the Library are left out, so importing the same file again
adds only what is new. Up to 500 new references are imported at a time; for a
larger file, choose **Import the rest** (or import the file again) to continue.
After the import, a short note lists entries that could not be read (with
their line) and fields that have no place in a Scient source, such as `file`
links, `address` or `edition`. Nothing else is dropped silently. Identifiers
from a file are stored as given; Scient has not yet checked them against their
registries.

## Export the Library

Choose **Export** (the arrow next to **Import sources**) and a format: BibTeX,
RIS, CSL-JSON or EndNote XML. When sources are selected, only they are
exported; otherwise, when a search or filter narrows the list, only the shown
sources are. Each source is written under its citation key.
Project notes stay private unless you turn on **Include notes**. Exported
BibTeX is UTF-8; words with inner capitals (`DNA`, `mRNA`) are braced so
styles keep their case.

## Review and manage a source

Select a source to inspect its title, creators, publication details,
identifiers, abstract, tags, metadata warnings, and imported PDF. Opening the
PDF uses Scient's normal [PDF reader](pdf-reader.md), so you can move between
the library, source details, the document, and your conversation.

Use **Edit** to correct the metadata. Use **Refresh metadata** when you want
Scient to recheck the existing PDF and exact DOI or PMID; review the warning
first because refreshed fields can replace manual corrections. Scient blocks
conflicting exact identifiers and asks before accepting a possible duplicate
as a separate source.

Use **Move to Trash** from the source actions to remove a source. Choose
**Undo** in the message that appears to put it straight back, or open the
trash button at the top of the Library later to restore it. Its PDFs stay in
the project while it is in the trash. **Empty trash** deletes the sources in
it for good, with their saved versions and any PDF no other source uses.
Removing a source never changes Zotero.

Every change to a source is kept as a version. Choose **History** from the
source actions to see who changed what and when, and **Restore** an earlier
version; restoring saves it as the newest version, so nothing is lost. Scient
keeps the first version and the latest 49 of each source. A PDF removed from a
source stays available to restore until the trash is emptied.

If a source's file in the project cannot be read, the Library still lists the
others and says which file it skipped.

## Search the full text

Scient reads the text of every page of every PDF in the Library and keeps it
with the project, so you can search inside the papers. Type at least three
characters in the Library search: under the sources whose title, authors or
other details match, **In full text** lists passages from the PDFs that match,
with their page. Choose a passage to open the PDF with it highlighted. Put a
phrase in quotes to require it; longer words also match words that start with
them, so `randomis` finds "randomised".

Reading runs in the background after a PDF is added. While it is still going,
the results say how many PDFs are left. A scanned PDF without a text layer
cannot be searched.

A quote you take from a Library PDF with **Ask in chat** records which file it
came from, so it can be found again exactly.

## Save from the Browser

In the Browser, choose **Save to Library** from the tab's menu. Select a
passage first to keep it in the source's note.

- On an article page, Scient reads the DOI, PMID, arXiv ID or ISBN the page
  states, checks it at its registry and saves the work with the registry's
  details, the same check an agent's add gets. A page that names an identifier
  that does not exist is not saved.
- Any other page is saved as a web page with its title and address.
- On a PDF tab, Scient downloads the PDF with the tab's sign-in and imports it
  like a PDF you dropped on the Library.

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

**Tags** are short labels such as a method or a screening decision. In a
source's details, use **+ Tag** to add an existing tag or create a new one, and
the ✕ on a tag to remove it. Selecting a tag shows every source with that tag.
Tags match without regard to capitals, so `RCT` and `rct` are the same tag.

The filter button also narrows the list by type and by whether a source has a
PDF. While a filter is on, a row under the search box shows each part, how many
sources match, and actions to rename or delete the collection or to save the
search. **Saved searches** keep the search text and filters under a name;
choose one from **Saved searches** to run it again.

To change many sources at once, choose **Select** from a source's actions, or
Command-click (Ctrl-click on Windows and Linux) a source. Then select more and
use the bar at the top of the list to add or remove a tag, add them to or take
them out of a collection, set their type, or move them to the Trash. Tag and
type changes are saved as a new version of each source, so they appear in its
history and can be restored like any other edit.

Collections and saved searches are kept in `.scient/sources/collections.json`
with the rest of the project's Library.

## Copy a formatted reference

Open a source, choose **Vancouver** or **APA 7**, then choose **Copy
reference**. Formatting uses the metadata stored in the project and does not
require Zotero to remain open. The selected style changes only the displayed
reference, not the saved source.

Incomplete metadata can produce an incomplete citation, so review visible
warnings before using it in a manuscript. Scient does not silently fill
unknown values.

## Check references

Choose **Check references** in the Library header, or in the menu of a Markdown
or LaTeX document. Scient checks the Library, or the chosen `.md`, `.tex` or
`.bib` file together with the bibliography files it names and the Library
sources its citation keys name. Each DOI, PMID, arXiv ID and ISBN is looked up
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
again. **Open** goes to the source or the line in the file, and a notice or
published version opens in your browser. **Ignore** hides a finding from later
checks of the same file; **Show ignored** lets you restore it.

The check compares records only. It does not judge whether a cited work
supports the sentence that cites it, and a reference without an identifier is
counted but not looked up. When a registry does not answer, the results say the
check is incomplete.

## Work with agents

In a project conversation, an agent can search and read the same project-owned
library, maintain source notes, update metadata, attach or detach a project PDF,
move a source to the trash and restore it, restore an earlier version, or add a
new one. It can also organize the Library the way you can: create, rename and
delete collections, save searches, list a collection or a tag, and change tags,
type or collections on many sources at once. It can import a reference file
from the project (`scient_sources_import_file`), which reports the same
unreadable entries and fields not kept, and write the Library to a project file
in any of the four formats (`scient_sources_export`), never replacing an
existing file unless asked to. Everything an agent changes is credited to it
and can be undone the same way as your own changes.

Before an agent adds a source, Scient looks up its DOI at doi.org or its PMID in
PubMed. If the identifier does not exist, or it belongs to a paper with a
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
It applies only fixes you asked for and proposes the rest.

Results from the PubMed, Semantic Scholar and OpenAlex connectors become
sources the same way: the agent passes the paper's PMID, Semantic Scholar ID or
OpenAlex ID, and Scient fetches the record and checks it at the DOI's registry.
A paper whose DOI does not exist is refused; one that only the catalogue knows,
with no DOI, PMID or arXiv ID, is added as unverified.
You can paste those IDs or links when you add by identifier, too.

When you ask an agent to get papers for your library, it fetches them with
`scient_paper_get` or `scient_papers_queue` and files each PDF on the paper's
source. A paper that is not in Sources yet is added from its DOI's registry
record, the same check as above. Scient prefers the published version and falls
back to a free accepted manuscript or preprint; the source's details then say
"PDF is a preprint" or "PDF is the accepted manuscript". Each PDF also records
how it arrived: a free copy, the publisher, your university sign-in, or your
library's link.

Agents also search and read the PDFs' text, and check quotes against it before
they give them to you: `scient_sources_search` finds passages,
`scient_sources_read_text` reads a paper page by page, and
`scient_sources_quote_check` says whether a quote is exactly in a paper (or the
same once spacing, ligatures and line-break hyphens are evened out), on which
page, and what the paper says instead when it is not there. An agent can also
save a web page with `scient_sources_save_page`, keeping a passage as you would.

The conversation's [permission mode](permission-modes.md) and provider approval
flow still apply to writes. Sources tools stay scoped to the current project:
they do not grant arbitrary host file paths or turn uncertain metadata into
verified evidence. Agents can browse and import from Zotero, refresh from it
and send to it with the same rules as you; they change Zotero only when you ask
them to send.

## Current limits

Sources supports Zotero (on this computer or on zotero.org), direct PDF import
and reference files (BibTeX, RIS, CSL-JSON, EndNote XML). It does not yet
provide in-text citation insertion, multi-source bibliography generation, PDF
annotation, or evidence grading. Zotero group libraries and automatic two-way
sync are not supported; Send to Zotero does not upload PDFs.
