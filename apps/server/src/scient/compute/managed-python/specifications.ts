export const MANAGED_PYTHON_SPECIFICATIONS = [
  { purpose: "python", relativeDirectory: "." },
  { purpose: "matlab-connection", relativeDirectory: "matlab-connection" },
] as const;

export type ManagedPythonPurpose = (typeof MANAGED_PYTHON_SPECIFICATIONS)[number]["purpose"];

export function managedPythonSpecificationDirectory(purpose: ManagedPythonPurpose): string {
  return (
    MANAGED_PYTHON_SPECIFICATIONS.find((specification) => specification.purpose === purpose)
      ?.relativeDirectory ?? "."
  );
}
