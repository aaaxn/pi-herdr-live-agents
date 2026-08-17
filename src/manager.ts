import { randomBytes, randomUUID } from "node:crypto";
import type { ExtensionConfig, ModelProfile, PanePlacement } from "./types.js";
import { HerdrClient, HerdrCommandError, isHerdrAbort, isHerdrError } from "./herdr.js";
import { planLargestSplit, planSiblingSplit } from "./layout.js";
import {
  appendEvent,
  createRunDirectory,
  listAllRuns,
  listResults,
  listSessionRuns,
  readAck,
  readChildState,
  readResult,
  removeAck,
  removeRunDirectory,
  writeDispatch,
  writeResult,
  writeRun,
} from "./storage.js";
import { sliceUtf8 } from "./utf8.js";
import {
  PROTOCOL_VERSION,
  type AgentStatus,
  type AgentSummary,
  type DispatchAck,
  type DispatchRequest,
  type HerdrAgent,
  type HerdrPane,
  type RunRecord,
  type RunResult,
  type ThinkingLevel,
} from "./types.js";

const POLL_INTERVAL_MS = 200;
const RECONCILE_INTERVAL_MS = 5_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const LEGACY_RETENTION = { deliveredDays: 7, undeliveredDays: 30 } as const;
/** A freshly split pane reports `agent_pane_busy` until its shell reaches an interactive prompt. */
const PANE_READY_TIMEOUT_MS = 15_000;
const PANE_READY_RETRY_MS = 250;
const ACTIVE_STATUSES = new Set<AgentStatus>(["starting", "working", "blocked"]);
const MODEL_CLOSEABLE_STATUSES = new Set<AgentStatus>(["idle", "done", "failed", "interrupted", "closed"]);

export type HerdrPort = Pick<
  HerdrClient,
  | "requireVersion"
  | "getPane"
  | "listPanes"
  | "getLayout"
  | "listTabs"
  | "createTab"
  | "splitPane"
  | "renamePane"
  | "closePane"
  | "focusAgent"
  | "getAgent"
  | "listAgents"
  | "startPiAgent"
  | "interruptAgent"
>;

export interface ManagerHooks {
  onChange(): void;
  onResult(run: RunRecord, result: RunResult): void;
  onBlocked(run: RunRecord): void;
}

export interface SpawnInput {
  taskName: string;
  message: string;
  profile?: string;
  inherited: ModelProfile;
  parentSessionFile?: string;
  signal?: AbortSignal;
}

export interface SpawnReceipt {
  task_name: string;
  run_id: string;
  pane_id: string;
  tab_id: string;
  agent_status: AgentStatus;
  accepted: boolean;
  profile?: string;
  provider: string;
  model: string;
  thinking?: ThinkingLevel;
}

type ManagedRun = {
  directory: string;
  record: RunRecord;
  stateSeq: number;
};

type PaneAllocation = {
  pane: HerdrPane;
  placement: PanePlacement;
  agentTabId?: string;
};

type MutableRunField =
  | "paneId"
  | "tabId"
  | "workspaceId"
  | "placement"
  | "agentTabId"
  | "childSessionId"
  | "childSessionFile"
  | "status"
  | "statusMessage"
  | "pendingRequestId"
  | "latestResultId"
  | "closedAt";

type RunPatch = { [Key in MutableRunField]?: RunRecord[Key] | undefined };

