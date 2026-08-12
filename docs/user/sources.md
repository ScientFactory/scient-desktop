# Sources and Zotero import

Scient keeps references and imported PDFs with the project that uses them. The
first Sources workflow can import selected items from a Zotero library running
on the same computer.

## Open Sources

Open a project, then choose **Sources** from the right-panel add menu. Sources
can remain beside the conversation or use the existing expanded-panel control.
If the folder is not yet a Scient project, the panel offers the same bounded
project setup used by **Add project**.

## Import selected Zotero items

1. Open Zotero on the same computer as the Scient environment.
2. In **Sources**, choose **Import from Zotero**.
3. Search or browse the local library and select one or more references.
4. Review duplicate and metadata warnings.
5. Choose **Import**.

Scient reads Zotero through its local API. It does not change the Zotero
library, store Zotero credentials, or require a Zotero cloud account. If Zotero
blocks local access, enable **Allow other applications on this computer to
communicate with Zotero** in Zotero's advanced settings and check again.

Each selected item is completed as a bounded unit. Progress already completed
is durable. You can stop after the current item, resume an interrupted import,
or retry failed items without re-importing exact duplicates.

## Project files and PDFs

Imported state lives under `.scient/sources/`:

- one versioned JSON record per source;
- content-addressed PDF copies;
- resumable operation records; and
- completion or cancellation receipts.

The original Zotero attachment remains unchanged. Opening an imported PDF uses
Scient's existing project PDF reader. Metadata-only sources remain visible but
do not open a document.

Scient displays missing or incomplete metadata as a warning instead of filling
unknown values. Exact Zotero, persistent-identifier, and PDF matches are
skipped. A possible title/creator/year match is shown for review and is not
merged automatically.

## Current scope

This first slice is a selective local import, not a replacement for Zotero. It
does not provide write-back, ongoing sync, citation formatting, annotations,
evidence grading, automatic whole-library import, or a standalone Studio route.
