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
missing facts. A PDF remains importable when metadata cannot be resolved; the
unknown fields stay visible for correction.

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

Use **Remove from Sources** from the source actions to remove the project-owned
record. Scient asks for confirmation. Removing it never changes Zotero, and an
imported PDF is retained when another source in the project still uses it.

## Copy a formatted reference

Open a source, choose **Vancouver** or **APA 7**, then choose **Copy
reference**. Formatting uses the metadata stored in the project and does not
require Zotero to remain open. The selected style changes only the displayed
reference, not the saved source.

Incomplete metadata can produce an incomplete citation, so review visible
warnings before using it in a manuscript. Scient does not silently fill
unknown values.

## Work with agents

When Sources access is enabled, an agent can search and read the same
project-owned library, maintain source notes, update metadata, attach or detach
a project PDF, remove a source, or propose a new one. Agent-proposed sources are
marked for your review; approve one to add it normally or reject it to remove
the proposal.

Manage this access in **Settings → Integrations**. Turning agent access off does
not remove Sources or prevent you from using the library yourself. The
conversation's [permission mode](permission-modes.md) and provider approval
flow still apply to writes. Access to Sources does not grant arbitrary host
file paths, change Zotero, or turn uncertain metadata into verified evidence.

## Current limits

Sources currently supports local Zotero intake and direct PDF import. It is not
a replacement for Zotero and does not yet provide ongoing synchronization,
Zotero write-back, in-text citation insertion, multi-source bibliography
generation, PDF annotation, or evidence grading. When a Zotero item has several
PDF attachments, the import identifies and copies one rather than silently
representing all of them.