export class AgentManager {
  private readonly runs = new Map<string, ManagedRun>();
  private readonly seenResults = new Set<string>();
  private readonly activeReservations = new Set<string>();
  private pollTimer: NodeJS.Timeout | undefined;
  private reconcileTimer: NodeJS.Timeout | undefined;
  private polling = false;
  private reconciling = false;
  private allocationTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly herdr: HerdrPort,
    private readonly config: ExtensionConfig,
    private readonly parent: {
      sessionId: string;
      cwd: string;
      paneId: string;
    },
    private readonly hooks: ManagerHooks,
  ) {}

  async start(signal?: AbortSignal): Promise<void> {
    await this.herdr.requireVersion("0.8.0", signal);
    for (const entry of listSessionRuns(this.parent.sessionId)) {
      this.runs.set(entry.record.runId, { ...entry, stateSeq: 0 });
      for (const resultId of entry.record.deliveredResultIds) this.seenResults.add(resultKey(entry.record.runId, resultId));
    }
    await this.poll();
    await this.reconcile();
    this.pollTimer = setInterval(() => void this.poll(), POLL_INTERVAL_MS);
    this.reconcileTimer = setInterval(() => void this.reconcile(), RECONCILE_INTERVAL_MS);
    this.pollTimer.unref?.();
    this.reconcileTimer.unref?.();
  }

  stop(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    this.pollTimer = undefined;
    this.reconcileTimer = undefined;
  }

  async spawn(input: SpawnInput): Promise<SpawnReceipt> {
    assertTaskName(input.taskName);
    assertMessage(input.message);
    const selected = this.selectProfile(input.profile, input.inherited);

    const { run, initial } = await this.withAllocationLock(async () => {
      if (input.signal?.aborted) throw new HerdrCommandError("Aborted", "aborted");
      this.assertUniqueOpenName(input.taskName);
      this.assertCapacity();

      const runId = randomUUID();
      const capabilityToken = randomBytes(32).toString("base64url");
      const directory = createRunDirectory(this.parent.sessionId, runId);
      const now = Date.now();
      const record: RunRecord = {
        version: PROTOCOL_VERSION,
        runId,
        taskName: input.taskName,
        parentSessionId: this.parent.sessionId,
        ...(input.parentSessionFile ? { parentSessionFile: input.parentSessionFile } : {}),
        cwd: this.parent.cwd,
        capabilityToken,
        ...(selected.profile ? { profile: selected.profile } : {}),
        provider: selected.model.provider,
        model: selected.model.model,
        ...(selected.model.thinking ? { thinking: selected.model.thinking } : {}),
        herdrAgentName: agentRuntimeName(input.taskName, runId),
        status: "starting",
        deliveredResultIds: [],
        retention: { ...this.config.retention },
        createdAt: now,
        updatedAt: now,
      };
      const managed: ManagedRun = { directory, record, stateSeq: 0 };
      this.runs.set(runId, managed);
      this.activeReservations.add(runId);
      writeRun(directory, record);

      const dispatch = createDispatch(record, input.message, "auto");
      writeDispatch(directory, dispatch);
      this.updateRun(managed, { pendingRequestId: dispatch.requestId });

      try {
        const allocation = await this.allocatePane(managed, input.signal);
        this.updateRun(managed, {
          paneId: allocation.pane.pane_id,
          tabId: allocation.pane.tab_id,
          workspaceId: allocation.pane.workspace_id,
          placement: allocation.placement,
          agentTabId: allocation.agentTabId,
        });
      } catch (error) {
        this.activeReservations.delete(runId);
        this.failRun(managed, `Unable to allocate a Herdr pane: ${errorText(error)}`);
        throw error;
      }
      return { run: managed, initial: dispatch };
    });

    let ack: DispatchAck | undefined;
    try {
      try {
        await this.herdr.renamePane(requireValue(run.record.paneId, "pane id"), `agent · ${input.taskName}`, input.signal);
        const started = await this.startPi(run, input.signal);
        this.applyNativeStatus(run, started.agent_status);
      } catch (error) {
        const recovered = await this.recoverStartFailure(run);
        if (!recovered) this.failRun(run, `Unable to start Pi in Herdr: ${errorText(error)}`);
        if (isHerdrAbort(error)) throw error;
      }

      ack = await this.waitForAck(run, initial.requestId, 6_000, input.signal);
      if (ack?.state === "delivered" || ack?.state === "queued") {
        if (run.record.status === "starting" || run.record.status === "idle") this.updateRun(run, { status: "working" });
      } else if (ack?.state === "failed") {
        this.failRun(run, `The child Pi rejected its delegated task: ${ack.message}`);
      }
    } finally {
      this.activeReservations.delete(run.record.runId);
    }
    this.hooks.onChange();

    if (!run.record.paneId || !run.record.tabId) throw new Error(`Agent '${input.taskName}' has no Herdr pane`);
    return {
      task_name: input.taskName,
      run_id: run.record.runId,
      pane_id: run.record.paneId,
      tab_id: run.record.tabId,
      agent_status: run.record.status,
      accepted: ack?.state === "delivered" || ack?.state === "queued",
      ...(selected.profile ? { profile: selected.profile } : {}),
      provider: selected.model.provider,
      model: selected.model.model,
      ...(selected.model.thinking ? { thinking: selected.model.thinking } : {}),
    };
  }

  async sendMessage(target: string, message: string, signal?: AbortSignal): Promise<{ delivery: "steer" | "prompt" | "queued"; request_id: string }> {
    assertMessage(message);
    const run = this.requireRun(target);
    if (run.record.status === "closed") throw new Error(`Agent '${target}' is closed`);
    await this.requireLiveAgent(run, signal);

    const active = ACTIVE_STATUSES.has(run.record.status);
    const request = createDispatch(run.record, message, active ? "steer" : "auto");
    writeDispatch(run.directory, request);
    this.updateRun(run, {
      pendingRequestId: request.requestId,
      ...(active ? {} : { status: "starting" as const, statusMessage: undefined }),
    });
    const ack = await this.waitForAck(run, request.requestId, 6_000, signal);
    if (!ack) return { delivery: "queued", request_id: request.requestId };
    if (ack.state === "failed") throw new Error(ack.message);
    return { delivery: active ? "steer" : "prompt", request_id: request.requestId };
  }

  async interrupt(target: string, signal?: AbortSignal): Promise<{ previous_status: AgentStatus }> {
    const run = this.requireRun(target);
    if (!ACTIVE_STATUSES.has(run.record.status)) {
      return { previous_status: run.record.status };
    }
    await this.requireLiveAgent(run, signal);
    const previous = run.record.status;
    await this.herdr.interruptAgent(run.record.herdrAgentName, signal);
    appendEvent(run.directory, "agent.interrupt-requested", { previousStatus: previous });
    return { previous_status: previous };
  }

  async focus(target: string, signal?: AbortSignal): Promise<{ pane_id: string }> {
    const run = this.requireRun(target);
    if (!run.record.paneId || run.record.status === "closed") throw new Error(`Agent '${target}' has no open pane`);
    const agent = await this.herdr.focusAgent(run.record.herdrAgentName, signal);
    this.syncAgentLocation(run, agent);
    return { pane_id: agent.pane_id };
  }

  async close(target: string, options: { force: boolean; signal?: AbortSignal }): Promise<{ previous_status: AgentStatus }> {
    const run = this.requireRun(target);
    const previous = run.record.status;
    if (previous === "closed") return { previous_status: previous };
    if (!options.force && !MODEL_CLOSEABLE_STATUSES.has(previous)) {
      throw new Error(`Agent '${target}' is ${previous}; interrupt it before closing`);
    }
    if (!run.record.paneId) throw new Error(`Agent '${target}' has no owned pane`);
    if (run.record.paneId === this.parent.paneId) throw new Error("Refusing to close the parent Pi pane");

    const agent = await this.tryGetAgent(run, options.signal);
    if (!options.force && agent && agent.agent_status !== "idle" && agent.agent_status !== "done") {
      throw new Error(`Herdr reports '${target}' as ${agent.agent_status}; interrupt it or close it explicitly`);
    }
    try {
      await this.herdr.closePane(run.record.paneId, options.signal);
    } catch (error) {
      if (await this.paneExists(run.record.paneId, options.signal)) throw error;
    }
    this.updateRun(run, { status: "closed", closedAt: Date.now(), statusMessage: undefined });
    appendEvent(run.directory, "pane.closed", { previousStatus: previous, force: options.force });
    return { previous_status: previous };
  }

  async closeDone(signal?: AbortSignal): Promise<{ closed: string[]; skipped: Array<{ agent: string; reason: string }> }> {
    const closed: string[] = [];
    const skipped: Array<{ agent: string; reason: string }> = [];
    for (const run of this.currentRuns()) {
      if (!MODEL_CLOSEABLE_STATUSES.has(run.record.status) || run.record.status === "closed") continue;
      try {
        await this.close(run.record.runId, { force: false, ...(signal ? { signal } : {}) });
        closed.push(run.record.taskName);
      } catch (error) {
        if (isHerdrAbort(error)) throw error;
        skipped.push({ agent: run.record.taskName, reason: errorText(error) });
      }
    }
    return { closed, skipped };
  }

  list(pathPrefix?: string): AgentSummary[] {
    return this.currentRuns()
      .filter((run) => !pathPrefix || run.record.taskName.startsWith(pathPrefix))
      .map(({ record }) => ({
        agent_name: record.taskName,
        run_id: record.runId,
        agent_status: record.status,
        ...(record.statusMessage ? { status_message: record.statusMessage } : {}),
        ...(record.paneId ? { pane_id: record.paneId } : {}),
        ...(record.tabId ? { tab_id: record.tabId } : {}),
        ...(record.profile ? { profile: record.profile } : {}),
        provider: record.provider,
        model: record.model,
        ...(record.thinking ? { thinking: record.thinking } : {}),
        created_at: record.createdAt,
        updated_at: record.updatedAt,
        ...(record.latestResultId ? { latest_result_id: record.latestResultId } : {}),
        result_delivered: Boolean(record.latestResultId && record.deliveredResultIds.includes(record.latestResultId)),
        awaiting_result: Boolean(record.pendingRequestId) || ACTIVE_STATUSES.has(record.status),
      }));
  }

  readResponse(target: string, offset = 0, limit = 64 * 1024, resultId?: string): {
    agent_name: string;
    result_id: string;
    status: AgentStatus;
    response: string;
    offset: number;
    total_bytes: number;
    next_offset?: number;
  } {
    const run = this.requireRun(target);
    const selectedResultId = resultId ?? run.record.latestResultId;
    if (!selectedResultId) throw new Error(`Agent '${target}' has no final response`);
    const result = readResult(run.directory, run.record, selectedResultId);
    if (!result) throw new Error(`Result '${selectedResultId}' is unavailable for agent '${target}'`);
    if (!Number.isInteger(limit) || limit < 1 || limit > 64 * 1024) {
      throw new Error("limit must be between 1 and 65536 bytes");
    }
    const content = sliceUtf8(result.response, offset, limit);
    return {
      agent_name: run.record.taskName,
      result_id: result.resultId,
      status: result.status,
      response: content.text,
      offset,
      total_bytes: content.totalBytes,
      ...(content.nextOffset !== undefined ? { next_offset: content.nextOffset } : {}),
    };
  }

  latestResult(target: string): RunResult | undefined {
    const run = this.requireRun(target);
    return run.record.latestResultId ? readResult(run.directory, run.record, run.record.latestResultId) : undefined;
  }

  isDelivered(runId: string, resultId: string): boolean {
    const run = this.runs.get(runId);
    return Boolean(run?.record.deliveredResultIds.includes(resultId));
  }

  markDelivered(runId: string, resultId: string): void {
    const run = this.runs.get(runId);
    if (!run || run.record.deliveredResultIds.includes(resultId)) return;
    run.record.deliveredResultIds.push(resultId);
    run.record.updatedAt = Date.now();
    writeRun(run.directory, run.record);
    appendEvent(run.directory, "result.delivered", { resultId });
    this.hooks.onChange();
  }

  getRun(target: string): RunRecord {
    return this.requireRun(target).record;
  }

  purgeClosed(): number {
    let count = 0;
    for (const run of [...this.runs.values()]) {
      if (run.record.status !== "closed") continue;
      removeRunDirectory(run.directory);
      this.runs.delete(run.record.runId);
      count += 1;
    }
    if (count) this.hooks.onChange();
    return count;
  }

  async cleanupAll(signal?: AbortSignal): Promise<number> {
    let removed = 0;
    const now = Date.now();
    for (const entry of listAllRuns()) {
      const managed = this.runs.get(entry.record.runId);
      const record = managed?.record ?? entry.record;
      // Only this parent session may rewrite ownership metadata. Runs from other
      // sessions are read-only here and are removed strictly by their own retention.
      if (managed && record.status !== "closed" && record.paneId) {
        try {
          this.syncAgentLocation(managed, await this.herdr.getAgent(record.herdrAgentName, signal));
        } catch (error) {
          if (!isHerdrError(error, "agent_not_found", "pane_not_found")) throw error;
        }
        if (record.paneId && !(await this.paneExists(record.paneId, signal))) {
          this.updateRun(managed, { status: "closed", closedAt: now });
        }
      }
      const terminalWithoutPane = !record.paneId && (record.status === "done" || record.status === "failed" || record.status === "interrupted");
      if (record.status !== "closed" && !terminalWithoutPane) continue;
      const results = listResults(entry.directory, record);
      const hasUndeliveredResult =
        results.length === 0 || results.some((result) => !record.deliveredResultIds.includes(result.resultId));
      const retention = record.retention ?? LEGACY_RETENTION;
      const days = hasUndeliveredResult ? retention.undeliveredDays : retention.deliveredDays;
      if (days === 0) continue;
      const closedAt = record.closedAt ?? record.updatedAt;
      if (closedAt + days * DAY_MS > now) continue;
      removeRunDirectory(entry.directory);
      this.runs.delete(record.runId);
      removed += 1;
    }
    if (removed) this.hooks.onChange();
    return removed;
  }

  private async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      for (const run of this.currentRuns()) this.pollRun(run);
    } finally {
      this.polling = false;
    }
  }

  private pollRun(run: ManagedRun): void {
    const state = readChildState(run.directory, run.record);
    if (state && state.seq > run.stateSeq) {
      const closed = run.record.status === "closed";
      const wasBlocked = run.record.status === "blocked";
      run.stateSeq = state.seq;
      this.updateRun(run, {
        status: closed ? "closed" : state.status,
        statusMessage: closed ? run.record.statusMessage : state.message,
        childSessionId: state.childSessionId,
        childSessionFile: state.childSessionFile,
      });
      if (!closed && !wasBlocked && state.status === "blocked") this.hooks.onBlocked(run.record);
    }

    for (const result of listResults(run.directory, run.record)) {
      const key = resultKey(run.record.runId, result.resultId);
      if (this.seenResults.has(key)) continue;
      this.seenResults.add(key);
      this.updateRun(run, {
        status: run.record.status === "closed" ? "closed" : result.status,
        statusMessage: result.error,
        latestResultId: result.resultId,
        ...(result.requestId && result.requestId === run.record.pendingRequestId ? { pendingRequestId: undefined } : {}),
      });
      this.hooks.onResult(run.record, result);
    }
  }

  private async reconcile(): Promise<void> {
    if (this.reconciling) return;
    this.reconciling = true;
    try {
      const agents = await this.herdr.listAgents();
      for (const run of this.currentRuns()) {
        if (run.record.status === "closed" || !run.record.paneId) continue;
        const agent = agents.find(
          (candidate) => candidate.name === run.record.herdrAgentName || candidate.pane_id === run.record.paneId,
        );
        if (agent) {
          this.syncAgentLocation(run, agent);
          this.applyNativeStatus(run, agent.agent_status);
          continue;
        }
        if (!(await this.paneExists(run.record.paneId))) {
          if (ACTIVE_STATUSES.has(run.record.status)) this.failRun(run, "The Herdr pane closed before the task completed.");
          this.updateRun(run, { status: "closed", closedAt: Date.now() });
          continue;
        }
        if (run.record.status === "starting" && Date.now() - run.record.updatedAt > 60_000) {
          this.failRun(run, "Pi did not become available in the owned Herdr pane.");
        }
      }
    } catch {
      // A transient Herdr failure must not change ownership or task state.
    } finally {
      this.reconciling = false;
    }
  }

  private async allocatePane(run: ManagedRun, signal?: AbortSignal): Promise<PaneAllocation> {
    const parentPane = await this.herdr.getPane(this.parent.paneId, signal);
    const minimum = { width: this.config.layout.minPaneWidth, height: this.config.layout.minPaneHeight };
    const env = childEnvironment(run);
    const parentLayout = await this.herdr.getLayout(parentPane.pane_id, signal);
    const siblingPlan = parentLayout.zoomed ? undefined : planSiblingSplit(parentLayout, parentPane.pane_id, minimum);
    if (siblingPlan) {
      const pane = await this.herdr.splitPane({
        sourcePaneId: siblingPlan.sourcePaneId,
        direction: siblingPlan.direction,
        cwd: this.parent.cwd,
        env,
        ...(signal ? { signal } : {}),
      });
      return { pane, placement: "sibling" };
    }

    const tabLabel = `agents · ${this.parent.sessionId.slice(-6)}`;
    const ownedTabIds = new Set(
      this.currentRuns()
        .filter(({ record }) => record.placement === "agents-tab" && record.agentTabId)
        .map(({ record }) => record.agentTabId!),
    );
    const tabs = await this.herdr.listTabs(parentPane.workspace_id, signal);
    const agentTabs = tabs.filter((tab) => ownedTabIds.has(tab.tab_id));
    const panes = await this.herdr.listPanes(parentPane.workspace_id, signal);
    for (const tab of agentTabs) {
      const tabPanes = panes.filter((pane) => pane.tab_id === tab.tab_id);
      if (!tabPanes[0]) continue;
      const layout = await this.herdr.getLayout(tabPanes[0].pane_id, signal);
      const plan = planLargestSplit(layout, new Set(tabPanes.map((pane) => pane.pane_id)), minimum);
      if (!plan) continue;
      const pane = await this.herdr.splitPane({
        sourcePaneId: plan.sourcePaneId,
        direction: plan.direction,
        cwd: this.parent.cwd,
        env,
        ...(signal ? { signal } : {}),
      });
      return { pane, placement: "agents-tab", agentTabId: tab.tab_id };
    }

    const label = ownedTabIds.size === 0 ? tabLabel : `${tabLabel} · ${ownedTabIds.size + 1}`;
    const created = await this.herdr.createTab({
      workspaceId: parentPane.workspace_id,
      cwd: this.parent.cwd,
      label,
      env,
      ...(signal ? { signal } : {}),
    });
    return { pane: created.pane, placement: "agents-tab", agentTabId: created.tab.tab_id };
  }

  private async startPi(run: ManagedRun, signal?: AbortSignal): Promise<HerdrAgent> {
    const request = {
      name: run.record.herdrAgentName,
      paneId: requireValue(run.record.paneId, "pane id"),
      provider: run.record.provider,
      model: run.record.model,
      ...(run.record.thinking ? { thinking: run.record.thinking } : {}),
      timeoutMs: 30_000,
      ...(signal ? { signal } : {}),
    };
    const deadline = Date.now() + PANE_READY_TIMEOUT_MS;
    while (true) {
      try {
        return await this.herdr.startPiAgent(request);
      } catch (error) {
        if (!isHerdrError(error, "agent_pane_busy") || Date.now() >= deadline) throw error;
        await delay(PANE_READY_RETRY_MS);
      }
    }
  }

  private async recoverStartFailure(run: ManagedRun): Promise<boolean> {
    const agent = await this.tryGetAgent(run);
    if (!agent) return false;
    this.applyNativeStatus(run, agent.agent_status);
    return true;
  }

  private async requireLiveAgent(run: ManagedRun, signal?: AbortSignal) {
    const agent = await this.tryGetAgent(run, signal);
    if (!agent) throw new Error(`Agent '${run.record.taskName}' is not running in its owned pane`);
    return agent;
  }

  private async tryGetAgent(run: ManagedRun, signal?: AbortSignal): Promise<HerdrAgent | undefined> {
    try {
      const agent = await this.herdr.getAgent(run.record.herdrAgentName, signal);
      this.syncAgentLocation(run, agent);
      return agent;
    } catch (error) {
      if (!isHerdrError(error, "agent_not_found")) throw error;
      if (!run.record.paneId) return undefined;
      try {
        const agent = await this.herdr.getAgent(run.record.paneId, signal);
        this.syncAgentLocation(run, agent);
        return agent;
      } catch (paneError) {
        if (isHerdrError(paneError, "agent_not_found", "pane_not_found")) return undefined;
        throw paneError;
      }
    }
  }

  private syncAgentLocation(run: ManagedRun, agent: HerdrAgent): void {
    if (
      run.record.paneId === agent.pane_id &&
      run.record.tabId === agent.tab_id &&
      run.record.workspaceId === agent.workspace_id
    ) {
      return;
    }
    this.updateRun(run, {
      paneId: agent.pane_id,
      tabId: agent.tab_id,
      workspaceId: agent.workspace_id,
    });
  }

  private async paneExists(paneId: string, signal?: AbortSignal): Promise<boolean> {
    try {
      await this.herdr.getPane(paneId, signal);
      return true;
    } catch (error) {
      if (isHerdrError(error, "pane_not_found")) return false;
      throw error;
    }
  }

  private applyNativeStatus(run: ManagedRun, status: "idle" | "working" | "blocked" | "done" | "unknown"): void {
    if (status === "unknown" || run.record.status === "closed") return;
    const resultIsAuthoritative =
      Boolean(run.record.latestResultId) &&
      (run.record.status === "done" || run.record.status === "failed" || run.record.status === "interrupted");
    if (resultIsAuthoritative) return;
    const mapped: AgentStatus = status === "done" ? "done" : status;
    if (mapped === run.record.status) return;
    const wasBlocked = run.record.status === "blocked";
    this.updateRun(run, { status: mapped });
    if (!wasBlocked && mapped === "blocked") this.hooks.onBlocked(run.record);
  }

  private failRun(run: ManagedRun, message: string): void {
    const result: RunResult = {
      version: PROTOCOL_VERSION,
      type: "result",
      resultId: randomUUID(),
      runId: run.record.runId,
      capabilityToken: run.record.capabilityToken,
      source: "runtime",
      status: "failed",
      response: "",
      error: message,
      createdAt: Date.now(),
    };
    writeResult(run.directory, result);
    this.updateRun(run, {
      status: run.record.paneId ? "failed" : "closed",
      statusMessage: message,
      latestResultId: result.resultId,
      ...(run.record.paneId ? {} : { closedAt: Date.now() }),
    });
  }

  private updateRun(run: ManagedRun, patch: RunPatch): void {
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) delete (run.record as unknown as Record<string, unknown>)[key];
      else (run.record as unknown as Record<string, unknown>)[key] = value;
    }
    run.record.updatedAt = Date.now();
    writeRun(run.directory, run.record);
    this.hooks.onChange();
  }

  private selectProfile(requested: string | undefined, inherited: ModelProfile): { profile?: string; model: ModelProfile } {
    const name = requested ?? this.config.defaultProfile;
    if (!name) return { model: inherited };
    const profile = this.config.profiles[name];
    if (!profile) {
      const available = Object.keys(this.config.profiles).join(", ") || "none";
      throw new Error(`Unknown model profile '${name}'. Available profiles: ${available}`);
    }
    return { profile: name, model: profile };
  }

  private assertUniqueOpenName(taskName: string): void {
    const duplicate = this.currentRuns().find((run) => run.record.taskName === taskName && run.record.status !== "closed");
    if (duplicate) throw new Error(`Agent '${taskName}' already has an open pane; use send_message or close_agent`);
  }

  private async withAllocationLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.allocationTail;
    let release!: () => void;
    this.allocationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private assertCapacity(): void {
    const runs = this.currentRuns();
    const active = runs.filter(
      (run) => ACTIVE_STATUSES.has(run.record.status) || this.activeReservations.has(run.record.runId),
    ).length;
    if (active >= this.config.limits.maxConcurrentAgents) {
      throw new Error(`Concurrent agent limit reached (${this.config.limits.maxConcurrentAgents})`);
    }
    const open = runs.filter((run) => run.record.status !== "closed").length;
    if (open >= this.config.limits.maxOpenPanes) {
      const closeable = runs
        .filter((run) => MODEL_CLOSEABLE_STATUSES.has(run.record.status) && run.record.status !== "closed")
        .map((run) => run.record.taskName);
      throw new Error(
        `Open agent pane limit reached (${this.config.limits.maxOpenPanes}). Close completed agents${
          closeable.length ? `: ${closeable.join(", ")}` : " before spawning more"
        }`,
      );
    }
  }

  private requireRun(target: string): ManagedRun {
    const clean = target.trim().replace(/^\/+/, "");
    const matches = this.currentRuns().filter(
      (run) => run.record.taskName === clean || run.record.runId === clean || run.record.runId.startsWith(clean),
    );
    if (matches.length === 0) throw new Error(`Unknown agent '${target}' in this parent session`);
    const open = matches.filter((run) => run.record.status !== "closed");
    if (open.length > 1 || (open.length === 0 && matches.length > 1)) throw new Error(`Agent target '${target}' is ambiguous`);
    return open[0] ?? matches.at(-1)!;
  }

  private currentRuns(): ManagedRun[] {
    return [...this.runs.values()].sort((left, right) => left.record.createdAt - right.record.createdAt);
  }

  private async waitForAck(
    run: ManagedRun,
    requestId: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<DispatchAck | undefined> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (signal?.aborted) throw new Error("Aborted");
      const ack = readAck(run.directory, requestId, run.record.capabilityToken);
      if (ack) {
        removeAck(run.directory, requestId);
        return ack;
      }
      await delay(50);
    }
    return undefined;
  }
}

