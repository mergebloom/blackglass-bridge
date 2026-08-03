export type ReleaseStageResumeDecision = "run-new" | "resume" | "revalidate";
export type ReleaseStageOutputPresence = "missing" | "partial" | "complete";

export function releaseStageResumeDecision(input: {
  hasReceipt: boolean;
  revalidateOnResume: boolean;
}): ReleaseStageResumeDecision {
  if (!input.hasReceipt) return "run-new";
  return input.revalidateOnResume ? "revalidate" : "resume";
}

export function releaseUnboundOutputDecision(input: {
  presence: ReleaseStageOutputPresence;
  rebuildsExistingOutputs: boolean;
}): "run" | "reject" {
  if (input.presence === "missing") return "run";
  if (input.presence === "complete" && input.rebuildsExistingOutputs) return "run";
  return "reject";
}
