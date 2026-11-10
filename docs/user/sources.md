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

1. Open Zotero on the same computer as the selected Scient environment.
2. In **Sources**, choose **Import sources → Import from Zotero**.
3. Select **My Library** or a specific Zotero collection.
4. Select individual references, import the selected collection, or import the
   complete library.

Scient copies the selected metadata and, when available, one PDF attachment
into the project. This is a one-time import, not ongoing synchronization.
Changes made later in Scient do not write back to Zotero, and the original
Zotero records and attachments remain unchanged.

Zotero must be open in the same environment where the project runs. For a
remote project, that means Zotero must run on the remote computer, not only on
the computer displaying Scient. If Zotero blocks local access, enable **Allow
other applications on this computer to communicate with Zotero** in Zotero's
advanced settings and try again.

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

## Work with agents

In a project conversation, an agent can search and read the same project-owned
library, maintain source notes, update metadata, attach or detach a project PDF,
move a source to the trash and restore it, restore an earlier version, or add a
new one. It can also organize the Library the way you can: create, rename and
delete collections, save searches, list a collection or a tag, and change tags,
type or collections on many sources at once. Everything an agent changes is credited to it and can be undone the
same way as your own changes.

Before an agent adds a source, Scient looks up its DOI at doi.org or its PMID in
PubMed. If the identifier does not exist, or it belongs to a paper with a
different title, nothing is added and the agent is told what the registry
found. When the identifier checks out, Scient stores the registry's title,
authors, date and journal instead of the agent's. The source's details show
that an agent added it and whether its identifier was verified, not yet checked
because the registry could not be reached, or missing. After an agent changes a
source, its details say "Edited by agent". You can edit or remove these sources
like any other.

Results from the PubMed, Semantic Scholar and OpenAlex connectors become
sources the same way: the agent passes the paper's PMID, Semantic Scholar ID or
OpenAlex ID, and Scient fetches the record and checks it at the DOI's registry.
You can paste those IDs or links when you add by identifier, too.

When you ask an agent to get papers for your library, it fetches them with
`scient_paper_get` or `scient_papers_queue` and files each PDF on the paper's
source. A paper that is not in Sources yet is added from its DOI's registry
record, the same check as above. Scient prefers the published version and falls
back to a free accepted manuscript or preprint; the source's details then say
"PDF is a preprint" or "PDF is the accepted manuscript". Each PDF also records
how it arrived: a free copy, the publisher, your university sign-in, or your
library's link.

The conversation's [permission mode](permission-modes.md) and provider approval
flow still apply to writes. Sources tools stay scoped to the current project:
they do not grant arbitrary host file paths, change Zotero, or turn uncertain
metadata into verified evidence.

## Current limits

Sources currently supports local Zotero intake and direct PDF import. It is not
a replacement for Zotero and does not yet provide ongoing synchronization,
Zotero write-back, in-text citation insertion, multi-source bibliography
generation, PDF annotation, or evidence grading. When a Zotero item has several
PDF attachments, the import identifies and copies one rather than silently
representing all of them.