function createDispatch(record: RunRecord, message: string, mode: "auto" | "steer"): DispatchRequest {
  return {
    version: PROTOCOL_VERSION,
    type: "dispatch",
    requestId: randomUUID(),
    runId: record.runId,
    capabilityToken: record.capabilityToken,
    message,
    mode,
    createdAt: Date.now(),
  };
}

function childEnvironment(run: ManagedRun): Record<string, string> {
  return {
    PI_HERDR_SUBAGENT: "1",
    PI_HERDR_SUBAGENT_RUN_ID: run.record.runId,
    PI_HERDR_SUBAGENT_RUN_DIR: run.directory,
    PI_HERDR_SUBAGENT_TOKEN: run.record.capabilityToken,
    PI_HERDR_SUBAGENT_PARENT_SESSION_ID: run.record.parentSessionId,
  };
}

function agentRuntimeName(taskName: string, runId: string): string {
  const slug = taskName.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "agent";
  return `sa-${slug.slice(0, 20)}-${runId.slice(0, 6)}`.slice(0, 32);
}

function assertTaskName(taskName: string): void {
  const validPath = /^[A-Za-z0-9][A-Za-z0-9_-]*(?:\/[A-Za-z0-9][A-Za-z0-9_-]*)*$/.test(taskName);
  if (!validPath || taskName.length > 64 || taskName.includes("..")) {
    throw new Error("task_name must use letters, digits, underscores, dashes, or single slash separators (max 64 characters)");
  }
}

function assertMessage(message: string): void {
  if (!message.trim()) throw new Error("Agent message must not be empty");
  if (Buffer.byteLength(message, "utf8") > 128 * 1024) throw new Error("Agent message exceeds the 128 KiB transport limit");
}

function resultKey(runId: string, resultId: string): string {
  return `${runId}:${resultId}`;
}

function requireValue<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`Missing ${label}`);
  return value;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
