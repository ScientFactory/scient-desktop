import { useGT, useLocale } from "gt-react";

import { capturedAt, fileName } from "./recordingTypes";

/**
 * A recording's name: the one the person gave it, the time Scient recorded it, or its file name
 * without the extension.
 */
export function useRecordingTitle() {
  const gt = useGT();
  const time = new Intl.DateTimeFormat(useLocale(), { timeStyle: "short" });
  return (source: string, title?: string) => {
    if (title) return title;
    const at = capturedAt(source);
    if (at) return gt("Recording {time}", { time: time.format(at) });
    const name = fileName(source);
    return name.replace(/(?<=.)\.[^.]{1,5}$/, "");
  };
}
