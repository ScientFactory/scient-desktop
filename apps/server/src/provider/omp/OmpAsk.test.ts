import { describe, expect, it } from "vite-plus/test";

import { ompAskAnswers, ompAskQuestions } from "./OmpAsk.ts";

const questions = ompAskQuestions([
  {
    id: "db",
    question: "Which database?",
    options: [{ label: "Postgres" }, { label: "SQLite", description: "Local" }],
    recommended: 1,
  },
  { id: "features", question: "Which features?", options: [{ label: "Auth" }], multi: true },
]);

describe("ompAskQuestions", () => {
  it("keeps the agent's label as the answer and marks the recommended option", () => {
    expect(questions[0]?.options[1]).toEqual({
      value: "SQLite",
      label: "SQLite (Recommended)",
      description: "Local",
    });
  });

  it("refuses a request with any malformed question", () => {
    expect(ompAskQuestions([{ id: "db", question: "Which?", options: [] }, { id: "x" }])).toEqual(
      [],
    );
  });
});

describe("ompAskAnswers", () => {
  it("sorts offered options from free text", () => {
    expect(ompAskAnswers(questions, { db: "DuckDB", features: ["Auth", "Search"] })).toEqual([
      { id: "db", selectedOptions: [], customInput: "DuckDB" },
      { id: "features", selectedOptions: ["Auth"], customInput: "Search" },
    ]);
  });

  it("allows an empty multi-select but not an unanswered single choice", () => {
    expect(ompAskAnswers(questions, { db: "SQLite" })).toEqual([
      { id: "db", selectedOptions: ["SQLite"] },
      { id: "features", selectedOptions: [] },
    ]);
    expect(ompAskAnswers(questions, { features: ["Auth"] })).toBeUndefined();
  });
});
