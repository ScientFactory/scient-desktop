# Sources and PDF import

Scient keeps references and imported PDFs with the project that uses them. The
Sources workflow can import PDFs from the project environment or selected items
from a Zotero library running in that environment.

## Open Sources

Open a project, then choose **Sources** from the right-panel add menu. Sources
can remain beside the conversation or use the existing expanded-panel control.
If the folder is not yet a Scient project, the panel offers the same bounded
project setup used by **Add project**.

## Import from Zotero

1. Open Zotero on the same computer as the Scient environment.
2. In **Sources**, choose **Import sources**, then **Import from Zotero**.
3. Keep **My Library** selected, or choose a Zotero collection. A selected
   collection is paged independently; choose a nested collection explicitly
   when you want references stored there.
4. Either select individual references and choose **Import**, or choose
   **Import collection** / **Import all** to add the complete scope.

Scient reads the selected metadata and adds new references directly. A single
new reference opens on its information page when the import finishes. Only a
possible title/creator/year duplicate asks for another decision; exact
duplicates are not imported again.

Scient reads Zotero through its local API. It does not change the Zotero
library, store Zotero credentials, or require a Zotero cloud account. If Zotero
blocks local access, enable **Allow other applications on this computer to
communicate with Zotero** in Zotero's advanced settings and check again.
Zotero must be open in the same environment where the project runs. An empty
Zotero library is still a valid connection and is identified separately from a
failed connection.

Each selected item is completed as a bounded unit. Progress already completed
is durable. Closing Sources or moving to another part of the app does not stop
the import; the reference is added to the ledger in the background. You can
stop after the current item, resume an interrupted import after an app or
connection interruption when Sources reopens, or retry failed items without
re-importing exact duplicates.

The existing source list remains usable while a long import runs. Its compact
filter searches the metadata already present in the project—title, creator,
journal, year, and persistent identifiers—without loading every abstract or
PDF.

A collection or library import starts immediately without a second review
screen. Existing exact matches are skipped, Scient metadata corrections are
not overwritten, and references that belong to several Zotero collections are
imported only once. This is a one-time intake, not ongoing synchronization.

## Import PDFs from the computer

1. In **Sources**, choose **Import sources**, then **Import PDF files**.
2. Select one or more PDF files from your computer.
3. Wait while Scient reads the article metadata and adds each new source.

A single new PDF opens on its source-information page as soon as the import
finishes. You do not need to confirm incomplete metadata: missing fields remain
visible for correction after import. A possible title/creator/year duplicate
still requires an explicit **Import separately** decision because Scient cannot
safely infer whether it is the same work.

Scient copies each selected PDF into the project and creates an editable source
record. It first uses metadata embedded in the PDF. When the document contains
one unambiguous DOI or an explicitly labelled PMID, Scient may use that exact
identifier to retrieve richer bibliographic metadata. When an exact DOI or
PMID is known and the source did not already provide an abstract, Scient may
also retrieve one from PubMed, Crossref, or Europe PMC. It never replaces an
abstract already supplied by Zotero or corrected by you. It does not read the
visible PDF body for an abstract in this version, and it does not use fuzzy
title matching, OCR, or an AI model to guess missing facts. If metadata cannot
be resolved, the PDF remains importable and the missing fields stay visible for
you to correct.

