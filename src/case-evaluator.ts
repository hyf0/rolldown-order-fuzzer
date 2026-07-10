import { deriveCoverageTags, type GeneratedCase } from "./generate.ts";
import type { ProgramModel } from "./model.ts";
import {
  DEFAULT_CASE_SIZE,
  executeGeneratedCase,
  type CampaignOptions,
  type CampaignVerdict,
} from "./program-run.ts";

/// The minimal build inputs needed to evaluate ONE program: which Rolldown to build with and the wrap
/// mode. Everything else the campaign runner threads (seed, template, coverage, case count, output
/// directory, cosmetic size) is irrelevant to running a single loaded model.
export interface CaseEvaluationOptions {
  readonly rolldownPackage: string;
  readonly onDemandWrapping: boolean;
}

/// Evaluate one program end-to-end — render, run the source under Node, build it with Rolldown, run the
/// bundle, and classify the differential verdict — returning the structured verdict. This is the seam
/// BELOW the campaign/CLI layer: the shrinker calls it to replay a loaded model instead of fabricating
/// a `GeneratedCase` and a full `CampaignOptions` merely to reach the evaluator. The execution
/// primitives now live in `program-run.ts` (below `main.ts`), so this seam no longer imports the
/// campaign/CLI layer at all.
export async function evaluateProgram(
  program: ProgramModel,
  options: CaseEvaluationOptions,
): Promise<CampaignVerdict> {
  const generated: GeneratedCase = {
    seed: 0,
    size: DEFAULT_CASE_SIZE,
    template: "random-mixed",
    coverageTags: deriveCoverageTags(program),
    program,
  };
  const campaignOptions: CampaignOptions = {
    seed: 0,
    cases: 1,
    caseSize: DEFAULT_CASE_SIZE,
    // A loaded model replays as-is; the size mix is cosmetic here.
    sizeMix: false,
    onDemandWrapping: options.onDemandWrapping,
    rolldownPackage: options.rolldownPackage,
    outDir: "failures",
    continueOnFail: false,
  };
  const result = await executeGeneratedCase(generated, campaignOptions);
  return result.verdict;
}

/// The failure signature of a program, or `undefined` when it passes.
export async function failureSignatureOf(
  program: ProgramModel,
  options: CaseEvaluationOptions,
): Promise<string | undefined> {
  const verdict = await evaluateProgram(program, options);
  return verdict.kind === "pass" ? undefined : verdict.signature;
}
