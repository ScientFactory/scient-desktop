# Sources and PDF import

Scient keeps references and imported PDFs with the project that uses them. The
Sources workflow can import PDFs from the project environment or selected items
from a Zotero library running in that environment.

## Open Sources

Open a project, then choose **Sources** from the right-panel add menu. Sources
can remain beside the conversation or use the existing expanded-panel control.
If the folder is not yet a Scient project, the panel offers the same bounded
project setup used by **Add project**.

## Import selected Zotero items

1. Open Zotero on the same computer as the Scient environment.
2. In **Sources**, choose **Import sources**, then **Import from Zotero**.
3. Search or browse the local library and select one or more references.
4. Review duplicate and metadata warnings.
5. Choose **Import**.

Scient reads Zotero through its local API. It does not change the Zotero
library, store Zotero credentials, or require a Zotero cloud account. If Zotero
blocks local access, enable **Allow other applications on this computer to
communicate with Zotero** in Zotero's advanced settings and check again.
Zotero must be open in the same environment where the project runs. An empty
Zotero library is still a valid connection and is identified separately from a
failed connection.

Each selected item is completed as a bounded unit. Progress already completed
is durable. You can stop after the current item, resume an interrupted import,
or retry failed items without re-importing exact duplicates.

## Import PDFs from the computer

1. In **Sources**, choose **Import sources**, then **Import PDF files**.
2. Select one or more PDF files from your computer.
3. Wait while Scient reads the PDF metadata, then review the detected details and duplicate
   warnings.
4. Choose **Add to Sources**. When detected metadata is incomplete, the action says **Add
   anyway** so the missing details are not hidden.

Scient copies each selected PDF into the project and creates an editable source
record. It first uses metadata embedded in the PDF. When the document contains
one unambiguous DOI or an explicitly labelled PMID, Scient may use that exact
identifier to retrieve richer bibliographic metadata. It does not use fuzzy
title matching, OCR, or an AI model to guess missing facts. If metadata cannot
be resolved, the PDF remains importable and the missing fields stay visible for
you to correct.

The selected files are uploaded to the environment where the project runs, so
the same flow works for local and remote projects. Files are staged only for
the review/import operation and are removed when that operation finishes or is
cancelled. DOI and PubMed lookup sends only the exact public identifier to the
corresponding metadata service; the PDF itself is not uploaded to those
services. PubMed metadata is provided through NCBI E-utilities and remains
subject to the [NCBI disclaimer and copyright notice](https://www.ncbi.nlm.nih.gov/home/about/policies/).

## Project files and PDFs

Imported state lives under `.scient/sources/`:

- one versioned JSON record per source;
- content-addressed PDF copies;
- resumable operation records; and
- completion or cancellation receipts.

The original Zotero attachment remains unchanged. Selecting a source opens its
bibliographic details inside **Sources**, including its abstract,
publication fields, identifiers, tags, and metadata warnings.
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

Open a source, choose the small source-actions menu beside **Edit** and
**Open PDF**, then choose **Remove from Sources**. Scient asks for confirmation
before removing the project-owned source record. An imported PDF is removed
only when no other source in the project uses the same content-addressed file.

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
unknown values. Exact Zotero, persistent-identifier, and PDF matches are
skipped. A possible title/creator/year match is shown for review. Because that
match is only a warning, you can explicitly import it as a separate source;
confirmed duplicate signals cannot be overridden.

If a Zotero item has several PDF attachments, this first version reports the
total and identifies the single PDF it will copy. Additional PDFs remain
unchanged in Zotero and are not silently represented as imported.

## Current scope

This slice supports selective local Zotero import and direct PDF intake. It is
not a replacement for Zotero. It
does not provide write-back, ongoing sync, in-text citations, multi-source
bibliographies, a searchable style catalog, annotations, evidence grading,
automatic whole-library import, or a standalone Studio route.