The selected files are uploaded to the environment where the project runs, so
the same flow works for local and remote projects. Files are staged only for
the bounded import operation and are removed when that operation finishes, is
cancelled, or an unresolved duplicate review is dismissed. Metadata lookup
sends only the exact public identifier to the corresponding service; the PDF
itself is not uploaded to those services. PubMed metadata is provided through
NCBI E-utilities and remains subject to the
[NCBI disclaimer and copyright notice](https://www.ncbi.nlm.nih.gov/home/about/policies/).

## Project files and PDFs

Imported state lives under `.scient/sources/`:

- one versioned JSON record per source;
- content-addressed PDF copies;
- resumable operation records; and
- completion or cancellation receipts.

The original Zotero attachment remains unchanged. Selecting a source opens its
bibliographic details inside **Sources**, including its abstract,
publication fields, identifiers, tags, and metadata warnings.
For journal articles, Scient may replace the book symbol with a cached icon
from the journal's public website. The book remains the immediate fallback when
the icon cannot be identified, fetched safely, or displayed, so missing journal
artwork never delays or disrupts the Sources list.
Scient converts imported abstract markup into readable text and preserves
explicit structured-abstract headings such as **Objective** and **Results**.
Redundant provider wrapper headings such as a second **Abstract** label are
removed. Long abstracts initially use a compact four-line preview that fades at
its lower edge. **Show more** reveals the first structured section and a faded
start of the next one; from there, choose **Show full abstract** or **Show less**.
Tags remain on one compact line until you choose **Show more**.
Generic PDF Subject or description metadata is not labelled as an abstract;
when no authoritative abstract is available, the abstract section is omitted.
Metadata-only sources remain inspectable. Opening an imported PDF—either from
the source row or its details—adds a separate document tab beside **Sources**
and uses Scient's existing project PDF reader. You can move between the library,
source details, and document without closing the PDF.

## Correct source metadata

Open a source and choose **Edit** to correct its title, type, creators,
publication details, identifiers, source URL, abstract, language, or tags.
Scient normalizes DOI values and empty fields before saving. It never changes
the source identity, project identity, Zotero provenance, imported PDF, file
hash, or import receipts through this editor.

Choose **Refresh metadata** from the source actions to recheck its existing PDF
and exact DOI or PMID against the same bounded metadata pipeline used during
import. A compact warning appears first because confirming can replace existing
metadata fields, including manual corrections. The imported PDF remains
unchanged.

The editor emphasizes the most common academic source types. Choose **Other
source** to enter a specific type such as a protocol or clinical guideline;
Scient keeps that label with the source and uses it when deriving references.

Saving creates a new source-record revision and preserves the previous revision
in project history. If the source changed after you opened it, Scient keeps
your draft visible and asks you to reopen the latest version instead of
overwriting it. Exact identifier conflicts are blocked. A possible
title/creator/year match can be saved only after you explicitly confirm that it
is a separate source.

## Remove a source

Right-click a source row (or use a two-finger trackpad click) to open its source
actions, including view, edit, PDF, and removal when applicable. The same
**Remove from Sources** action remains in the small actions menu beside **Edit**
and **Open PDF** on the details page. Scient asks for confirmation before
removing the project-owned source record. An imported PDF is removed only when
no other source in the project uses the same content-addressed file.

Removing a source never changes the original Zotero library or attachment. If
the source changed after you opened it, Scient refreshes the latest version
instead of removing a revision you did not review.

## Copy a formatted reference

Open a source to see its formatted **Reference**. Choose **Vancouver** or
**APA 7**, then choose **Copy reference**. Formatting runs locally from the
metadata stored in the Scient project, so Zotero does not need to remain open
and sources added through future import paths will use the same formatter.
Scient remembers the last style chosen for each project on this device.

The reference is a derived view, not another saved copy of the source. Changing
the style never changes project metadata. An incomplete source may still
produce a reference with the conventions of the selected style, such as a
missing-date marker; review the visible metadata warnings before using it.

Scient displays missing or incomplete metadata as a warning instead of filling
unknown values. Exact Zotero origin, work-level identifiers (DOI, PMID, PMCID,
or arXiv), and identical PDF content are protected from re-import. Journal ISSN,
book ISBN, and unknown identifier schemes remain useful metadata but never prove
that two works are identical. A possible title/creator/year match is shown for
review and can be explicitly imported as a separate source. A confirmed
duplicate stays in Sources with an optional action to view the existing record;
it never silently redirects after a rejected import.

If a Zotero item has several PDF attachments, this first version reports the
total and identifies the single PDF it will copy. Additional PDFs remain
unchanged in Zotero and are not silently represented as imported.

## Current scope

This slice supports selected-reference, collection, and whole-library local
Zotero import plus direct PDF intake. It is not a replacement for Zotero. It
does not provide write-back, ongoing sync, in-text citations, multi-source
bibliographies, a searchable style catalog, annotations, evidence grading,
or a standalone Studio route.
