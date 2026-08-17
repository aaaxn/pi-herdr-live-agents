import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.js";
import { HerdrCommandError } from "../src/herdr.js";
import { AgentManager, type HerdrPort } from "../src/manager.js";
import {
  createRunDirectory,
  listDispatches,
  listSessionRuns,
  writeAck,
  writeChildState,
  writeResult,
  writeRun,
} from "../src/storage.js";
import {
  PROTOCOL_VERSION,
  type HerdrAgent,
  type HerdrPane,
  type HerdrTab,
  type RunRecord,
  type RunResult,
} from "../src/types.js";

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-herdr-manager-"));
  process.env.PI_HERDR_SUBAGENTS_STORAGE_DIR = root;
});

afterEach(() => {
  delete process.env.PI_HERDR_SUBAGENTS_STORAGE_DIR;
  fs.rmSync(root, { recursive: true, force: true });
});

describe("AgentManager", () => {
  it("creates a readable sibling pane, starts Pi, and accepts the mailbox task", async () => {
    const herdr = new FakeHerdr();
    const changes: number[] = [];
    const results: RunResult[] = [];
    const manager = new AgentManager(
      herdr,
      DEFAULT_CONFIG,
      { sessionId: "parent-1", cwd: "/repo", paneId: "parent-pane" },
      {
        onChange: () => changes.push(Date.now()),
        onResult: (_run, result) => results.push(result),
        onBlocked: () => {},
      },
    );
    await manager.start();

    const receipt = await manager.spawn({
      taskName: "explore-auth",
      message: "Map the authentication flow.",
      inherited: { provider: "openai", model: "gpt-test", thinking: "high" },
    });

    expect(receipt.accepted).toBe(true);
    expect(receipt.pane_id).toBe("child-pane");
    expect(herdr.splitCalls).toEqual([
      expect.objectContaining({ sourcePaneId: "parent-pane", direction: "right", cwd: "/repo" }),
    ]);
    expect(herdr.splitCalls[0]?.env).toMatchObject({
      PI_HERDR_SUBAGENT: "1",
      PI_HERDR_SUBAGENT_PARENT_SESSION_ID: "parent-1",
    });
    expect(herdr.startedWith).toMatchObject({
      paneId: "child-pane",
      provider: "openai",
      model: "gpt-test",
      thinking: "high",
    });

    const stored = listSessionRuns("parent-1")[0]!;
    const result: RunResult = {
      version: PROTOCOL_VERSION,
      type: "result",
      resultId: "result-1",
      runId: stored.record.runId,
      capabilityToken: stored.record.capabilityToken,
      source: "linked-turn",
      status: "done",
      response: "Authentication uses signed sessions.",
      createdAt: Date.now(),
    };
    writeResult(stored.directory, result);

    await vi.waitFor(() => expect(results).toHaveLength(1));
    expect(manager.readResponse("explore-auth").response).toBe("Authentication uses signed sessions.");
    manager.markDelivered(stored.record.runId, result.resultId);
    expect(manager.list()[0]?.result_delivered).toBe(true);
    expect(changes.length).toBeGreaterThan(0);
    manager.stop();

    const recovered = new AgentManager(
      herdr,
      DEFAULT_CONFIG,
      { sessionId: "parent-1", cwd: "/repo", paneId: "parent-pane" },
      { onChange: () => {}, onResult: () => {}, onBlocked: () => {} },
    );
    await recovered.start();
    expect(recovered.list()[0]?.agent_status).toBe("done");
    recovered.stop();
  });

  it("can paginate an older result after a newer turn finishes", async () => {
    const herdr = new FakeHerdr();
    const manager = createManager(herdr);
    await manager.start();
    const receipt = await manager.spawn({
      taskName: "multi-turn",
      message: "Return twice.",
      inherited: { provider: "openai", model: "gpt-test" },
    });
    const stored = listSessionRuns("parent-1")[0]!;
    writeResult(stored.directory, {
      version: PROTOCOL_VERSION,
      type: "result",
      resultId: "older-result",
      runId: receipt.run_id,
      capabilityToken: stored.record.capabilityToken,
      source: "linked-turn",
      status: "done",
      response: "older response",
      createdAt: 1,
    });
    writeResult(stored.directory, {
      version: PROTOCOL_VERSION,
      type: "result",
      resultId: "newer-result",
      runId: receipt.run_id,
      capabilityToken: stored.record.capabilityToken,
      source: "linked-turn",
      status: "done",
      response: "newer response",
      createdAt: 2,
    });
    await vi.waitFor(() => expect(manager.getRun(receipt.run_id).latestResultId).toBe("newer-result"));

    expect(manager.readResponse(receipt.run_id, 0, 64 * 1024, "older-result")).toMatchObject({
      result_id: "older-result",
      response: "older response",
    });
    manager.stop();
  });

  it("reserves capacity atomically across concurrent spawns", async () => {
    const herdr = new FakeHerdr();
    const config = structuredClone(DEFAULT_CONFIG);
    config.limits.maxOpenPanes = 1;
    const manager = createManager(herdr, config);
    await manager.start();

    const outcomes = await Promise.allSettled([
      manager.spawn({ taskName: "first", message: "First task", inherited: { provider: "openai", model: "gpt-test" } }),
      manager.spawn({ taskName: "second", message: "Second task", inherited: { provider: "openai", model: "gpt-test" } }),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
    expect(herdr.splitCalls).toHaveLength(1);
    expect(manager.list()).toHaveLength(1);
    manager.stop();
  });

  it("waits for a freshly split pane to reach its shell prompt", async () => {
    const herdr = new FakeHerdr();
    herdr.busyStarts = 2;
    const manager = createManager(herdr);
    await manager.start();

    const receipt = await manager.spawn({
      taskName: "slow-shell",
      message: "Start once the shell is ready.",
      inherited: { provider: "openai", model: "gpt-test" },
    });

    expect(receipt.accepted).toBe(true);
    expect(herdr.startAttempts).toBe(3);
    manager.stop();
  });

  it("counts a spawn as active until the child acknowledges its first input", async () => {
    const herdr = new FakeHerdr();
    herdr.ackDelayMs = 250;
    const config = structuredClone(DEFAULT_CONFIG);
    config.limits.maxConcurrentAgents = 1;
    const manager = createManager(herdr, config);
    await manager.start();

    const first = manager.spawn({
      taskName: "slow-ack",
      message: "Acknowledge later.",
      inherited: { provider: "openai", model: "gpt-test" },
    });
    await vi.waitFor(() => expect(manager.list()[0]?.agent_status).toBe("idle"));
    await expect(
      manager.spawn({
        taskName: "over-limit",
        message: "Must be rejected.",
        inherited: { provider: "openai", model: "gpt-test" },
      }),
    ).rejects.toThrow("Concurrent agent limit reached");
    await first;
    manager.stop();
  });

  it("does not adopt a user tab that happens to use the agents label", async () => {
    const herdr = new FakeHerdr();
    herdr.parentWidth = 100;
    herdr.tabs.push({
      tab_id: "user-tab",
      workspace_id: "w1",
      label: "agents · rent-1",
      focused: false,
      agent_status: "idle",
    });
    herdr.addPane({
      pane_id: "user-pane",
      workspace_id: "w1",
      tab_id: "user-tab",
      focused: false,
      agent_status: "idle",
    });
    const config = structuredClone(DEFAULT_CONFIG);
    config.layout.minPaneHeight = 30;
    const manager = createManager(herdr, config);
    await manager.start();

    const receipt = await manager.spawn({
      taskName: "isolated",
      message: "Use an owned tab.",
      inherited: { provider: "openai", model: "gpt-test" },
    });

    expect(herdr.splitCalls).toHaveLength(0);
    expect(herdr.createTabCalls).toHaveLength(1);
    expect(receipt.tab_id).toBe("owned-tab-1");
    expect(listSessionRuns("parent-1")[0]?.record.placement).toBe("agents-tab");
    manager.stop();
  });

  it("does not reopen a closed run from stale child state during recovery", async () => {
    const herdr = new FakeHerdr();
    const manager = createManager(herdr);
    await manager.start();
    const receipt = await manager.spawn({
      taskName: "closed-recovery",
      message: "Finish and remain recorded.",
      inherited: { provider: "openai", model: "gpt-test" },
    });
    await manager.close(receipt.run_id, { force: true });
    const stored = listSessionRuns("parent-1")[0]!;
    writeChildState(stored.directory, {
      version: PROTOCOL_VERSION,
      runId: stored.record.runId,
      capabilityToken: stored.record.capabilityToken,
      seq: 99,
      status: "working",
      updatedAt: Date.now(),
    });
    manager.stop();

    const recovered = createManager(herdr);
    await recovered.start();
    expect(recovered.list()[0]?.agent_status).toBe("closed");
    recovered.stop();
  });

  it("keeps per-run retention when another project performs global cleanup", async () => {
    const foreign = runRecord({
      runId: "foreign-run",
      taskName: "foreign",
      parentSessionId: "parent-2",
      status: "closed",
      closedAt: Date.now() - 10 * 24 * 60 * 60 * 1000,
      retention: { deliveredDays: 100, undeliveredDays: 100 },
    });
    const foreignDirectory = createRunDirectory(foreign.parentSessionId, foreign.runId);
    writeRun(foreignDirectory, foreign);
    const config = structuredClone(DEFAULT_CONFIG);
    config.retention.undeliveredDays = 1;
    const manager = createManager(new FakeHerdr(), config);
    await manager.start();

    await manager.cleanupAll();

    expect(listSessionRuns("parent-2")).toHaveLength(1);
    manager.stop();
  });

  it("reconciles a child moved to a new Herdr pane", async () => {
    const herdr = new FakeHerdr();
    const manager = createManager(herdr);
    await manager.start();
    const receipt = await manager.spawn({
      taskName: "moved",
      message: "Keep working after a move.",
      inherited: { provider: "openai", model: "gpt-test" },
    });
    herdr.moveAgent(receipt.pane_id, "moved-pane", "moved-tab");
    manager.stop();

    const recovered = createManager(herdr);
    await recovered.start();
    expect(recovered.list()[0]).toMatchObject({ pane_id: "moved-pane", tab_id: "moved-tab" });
    await recovered.close(receipt.run_id, { force: true });
    expect(herdr.hasPane("moved-pane")).toBe(false);
    recovered.stop();
  });

  it("notifies the parent when Herdr natively reports a blocked agent", async () => {
    const herdr = new FakeHerdr();
    const manager = createManager(herdr);
    await manager.start();
    await manager.spawn({
      taskName: "blocked-native",
      message: "Wait for approval.",
      inherited: { provider: "openai", model: "gpt-test" },
    });
    manager.stop();
    herdr.setAgentStatus("blocked");
    const blocked: string[] = [];
    const recovered = new AgentManager(
      herdr,
      DEFAULT_CONFIG,
      { sessionId: "parent-1", cwd: "/repo", paneId: "parent-pane" },
      { onChange: () => {}, onResult: () => {}, onBlocked: (run) => blocked.push(run.taskName) },
    );

    await recovered.start();

    expect(blocked).toEqual(["blocked-native"]);
    recovered.stop();
  });

  it("propagates transient Herdr failures without closing an owned run", async () => {
    const herdr = new FakeHerdr();
    const manager = createManager(herdr);
    await manager.start();
    await manager.spawn({
      taskName: "transient",
      message: "Remain open.",
      inherited: { provider: "openai", model: "gpt-test" },
    });
    const before = manager.list()[0]?.agent_status;
    herdr.getPaneError = new HerdrCommandError("socket unavailable", "transport_error");

    await expect(manager.cleanupAll()).rejects.toThrow("socket unavailable");
    expect(manager.list()[0]?.agent_status).toBe(before);
    manager.stop();
  });

  it("does not mark a pane closed when close is aborted", async () => {
    const herdr = new FakeHerdr();
    const manager = createManager(herdr);
    await manager.start();
    await manager.spawn({
      taskName: "abort-close",
      message: "Remain open.",
      inherited: { provider: "openai", model: "gpt-test" },
    });
    herdr.closeError = new HerdrCommandError("Aborted", "aborted");

    await expect(manager.close("abort-close", { force: true })).rejects.toThrow("Aborted");
    expect(manager.list()[0]?.agent_status).not.toBe("closed");
    manager.stop();
  });
});

function createManager(herdr: HerdrPort, config = DEFAULT_CONFIG): AgentManager {
  return new AgentManager(
    herdr,
    config,
    { sessionId: "parent-1", cwd: "/repo", paneId: "parent-pane" },
    { onChange: () => {}, onResult: () => {}, onBlocked: () => {} },
  );
}

function runRecord(overrides: Partial<RunRecord>): RunRecord {
  const now = Date.now();
  return {
    version: PROTOCOL_VERSION,
    runId: "run",
    taskName: "task",
    parentSessionId: "parent-1",
    cwd: "/repo",
    capabilityToken: "token",
    provider: "openai",
    model: "gpt-test",
    herdrAgentName: "sa-task-run",
    status: "starting",
    deliveredResultIds: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

class FakeHerdr implements HerdrPort {
  readonly splitCalls: Array<{
    sourcePaneId: string;
    direction: "right" | "down";
    cwd: string;
    env: Record<string, string>;
  }> = [];
  readonly createTabCalls: Array<{ workspaceId: string; cwd: string; label: string; env: Record<string, string> }> = [];
  readonly tabs: HerdrTab[] = [
    { tab_id: "t1", workspace_id: "w1", label: "1", focused: true, agent_status: "working" },
  ];
  startedWith: Record<string, unknown> | undefined;
  parentWidth = 192;
  getPaneError: Error | undefined;
  closeError: Error | undefined;
  ackDelayMs = 0;
  busyStarts = 0;
  startAttempts = 0;
  private agents: HerdrAgent[] = [];
  private readonly runByPane = new Map<string, string>();
  private panes = new Map<string, HerdrPane>([
    [
      "parent-pane",
      {
        pane_id: "parent-pane",
        workspace_id: "w1",
        tab_id: "t1",
        focused: true,
        cwd: "/repo",
        foreground_cwd: "/repo",
        agent: "pi",
        agent_status: "working",
      },
    ],
  ]);

  async requireVersion(): Promise<string> {
    return "0.8.0";
  }

  hasPane(paneId: string): boolean {
    return this.panes.has(paneId);
  }

  setAgentStatus(status: HerdrAgent["agent_status"]): void {
    for (const agent of this.agents) agent.agent_status = status;
  }

  moveAgent(sourcePaneId: string, paneId: string, tabId: string): void {
    const source = this.panes.get(sourcePaneId)!;
    this.panes.delete(sourcePaneId);
    this.panes.set(paneId, { ...source, pane_id: paneId, tab_id: tabId });
    for (const agent of this.agents) {
      if (agent.pane_id !== sourcePaneId) continue;
      agent.pane_id = paneId;
      agent.tab_id = tabId;
    }
  }

  async getPane(paneId: string): Promise<HerdrPane> {
    if (this.getPaneError) throw this.getPaneError;
    const pane = this.panes.get(paneId);
    if (!pane) throw new HerdrCommandError("missing pane", "pane_not_found");
    return pane;
  }

  addPane(pane: HerdrPane): void {
    this.panes.set(pane.pane_id, pane);
  }

  async listPanes(): Promise<HerdrPane[]> {
    return [...this.panes.values()];
  }

  async getLayout(paneId: string) {
    return {
      workspace_id: "w1",
      tab_id: "t1",
      zoomed: false,
      focused_pane_id: paneId,
      area: { x: 0, y: 0, width: paneId === "parent-pane" ? this.parentWidth : 192, height: 46 },
      panes: [
        {
          pane_id: paneId,
          focused: true,
          rect: { x: 0, y: 0, width: paneId === "parent-pane" ? this.parentWidth : 192, height: 46 },
        },
      ],
      splits: [],
    };
  }

  async listTabs() {
    return this.tabs;
  }

  async createTab(input: {
    workspaceId: string;
    cwd: string;
    label: string;
    env: Record<string, string>;
  }) {
    this.createTabCalls.push(input);
    const index = this.createTabCalls.length;
    const tab = {
      tab_id: `owned-tab-${index}`,
      workspace_id: input.workspaceId,
      label: input.label,
      focused: false,
      agent_status: "idle" as const,
    };
    const pane: HerdrPane = {
      pane_id: `owned-pane-${index}`,
      workspace_id: input.workspaceId,
      tab_id: tab.tab_id,
      focused: false,
      cwd: input.cwd,
      agent_status: "idle",
    };
    this.tabs.push(tab);
    this.panes.set(pane.pane_id, pane);
    this.runByPane.set(pane.pane_id, input.env.PI_HERDR_SUBAGENT_RUN_ID!);
    return { tab, pane };
  }

  async splitPane(input: {
    sourcePaneId: string;
    direction: "right" | "down";
    cwd: string;
    env: Record<string, string>;
  }): Promise<HerdrPane> {
    this.splitCalls.push(input);
    const pane: HerdrPane = {
      pane_id: this.splitCalls.length === 1 ? "child-pane" : `child-pane-${this.splitCalls.length}`,
      workspace_id: "w1",
      tab_id: "t1",
      focused: false,
      cwd: input.cwd,
      foreground_cwd: input.cwd,
      agent_status: "idle",
    };
    this.panes.set(pane.pane_id, pane);
    this.runByPane.set(pane.pane_id, input.env.PI_HERDR_SUBAGENT_RUN_ID!);
    return pane;
  }

  async renamePane(): Promise<void> {}

  async closePane(paneId: string): Promise<void> {
    if (this.closeError) throw this.closeError;
    this.panes.delete(paneId);
    this.agents = this.agents.filter((agent) => agent.pane_id !== paneId);
  }

  async focusAgent(target: string): Promise<HerdrAgent> {
    return this.getAgent(target);
  }

  async getAgent(target: string): Promise<HerdrAgent> {
    const agent = this.agents.find((candidate) => candidate.name === target || candidate.pane_id === target);
    if (!agent) throw new HerdrCommandError("missing agent", "agent_not_found");
    return agent;
  }

  async listAgents(): Promise<HerdrAgent[]> {
    return this.agents;
  }

  async startPiAgent(input: {
    name: string;
    paneId: string;
    provider: string;
    model: string;
    thinking?: string;
  }): Promise<HerdrAgent> {
    this.startAttempts += 1;
    if (this.startAttempts <= this.busyStarts) {
      throw new HerdrCommandError("agent target pane is not an available shell", "agent_pane_busy");
    }
    this.startedWith = input;
    const runId = this.runByPane.get(input.paneId);
    const stored = listSessionRuns("parent-1").find((entry) => entry.record.runId === runId)!;
    const dispatch = listDispatches(stored.directory, stored.record.runId, stored.record.capabilityToken)[0]!.request;
    const acknowledge = () =>
      writeAck(stored.directory, {
        version: PROTOCOL_VERSION,
        type: "dispatch-ack",
        requestId: dispatch.requestId,
        runId: stored.record.runId,
        capabilityToken: stored.record.capabilityToken,
        state: "delivered",
        message: "accepted",
        createdAt: Date.now(),
      });
    if (this.ackDelayMs > 0) setTimeout(acknowledge, this.ackDelayMs);
    else acknowledge();
    const agent: HerdrAgent = {
      name: input.name,
      agent: "pi",
      agent_status: "idle",
      workspace_id: "w1",
      tab_id: this.panes.get(input.paneId)?.tab_id ?? "t1",
      pane_id: input.paneId,
      focused: false,
      cwd: "/repo",
    };
    this.agents.push(agent);
    return agent;
  }

  async interruptAgent(): Promise<void> {}
}
