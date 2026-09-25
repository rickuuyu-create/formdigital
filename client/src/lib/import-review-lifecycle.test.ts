import { describe, expect, it, vi } from "vitest";
import { importRunGate, reviewDecision } from "./import-review-lifecycle";

describe("review lifetime", () => {
  it("an already aborted signal settles immediately", async () => {
    const run = new AbortController(); run.abort();
    const decision = reviewDecision<string[]>(run.signal);
    await expect(decision.promise).resolves.toBe("cancelled");
    decision.settle(["late"]);
    await expect(decision.promise).resolves.toBe("cancelled");
  });
  it.each(["abort", "confirm"])("%s removes its listener and settles exactly once", async kind => {
    const run = new AbortController();
    const add = vi.spyOn(run.signal, "addEventListener"), remove = vi.spyOn(run.signal, "removeEventListener");
    const decision = reviewDecision<string[]>(run.signal); const observe = vi.fn(); decision.promise.then(observe);
    if (kind === "abort") run.abort(); else decision.settle(["saved"]);
    decision.settle(["late"]); run.abort(); await decision.promise;
    expect(observe).toHaveBeenCalledTimes(1); expect(add).toHaveBeenCalledTimes(1); expect(remove).toHaveBeenCalledTimes(1);
    expect(remove.mock.calls[0][1]).toBe(add.mock.calls[0][1]);
  });
  it("rejects double start until rollback/shutdown finishes, ignores stale finish", () => {
    const gate = importRunGate(); const first = gate.start()!;
    expect(gate.start()).toBeNull(); gate.cancel(); expect(first.signal.aborted).toBe(true);
    expect(gate.start()).toBeNull(); gate.finish(first); const second = gate.start()!;
    gate.finish(first); expect(gate.start()).toBeNull(); expect(second.signal.aborted).toBe(false);
    gate.finish(second); expect(gate.start()).not.toBeNull();
  });
});
