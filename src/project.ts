export interface ProjectStatus {
  readonly name: string;
  readonly phase: "mvp";
  readonly runtime: "node-native-typescript";
  readonly contextRecords: readonly string[];
}

export const projectStatus: ProjectStatus = {
  name: "rolldown-order-fuzzer",
  phase: "mvp",
  runtime: "node-native-typescript",
  contextRecords: [
    ".agents/docs/legacy-fuzzer-behavior.md",
    ".agents/docs/redesign-principles.md",
    ".agents/docs/vite-plus-adoption.md",
    ".agents/docs/execution-order-fuzzer-mvp.md",
    ".agents/docs/execution-order-fuzzer-mvp-plan.md",
  ],
};
