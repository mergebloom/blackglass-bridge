import type { EventEmitter } from "node:events";

export type TerminationSignal = "SIGINT" | "SIGTERM";

type SignalSource = Pick<EventEmitter, "on" | "off">;

type SupervisedChild = {
  readonly exitCode: number | null;
  kill(signal: TerminationSignal | "SIGKILL"): void;
};

export function superviseTerminationSignals(
  child: SupervisedChild,
  options: {
    signalSource?: SignalSource;
    escalationDelayMs?: number;
  } = {},
): { dispose(): void } {
  const signalSource = options.signalSource ?? process;
  const escalationDelayMs = options.escalationDelayMs ?? 10_000;
  if (!Number.isSafeInteger(escalationDelayMs) || escalationDelayMs < 1) {
    throw new Error("Termination escalation delay must be a positive integer");
  }

  let forwarded = false;
  let escalation: ReturnType<typeof setTimeout> | undefined;
  const forward = (signal: TerminationSignal): void => {
    if (forwarded) return;
    forwarded = true;
    child.kill(signal);
    escalation = setTimeout(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
    }, escalationDelayMs);
    escalation.unref?.();
  };
  const onSigint = (): void => forward("SIGINT");
  const onSigterm = (): void => forward("SIGTERM");
  signalSource.on("SIGINT", onSigint);
  signalSource.on("SIGTERM", onSigterm);

  return {
    dispose(): void {
      signalSource.off("SIGINT", onSigint);
      signalSource.off("SIGTERM", onSigterm);
      if (escalation) clearTimeout(escalation);
    },
  };
}
