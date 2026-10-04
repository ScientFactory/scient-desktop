# Scient divergence inventory

`scripts/scient-divergence-inventory.mjs` inventories changed paths inherited from an exact upstream commit. It is an advisory maintainer tool, separate from feature seam manifests. It does not modify source, Git objects, refs, the index, or CI. It does not decide whether a change is architecturally justified or whether a feature still works.

Run from an installed repository checkout with explicit immutable object IDs:

```sh
node scripts/scient-divergence-inventory.mjs \
  --upstream ca7df394ed8151fa77f856beefa90bc60a785d60 \
  --candidate FULL_40_CHARACTER_COMMIT_OR_TREE_ID > divergence.json
```

The upstream object must resolve to a commit; the candidate may be a commit or tree. Moving refs and abbreviated hashes are rejected. Local replacement refs are ignored, and lazy object fetching is disabled. Required objects must already exist locally, and Git must support `--no-lazy-fetch`; older Git versions fail unavailable. The comparison includes every changed upstream path, without feature, test, documentation, generated-file, or deleted-file exclusions. Candidate-only paths are listed separately; membership does not establish their authorship. Paths come from NUL-delimited Git trees, including spaces, tabs, newlines, and UTF-8 names. Undecodable paths or blobs remain unavailable or unresolved.

## What markers establish

The supported syntax is TypeScript and JavaScript (`.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`, `.mjs`, `.cjs`). The existing `typescript-legacy` compiler parses these sources. Only AST-associated genuine comments can establish marker intervals. String literals, template tokens, regular expressions, and JSX text cannot supply markers. A line in a comment must begin with `SCIENT-FORK:START` or `SCIENT-FORK:END`, allowing whitespace and a JSDoc `*` prefix. Prose mentioning a marker elsewhere in a comment does not establish a boundary.

```ts
// SCIENT-FORK:START — Scient-owned presentation mount
mountScientPanel();
// SCIENT-FORK:END
```

Pairs must be ordered and nonnested. Malformed pairs and parser errors leave the whole file unresolved. The tool checks zero-context Git hunks:

- Every added or replaced candidate line must lie inside a valid interval, including its delimiter lines.
- A deletion-only hunk records a gap after candidate line `n`. That gap must be after START and before END; a gap before START or after END is unmarked.
- Removing an entire upstream file requires its own exact tombstone allowance. Markers in other files cannot cover it.

This is a line-level inventory. A line containing a marker may also contain other expressions, and a large pair may encompass upstream code. The tool reports intervals; it cannot certify that their size or ownership is sensible. Review meaningful blocks before adding markers. Do not wrap whole files simply to reduce the count.

Other languages, including Markdown, YAML, shell, CSS, Rust, and XML, are explicitly unresolved. JSON and `pnpm-lock.yaml` are unmarkable artifacts, binary content is separate debt, and nonregular objects or mode changes are reported separately. A genuine early source comment containing `@generated` or “generated … do not edit” is a conservative generated-source hint, not exhaustive generator detection. Unsupported encodings and Git failures cannot produce a clean inventory.

## Reviewed historical debt

There is no automatic baseline generator and no baseline checked in with this tool. A maintainer may prepare an independently reviewed baseline after final composition. Each entry acknowledges one exact finding, never an entire path:

```json
{
  "schemaVersion": 1,
  "upstream": "ca7df394ed8151fa77f856beefa90bc60a785d60",
  "entries": [
    {
      "fingerprint": "64_CHARACTER_SHA256_FROM_ONE_REVIEWED_FINDING",
      "owner": "Responsible maintainer",
      "reason": "Why this exact historical debt remains temporarily",
      "reviewRecord": "docs/internals/committed-review-record.md",
      "expiresAt": "2026-12-01"
    }
  ]
}
```

The review record must be a nonempty regular file present under `docs/` in the candidate tree. The tool checks its existence, not whether it represents real independent approval. That remains a review responsibility. Fingerprints include path, original blob, finding kind, exact changed lines and coordinates, and nearby candidate context. Whole-file deletions use the original blob and mode; artifacts use their exact candidate blob. Expanding a hunk or adding a new condition creates new debt. Unrelated nearby edits or shifts may conservatively reopen an allowance; reviewers must recheck it rather than broadening it. Unmatched entries remain visible in the report.

```sh
node scripts/scient-divergence-inventory.mjs \
  --upstream ca7df394ed8151fa77f856beefa90bc60a785d60 \
  --candidate FULL_40_CHARACTER_COMMIT_OR_TREE_ID \
  --baseline reviewed-debt.json --as-of 2026-10-05 --ratchet
```

The explicit date makes expiry deterministic. Missing rationale/owner/review record, duplicate fingerprints, a mismatched upstream, or invalid/expired dates make the inventory unavailable. Baselines cannot waive parser errors, malformed pairs, unknown languages, or unresolved encodings/diffs.

Reports distinguish `marked`, `new-debt`, `reviewed-historical-debt`, and `unresolved`. Advisory mode exits 0 for a completed inventory even when it reports debt. `--ratchet` exits 1 for new debt or unresolved findings, and 2 for unavailable inputs or an invalid baseline. Its only clean claim is `no-new-debt-within-declared-scope`; reviewed historical debt stays visible. This is not a universal ownership, preservation, or release gate. CI activation requires independent tool review and final composed debt triage.

Focused regressions run independently of Vitest:

```sh
node --test scripts/scient-divergence-inventory.node-test.mjs
```

During concurrent alignment work, run installs, tests, formatting, lint, and hooks through the coordinator's shared check scheduler.
