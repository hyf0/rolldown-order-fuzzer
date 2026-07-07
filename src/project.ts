export interface ProjectStatus {
  readonly name: string;
  readonly phase: "redesign";
  readonly runtime: "node-native-typescript";
  readonly contextRecords: readonly string[];
}

export const projectStatus: ProjectStatus = {
  name: "rolldown-order-fuzzer",
  phase: "redesign",
  runtime: "node-native-typescript",
  contextRecords: [
    ".agents/docs/legacy-fuzzer-behavior.md",
    ".agents/docs/redesign-principles.md",
    ".agents/docs/vite-plus-adoption.md",
  ],
};
