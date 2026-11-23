import {
  notebookParameters,
  notebookOverrideAllowed,
  notebookParameterJson,
  parseNotebookOverride,
} from "@t3tools/shared/notebookParameters";
import { T, useGT, Var } from "gt-react";
import { useStore } from "zustand";

import { Input } from "~/components/ui/input";
import { NativeSelect } from "~/components/ui/select";
import type { NotebookController } from "./notebookController";

type Parameter = ReturnType<typeof notebookParameters>[number];

export function useNotebookParameters(controller: NotebookController) {
  const cell = useStore(controller.store, (state) => {
    const cellId = state.order.find((id) => state.cells[id]?.parameterCell);
    return cellId === undefined ? undefined : state.cells[cellId];
  });
  const language = useStore(controller.store, (state) => state.language);
  return {
    parameters: notebookParameters(cell, language),
    saved: cell?.savedParameters,
    mismatch: cell?.parameterEvidenceMismatch,
  };
}

export function validNotebookParameter(parameter: Parameter, input: string): string | null {
  const value = parseNotebookOverride(input);
  if (value === undefined || !notebookOverrideAllowed(parameter, value)) return null;
  return notebookParameterJson(parameter, value);
}

function defaultParameterInput(parameter: Parameter) {
  if (parameter.value === undefined) return undefined;
  return parameter.defaultJson ?? notebookParameterJson(parameter, parameter.value);
}

export function notebookParameterChanged(
  parameter: Parameter,
  input: string | undefined,
  previous: string | undefined,
) {
  if (input === undefined || parameter.value === undefined) return false;
  const baseline = previous ?? defaultParameterInput(parameter);
  if (baseline === undefined || input === baseline) return false;
  const value = validNotebookParameter(parameter, input);
  return value === null || value !== validNotebookParameter(parameter, baseline);
}

function ParameterControl(props: {
  readonly parameter: Parameter;
  readonly input: string | undefined;
  readonly disabled?: boolean | undefined;
  readonly onChange: (input: string) => void;
}) {
  const gt = useGT();
  const { parameter, input, onChange } = props;
  const { value, name, control } = parameter;
  if (value === undefined) {
    return (
      <span className="text-muted-foreground">
        <T>Set by code</T>
      </span>
    );
  }
  const json = input ?? defaultParameterInput(parameter) ?? "";
  if (control !== undefined && "options" in control) {
    const options = new Map(
      [value, ...control.options].map((option) => [
        notebookParameterJson(parameter, option),
        typeof option === "string" ? option : notebookParameterJson(parameter, option),
      ]),
    );
    if (!options.has(json)) options.set(json, json);
    return (
      <NativeSelect
        aria-label={name}
        disabled={props.disabled}
        size="compact"
        value={json}
        onChange={(event) => onChange(event.target.value)}
      >
        {[...options].map(([key, label]) => (
          <option key={key} value={key}>
            {label}
          </option>
        ))}
      </NativeSelect>
    );
  }
  if (control !== undefined && "min" in control) {
    return (
      <div className="flex min-h-7 items-center gap-3">
        <input
          aria-label={name}
          disabled={props.disabled}
          className="w-32 min-w-0 rounded-sm accent-primary focus-visible:outline-1 focus-visible:outline-ring"
          type="range"
          min={control.min}
          max={control.max}
          step={control.step}
          value={json}
          onChange={(event) =>
            onChange(notebookParameterJson(parameter, event.target.valueAsNumber))
          }
        />
        <span className="tabular-nums">{json}</span>
      </div>
    );
  }
  if (typeof value === "boolean") {
    return (
      <NativeSelect
        aria-label={name}
        disabled={props.disabled}
        size="compact"
        value={json}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="true">{gt("True")}</option>
        <option value="false">{gt("False")}</option>
      </NativeSelect>
    );
  }
  const shown = typeof value === "string" ? (parseNotebookOverride(json) ?? json) : json;
  return (
    <Input
      aria-label={name}
      disabled={props.disabled}
      aria-invalid={validNotebookParameter(parameter, json) === null}
      size="compact"
      inputMode={typeof value === "number" ? "decimal" : "text"}
      value={String(shown)}
      onChange={(event) =>
        onChange(
          typeof value === "string" ? JSON.stringify(event.target.value) : event.target.value,
        )
      }
    />
  );
}

export function NotebookParameterControls(props: {
  readonly parameters: ReadonlyArray<Parameter>;
  readonly pending: Readonly<Record<string, string>>;
  readonly saved?: Readonly<Record<string, string>> | undefined;
  readonly onChange: (name: string, value: string) => void;
  readonly mismatch?: boolean | undefined;
  readonly disabled?: boolean | undefined;
}) {
  return (
    <section aria-label={useGT()("Parameters")} className="@container/parameters">
      <div className="flex flex-wrap items-start gap-3 px-4 py-2">
        {props.parameters.map((parameter) => {
          const input = Object.hasOwn(props.pending, parameter.name)
            ? props.pending[parameter.name]
            : undefined;
          const saved = Object.hasOwn(props.saved ?? {}, parameter.name)
            ? props.saved?.[parameter.name]
            : undefined;
          return (
            <div
              className="flex min-w-0 max-w-full flex-col gap-1 @[30rem]/parameters:flex-row @[30rem]/parameters:items-center @[30rem]/parameters:gap-3"
              key={parameter.name}
            >
              <span className="wrap-anywhere text-sm font-medium" dir="auto">
                {parameter.name}
              </span>
              <div className="min-w-0 max-w-full text-xs tabular-nums">
                <ParameterControl
                  parameter={parameter}
                  input={input}
                  disabled={props.disabled}
                  onChange={(value) => props.onChange(parameter.name, value)}
                />
              </div>
              {saved !== undefined &&
              notebookParameterChanged(
                parameter,
                input ?? defaultParameterInput(parameter),
                saved,
              ) ? (
                <span className="text-xs text-muted-foreground tabular-nums">
                  <T>
                    Last run used <Var>{saved}</Var>
                  </T>
                </span>
              ) : null}
            </div>
          );
        })}
      </div>
      {props.mismatch ? (
        <p role="status" className="px-4 pb-2 text-xs text-muted-foreground">
          <T>The saved parameter record differs from the injected code.</T>
        </p>
      ) : props.parameters.some((parameter) => parameter.value === undefined) ? (
        <p className="px-4 pb-2 text-xs text-muted-foreground">
          <T>Values calculated in the parameters cell use its defaults, before overrides apply.</T>
        </p>
      ) : null}
    </section>
  );
}
