/**
 * The agent's `ask` tool over RPC: one `extension_ui_request` carrying every
 * question of a call, answered by one `extension_ui_response`.
 */
import { isRecord } from "effect-omp-rpc/schema";

export interface OmpAskOption {
  /** The exact label the agent expects back. */
  readonly value: string;
  readonly label: string;
  readonly description: string;
  readonly preview?: string;
}

export interface OmpAskQuestion {
  readonly id: string;
  readonly header?: string;
  readonly question: string;
  readonly options: ReadonlyArray<OmpAskOption>;
  readonly multiSelect: boolean;
}

export interface OmpAskAnswer {
  readonly id: string;
  readonly selectedOptions: ReadonlyArray<string>;
  readonly customInput?: string;
}

const nonEmpty = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value : undefined;

const askOption = (value: unknown, recommended: boolean): OmpAskOption | undefined => {
  if (!isRecord(value)) return undefined;
  const label = nonEmpty(value.label);
  if (label === undefined) return undefined;
  const preview = nonEmpty(value.preview);
  return {
    value: label,
    label: recommended ? `${label} (Recommended)` : label,
    description: nonEmpty(value.description) ?? "",
    ...(preview === undefined ? {} : { preview }),
  };
};

const askQuestion = (value: unknown): OmpAskQuestion | undefined => {
  if (!isRecord(value)) return undefined;
  const id = nonEmpty(value.id);
  const question = nonEmpty(value.question);
  if (id === undefined || question === undefined || !Array.isArray(value.options)) return undefined;
  const options = value.options.map((option, index) =>
    askOption(option, index === value.recommended),
  );
  if (options.some((option) => option === undefined)) return undefined;
  const header = nonEmpty(value.header);
  return {
    id,
    ...(header === undefined ? {} : { header }),
    question,
    options: options.filter((option) => option !== undefined),
    multiSelect: value.multi === true,
  };
};

/** Every question of a request, or none: an answer must cover them all. */
export const ompAskQuestions = (value: unknown): ReadonlyArray<OmpAskQuestion> => {
  if (!Array.isArray(value)) return [];
  const questions = value.map(askQuestion);
  return questions.some((question) => question === undefined)
    ? []
    : questions.filter((question) => question !== undefined);
};

/**
 * Sorts each answer into offered options and free text. Undefined when a
 * single-choice question has no answer, which the agent treats as a failed call.
 */
export const ompAskAnswers = (
  questions: ReadonlyArray<OmpAskQuestion>,
  answers: Readonly<Record<string, unknown>>,
): ReadonlyArray<OmpAskAnswer> | undefined => {
  const result: Array<OmpAskAnswer> = [];
  for (const question of questions) {
    const answer = answers[question.id];
    const values = (Array.isArray(answer) ? answer : [answer]).filter(
      (value): value is string => typeof value === "string" && value.trim().length > 0,
    );
    const offered = new Set(question.options.map((option) => option.value));
    const selected = [...new Set(values.filter((value) => offered.has(value)))];
    const typed = values.filter((value) => !offered.has(value)).join(", ");
    if (!question.multiSelect && selected.length === 0 && typed.length === 0) return undefined;
    result.push(
      !question.multiSelect && selected.length > 0
        ? { id: question.id, selectedOptions: selected.slice(0, 1) }
        : {
            id: question.id,
            selectedOptions: selected,
            ...(typed.length === 0 ? {} : { customInput: typed }),
          },
    );
  }
  return result;
};
