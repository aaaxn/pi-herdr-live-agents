import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.js";
import type { HerdrClient } from "../src/herdr.js";
import { RootRuntime } from "../src/root.js";
import { PROTOCOL_VERSION, type RunRecord, type RunResult } from "../src/types.js";

describe("RootRuntime waits", () => {
  it("does not mark partial wait-all results delivered before the whole wait resolves", async () => {
    const runtime = createRuntime();
    const firstRun = runRecord("run-a", "shared-name", "done", "result-a");
    const secondRun = runRecord("run-b", "shared-name", "working");
    const firstResult = result(firstRun, "result-a", "first");
    const secondResult = result(secondRun, "result-b", "second");
    vi.spyOn(runtime.manager, "getRun").mockImplementation((target) => {
      if (target === "old" || target === firstRun.runId) return firstRun;
      if (target === "new" || target === secondRun.runId) return secondRun;
      throw new Error(`unknown ${target}`);
    });
    vi.spyOn(runtime.manager, "latestResult").mockImplementation((target) =>
      target === firstRun.runId ? firstResult : undefined,
    );
    vi.spyOn(runtime.manager, "list").mockImplementation(() => [summary(firstRun, false), summary(secondRun, true)]);
    const markDelivered = vi.spyOn(runtime.manager, "markDelivered").mockImplementation(() => {});

    const waiting = runtime.waitAll(["old", "new"]);
    expect(markDelivered).not.toHaveBeenCalled();

    exposePrivate(runtime).handleResult(secondRun, secondResult);
    const responses = await waiting;

    expect(responses.map((entry) => entry.run_id)).toEqual([firstRun.runId, secondRun.runId]);
    expect(markDelivered).toHaveBeenCalledWith(firstRun.runId, firstResult.resultId);
    expect(markDelivered).toHaveBeenCalledWith(secondRun.runId, secondResult.resultId);
  });

  it("releases partial results for automatic delivery when wait-all is aborted", async () => {
    const sendMessage = vi.fn();
    const runtime = createRuntime(sendMessage);
    const firstRun = runRecord("run-a", "first", "done", "result-a");
    const secondRun = runRecord("run-b", "second", "working");
    const firstResult = result(firstRun, "result-a", "first response");
    vi.spyOn(runtime.manager, "getRun").mockImplementation((target) =>
      target === firstRun.runId ? firstRun : secondRun,
    );
    vi.spyOn(runtime.manager, "latestResult").mockImplementation((target) =>
      target === firstRun.runId ? firstResult : undefined,
    );
    vi.spyOn(runtime.manager, "isDelivered").mockReturnValue(false);
    vi.spyOn(runtime.manager, "list").mockImplementation(() => [summary(firstRun, false), summary(secondRun, true)]);
    vi.spyOn(runtime.manager, "markDelivered").mockImplementation(() => {});
    const abort = new AbortController();

    const waiting = runtime.waitAll([firstRun.runId, secondRun.runId], abort.signal);
    abort.abort();

    await expect(waiting).rejects.toThrow("Aborted");
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("first response") }),
      expect.anything(),
    );
  });

  it("fails fast instead of hanging when no delegated work is pending", async () => {
    const runtime = createRuntime();
    const idle = runRecord("run-idle", "idle-agent", "idle", "result-old");
    const idleSummary = { ...summary(idle, false), result_delivered: true };
    vi.spyOn(runtime.manager, "getRun").mockImplementation(() => idle);
    vi.spyOn(runtime.manager, "list").mockImplementation(() => [idleSummary]);
    vi.spyOn(runtime.manager, "latestResult").mockImplementation(() => result(idle, "result-old", "old"));

    await expect(runtime.waitOne(undefined)).rejects.toThrow("nothing can complete");
    await expect(runtime.waitAll(undefined)).resolves.toEqual([]);
  });

  it("does not return a stale result while a new delegated turn is pending", async () => {
    const runtime = createRuntime();
    const run = runRecord("run-stale", "stale-agent", "done", "result-old");
    vi.spyOn(runtime.manager, "getRun").mockImplementation(() => run);
    vi.spyOn(runtime.manager, "list").mockImplementation(() => [summary(run, true)]);
    const latestResult = vi.spyOn(runtime.manager, "latestResult");

    const waiting = runtime.waitOne([run.runId]);
    const fresh = result(run, "result-new", "fresh response");
    exposePrivate(runtime).handleResult(run, fresh);

    await expect(waiting).resolves.toMatchObject({ result_id: "result-new", response: "fresh response" });
    expect(latestResult).not.toHaveBeenCalled();
  });

  it("rejects empty target arrays instead of waiting forever", async () => {
    const runtime = createRuntime();
    await expect(runtime.waitOne([])).rejects.toThrow("targets must not be empty");
    await expect(runtime.waitAll([])).rejects.toThrow("targets must not be empty");
  });

  it("rejects a targeted waiter when its pane closes without a result", async () => {
    const runtime = createRuntime();
    const run = runRecord("run-closed", "closed-agent", "working");
    vi.spyOn(runtime.manager, "getRun").mockImplementation(() => run);
    vi.spyOn(runtime.manager, "list").mockImplementation(() => [summary(run, true)]);

    const waiting = runtime.waitOne([run.runId]);
    run.status = "closed";
    exposePrivate(runtime).handleManagerChange();

    await expect(waiting).rejects.toThrow("closed without a result");
  });
});

function createRuntime(sendMessage = vi.fn()): RootRuntime {
  const pi = {
    sendMessage,
    getThinkingLevel: () => "high",
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd: "/repo",
    mode: "rpc",
    isIdle: () => true,
    sessionManager: {
      getSessionId: () => "parent-session",
      getSessionFile: () => "/tmp/parent.jsonl",
    },
  } as unknown as ExtensionContext;
  return new RootRuntime(pi, ctx, DEFAULT_CONFIG, {} as HerdrClient, "parent-pane");
}

function exposePrivate(runtime: RootRuntime): {
  handleResult(run: RunRecord, result: RunResult): void;
  handleManagerChange(): void;
} {
  return runtime as unknown as {
    handleResult(run: RunRecord, result: RunResult): void;
    handleManagerChange(): void;
  };
}

function runRecord(
  runId: string,
  taskName: string,
  status: RunRecord["status"],
  latestResultId?: string,
): RunRecord {
  return {
    version: PROTOCOL_VERSION,
    runId,
    taskName,
    parentSessionId: "parent-session",
    cwd: "/repo",
    capabilityToken: `token-${runId}`,
    provider: "openai",
    model: "gpt-test",
    herdrAgentName: `sa-${runId}`,
    status,
    ...(latestResultId ? { latestResultId } : {}),
    deliveredResultIds: [],
    createdAt: 1,
    updatedAt: 1,
  };
}

function summary(run: RunRecord, awaiting: boolean) {
  return {
    agent_name: run.taskName,
    run_id: run.runId,
    agent_status: run.status,
    provider: run.provider,
    model: run.model,
    created_at: run.createdAt,
    updated_at: run.updatedAt,
    ...(run.latestResultId ? { latest_result_id: run.latestResultId } : {}),
    result_delivered: false,
    awaiting_result: awaiting,
  };
}

function result(run: RunRecord, resultId: string, response: string): RunResult {
  return {
    version: PROTOCOL_VERSION,
    type: "result",
    resultId,
    runId: run.runId,
    capabilityToken: run.capabilityToken,
    source: "linked-turn",
    status: "done",
    response,
    createdAt: 2,
  };
}
