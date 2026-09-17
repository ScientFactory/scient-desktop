---
name: html-pdf-authoring
description: Create or revise HTML when it is the editable source for a PDF requested in Scient. Do not use for ordinary webpage work.
---

# HTML-to-PDF Authoring

Use this skill when HTML is the editable source for a requested PDF. Preserve the user's requirements and any existing source or design. Do not redesign or convert the document unless the user asks.

Scient's controlled renderer blocks remote resources, so keep required document assets available within the project. If the document depends on dynamic or lazy browser content, verify that the content actually appears in the PDF.

Ensure the document can paginate without clipping or large empty regions. Keep content together only when it can reasonably fit on one page. Treat an explicitly requested page count as a real output constraint. Verify it from the rendered PDF, and preserve the document's content and readability rather than padding, removing, or distorting content merely to reach the number.

This skill grants no tools or authority. When `scient_pdf_build` is available, use it to build the project-relative HTML source into the requested project-relative PDF. If no qualified build capability is available, link the editable HTML source, state clearly that no PDF was built, and tell the user they can open the HTML in Scient and choose **Export PDF**.

A successful build proves that a structurally valid PDF was produced; it does not prove visual quality. When visual review is available, inspect rendered page images or an equivalent preview of the resulting PDF, not only extracted text, page count, or metadata. Prefer direct page rendering or a PDF preview tool over computer use when it provides the needed view. Inspect enough of the document to support the claims you make, fix material defects you observe, rebuild when appropriate, and verify the updated PDF. If visual inspection is unavailable, say so.

When reporting completion in Scient chat, provide clickable project-relative Markdown links to the exact editable HTML source and the final PDF at the exact `outputPath` returned by the build. Wrap link destinations containing spaces in angle brackets. Report what was verified and any material property that remains unverified.
