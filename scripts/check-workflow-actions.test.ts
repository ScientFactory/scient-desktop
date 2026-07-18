import { assert, describe, it } from "@effect/vitest";

import { findWorkflowActionViolations } from "./check-workflow-actions.ts";

describe("immutable workflow actions", () => {
  it("accepts local, digest-pinned container, and full-SHA action references", () => {
    assert.deepEqual(
      findWorkflowActionViolations([
        {
          path: ".github/workflows/quality.yml",
          contents: `jobs:\n  quality:\n    steps:\n      - uses: actions/checkout@${"a".repeat(40)}\n      - uses: ./.github/actions/setup\n      - uses: docker://alpine@sha256:${"b".repeat(64)}\n`,
        },
      ]),
      [],
    );
  });

  it("rejects mutable references in parsed inline and anchored YAML", () => {
    assert.deepEqual(
      findWorkflowActionViolations([
        {
          path: ".github/workflows/quality.yml",
          contents:
            "jobs:\n  quality:\n    steps:\n      - { uses: actions/checkout@v7 }\n      - uses: &setup actions/setup-node@main\n",
        },
      ]),
      [
        {
          path: ".github/workflows/quality.yml",
          message: "external action is not pinned to a full commit SHA: actions/checkout@v7",
        },
        {
          path: ".github/workflows/quality.yml",
          message: "external action is not pinned to a full commit SHA: actions/setup-node@main",
        },
      ],
    );
  });

  it("rejects container action tags without an immutable digest", () => {
    assert.deepEqual(
      findWorkflowActionViolations([
        {
          path: ".github/workflows/quality.yml",
          contents: "jobs:\n  quality:\n    steps:\n      - uses: docker://alpine:3.22\n",
        },
      ]),
      [
        {
          path: ".github/workflows/quality.yml",
          message: "container action is not pinned to a sha256 digest: docker://alpine:3.22",
        },
      ],
    );
  });

  it("requires Docker-based local actions to pin their image digest", () => {
    assert.deepEqual(
      findWorkflowActionViolations([
        {
          path: ".github/actions/container/action.yml",
          contents: "runs:\n  using: docker\n  image: docker://alpine:3.22\n",
        },
      ]),
      [
        {
          path: ".github/actions/container/action.yml",
          message: "container action is not pinned to a sha256 digest: docker://alpine:3.22",
        },
      ],
    );
  });

  it("matches Docker action syntax case-insensitively like the runner", () => {
    assert.lengthOf(
      findWorkflowActionViolations([
        {
          path: ".github/actions/container/action.yml",
          contents: "runs:\n  using: Docker\n  image: DOCKER://alpine:3.22\n",
        },
      ]),
      1,
    );
  });

  it("rejects local actions outside the recursively scanned action directory", () => {
    assert.deepEqual(
      findWorkflowActionViolations([
        {
          path: ".github/workflows/quality.yml",
          contents: "jobs:\n  quality:\n    steps:\n      - uses: ./ci/setup\n",
        },
      ]),
      [
        {
          path: ".github/workflows/quality.yml",
          message:
            "local reference must live under the recursively scanned .github/actions directory: ./ci/setup",
        },
      ],
    );
  });

  it("rejects a local action path that escapes the scanned directory", () => {
    assert.lengthOf(
      findWorkflowActionViolations([
        {
          path: ".github/workflows/quality.yml",
          contents:
            "jobs:\n  quality:\n    steps:\n      - uses: ./.github/actions/../../ci/setup\n",
        },
      ]),
      1,
    );
  });

  it("accepts local reusable workflows and ignores unrelated uses fields", () => {
    assert.deepEqual(
      findWorkflowActionViolations([
        {
          path: ".github/workflows/quality.yml",
          contents:
            "env:\n  uses: ubuntu-latest\njobs:\n  call:\n    uses: ./.github/workflows/reusable.yml\n",
        },
      ]),
      [],
    );
  });
});
