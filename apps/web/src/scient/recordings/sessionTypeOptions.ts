import { useGT } from "gt-react";

export function useSessionTypeOptions() {
  const gt = useGT();
  return [
    { value: "lecture", label: gt("Lecture") },
    { value: "meeting", label: gt("Meeting") },
    { value: "interview", label: gt("Interview") },
  ];
}
