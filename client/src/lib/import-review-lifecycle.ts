/** One review decision, released on abort; stale callbacks cannot revive a run. */
export function reviewDecision<T>(signal: AbortSignal) {
  let finish!: (value: T | "cancelled") => void;
  let done = false;
  const promise = new Promise<T | "cancelled">(resolve => { finish = resolve; });
  const settle = (value: T | "cancelled") => {
    if (done) return;
    done = true;
    signal.removeEventListener("abort", abort);
    finish(value);
  };
  const abort = () => settle("cancelled");
  if (signal.aborted) abort();
  else signal.addEventListener("abort", abort, { once: true });
  return { promise, settle };
}

/** Synchronous admission gate; kept until rollback and OCR shutdown finish. */
export function importRunGate() {
  let active: AbortController | null = null;
  return {
    start() { if (active) return null; active = new AbortController(); return active; },
    cancel() { active?.abort(); },
    finish(run: AbortController) { if (active === run) active = null; },
  };
}

/** Release orchestration even if a view disappears without completing its callback. */
export async function awaitImportReview<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T | "cancelled"> {
  const cancellation = reviewDecision<T>(signal);
  if (signal.aborted) return "cancelled";
  try { return await Promise.race([work(), cancellation.promise]); }
  finally { cancellation.settle("cancelled"); }
}
