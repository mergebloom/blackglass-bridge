export type ReleaseStageResumeDecision = "run-new" | "resume" | "revalidate";

export function releaseStageResumeDecision(input: {
  hasReceipt: boolean;
  revalidateOnResume: boolean;
}): ReleaseStageResumeDecision {
  if (!input.hasReceipt) return "run-new";
  return input.revalidateOnResume ? "revalidate" : "resume";
}
