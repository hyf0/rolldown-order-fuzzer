import type { ProgramModel } from "./model.ts";
import {
  executeProgram,
  type CampaignVerdict,
  type MinimalExecutionOptions,
} from "./program-run.ts";

/// The minimal build inputs needed to evaluate ONE program: which Rolldown to build with and the wrap
/// mode. Everything else the campaign runner threads (seed, template, coverage, case count, output
/// directory, cosmetic size) is irrelevant to running a single loaded model — so this is exactly the
/// `program-run.ts` minimal execution options.
export type CaseEvaluationOptions = MinimalExecutionOptions;

/// Evaluate one program end-to-end — render, run the source under Node, build it with Rolldown, run the
/// bundle, and classify the differential verdict — returning the structured verdict. It wraps the
/// `program-run.ts` `executeProgram` seam directly, so the shrinker no longer fabricates a `GeneratedCase`
/// and a full `CampaignOptions` merely to replay a loaded model.
export async function evaluateProgram(
  program: ProgramModel,
  options: CaseEvaluationOptions,
): Promise<CampaignVerdict> {
  const run = await executeProgram(program, options);
  return run.verdict;
}

/// The failure signature of a program, or `undefined` when it passes.
export async function failureSignatureOf(
  program: ProgramModel,
  options: CaseEvaluationOptions,
): Promise<string | undefined> {
  const verdict = await evaluateProgram(program, options);
  return verdict.kind === "pass" ? undefined : verdict.signature;
}
