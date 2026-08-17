import type {
  AgentToolUpdateCallback,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  Theme,
  ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { loadConfig } from "./config.js";
import { HerdrClient, HerdrCommandError } from "./herdr.js";
import { errorMessage } from "./json.js";
import { AgentManager, type SpawnInput, type SpawnReceipt } from "./manager.js";
import { ACTIVE_STATUSES, type AgentStatus, type AgentSummary, type ExtensionConfig, type ModelProfile, type RunRecord, type RunResult } from "./types.js";
import { sliceUtf8 } from "./utf8.js";

const RESULT_MESSAGE_TYPE = "pi-herdr-subagent-result";
const STATUS_MESSAGE_TYPE = "pi-herdr-subagent-status";
const WIDGET_KEY = "pi-herdr-subagents";
const SUCCESS_DEBOUNCE_MS = 500;
const SUCCESS_MAX_WAIT_MS = 1_000;
const AUTO_RESULT_LIMIT = 64 * 1024;
const FINAL_STATUSES = new Set<AgentStatus>(["done", "failed", "interrupted", "closed"]);

type Completion = { run: RunRecord; result: RunResult };

/** One completion as the model sees it, from wait_agent or from automatic delivery. */
interface CompletionPayload {
  agent_name: string;
  run_id: string;
  result_id: string;
  status: RunResult["status"];
  response: string;
  note?: string;
  error?: string;
  pane_id: string | undefined;
  tab_id: string | undefined;
  child_session_id: string | undefined;
  child_session_file: string | undefined;
}

/** A completion delivered automatically, whose response is capped at AUTO_RESULT_LIMIT bytes. */
interface BoundedCompletionPayload extends CompletionPayload {
  truncated?: boolean;
  response_bytes?: number;
  next_offset?: number;
  read_more?: string;
}

interface ResultMessageAgent {
  name: string;
  status: RunResult["status"];
}

/** The `details` this extension attaches to its own RESULT_MESSAGE_TYPE messages. */
interface ResultMessageDetails {
  agents: ResultMessageAgent[];
}

/** The `details` this extension attaches to its own STATUS_MESSAGE_TYPE messages. */
interface StatusMessageDetails {
  agent_name: string;
  status: "blocked";
}

/** One text block returned to the model; the structural shape of the SDK's TextContent. */
interface ToolText {
  type: "text";
  text: string;
}

/** The payload every tool in this extension returns. */
interface ToolTextResult<TDetails> {
  content: ToolText[];
  details: TDetails;
}

/**
 * What spawn_agent's result renderer reads back. The interactive transcript hands the
 * renderer only content/details while the HTML exporter also stamps `isError`, so the
 * flag is genuinely optional at this boundary.
 */
interface SpawnResultView {
  isError?: boolean;
  details?: SpawnReceipt | null;
}

type CloseOptions = Parameters<AgentManager["close"]>[1];

type OneWaiter = {
  kind: "one";
  targets?: Set<string>;
  resolve(value: CompletionPayload): void;
  reject(error: Error): void;
  removeAbort?: () => void;
};

type AllWaiter = {
  kind: "all";
  targets: Set<string>;
  results: Map<string, Completion>;
  resolve(value: CompletionPayload[]): void;
  reject(error: Error): void;
  removeAbort?: () => void;
};

type CompletionWaiter = OneWaiter | AllWaiter;

export class RootRuntime {
  readonly manager: AgentManager;
  private readonly waiters = new Set<CompletionWaiter>();
  private readonly pendingSuccesses = new Map<string, Completion>();
  private debounceTimer: NodeJS.Timeout | undefined;
  private maxWaitTimer: NodeJS.Timeout | undefined;
  private cleanupTimer: NodeJS.Timeout | undefined;
  private disposed = false;

  constructor(
    private readonly pi: ExtensionAPI,
    readonly ctx: ExtensionContext,
    readonly config: ExtensionConfig,
    herdr: HerdrClient,
    parentPaneId: string,
  ) {
    this.manager = new AgentManager(
      herdr,
      config,
      {
        sessionId: ctx.sessionManager.getSessionId(),
        cwd: ctx.cwd,
        paneId: parentPaneId,
      },
      {
        onChange: () => this.handleManagerChange(),
        onResult: (run, result) => this.handleResult(run, result),
        onBlocked: (run) => this.deliverBlocked(run),
      },
    );
  }

  async start(): Promise<void> {
    await this.manager.start();
    this.refreshWidget();
    void this.manager.cleanupAll().catch(() => {});
    this.cleanupTimer = setInterval(() => void this.manager.cleanupAll().catch(() => {}), 24 * 60 * 60 * 1000);
    this.cleanupTimer.unref?.();
  }

  dispose(): void {
    this.disposed = true;
    this.manager.stop();
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    if (this.maxWaitTimer) clearTimeout(this.maxWaitTimer);
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    this.debounceTimer = undefined;
    this.maxWaitTimer = undefined;
    this.cleanupTimer = undefined;
    this.pendingSuccesses.clear();
    for (const waiter of this.waiters) {
      waiter.removeAbort?.();
      waiter.reject(new Error("Parent Pi session closed while waiting for subagents"));
    }
    this.waiters.clear();
    if (this.ctx.mode === "tui") this.ctx.ui.setWidget(WIDGET_KEY, undefined);
  }

  /** The single place a spawn's profile name is resolved into a concrete model. */
  async spawn(params: { task_name: string; message: string; profile?: string }, ctx: ExtensionContext, signal?: AbortSignal) {
    const current = ctx.model;
    if (!current?.provider || !current.id) throw new Error("The parent Pi session has no active provider/model pair");
    const selectedName = params.profile ?? this.config.defaultProfile;
    let model: ModelProfile;
    if (selectedName) {
      const selected = this.config.profiles[selectedName];
      if (!selected) {
        const available = Object.keys(this.config.profiles).join(", ") || "none";
        throw new Error(`Unknown model profile '${selectedName}'. Available profiles: ${available}`);
      }
      model = selected;
    } else {
      model = {
        provider: current.provider,
        model: current.id,
        thinking: ctx.thinkingLevel ?? this.pi.getThinkingLevel(),
      };
    }
    if (!ctx.modelRegistry.getAvailable().some((candidate) => candidate.provider === model.provider && candidate.id === model.model)) {
      throw new Error(`Model '${model.provider}/${model.model}' is not available in the parent Pi runtime`);
    }
    const parentSessionFile = ctx.sessionManager.getSessionFile();
    const input: SpawnInput = {
      taskName: params.task_name,
      message: params.message,
      model,
    };
    if (selectedName) input.profile = selectedName;
    if (parentSessionFile) input.parentSessionFile = parentSessionFile;
    if (signal) input.signal = signal;
    return this.manager.spawn(input);
  }

  waitOne(targets: string[] | undefined, signal?: AbortSignal): Promise<CompletionPayload> {
    if (signal?.aborted) return Promise.reject(new HerdrCommandError("Aborted", "aborted"));
    const cleanTargets = targets?.map(cleanTarget).filter(Boolean);
    if (targets && cleanTargets?.length === 0) return Promise.reject(new Error("targets must not be empty"));
    const targetRuns = cleanTargets?.map((target) => this.manager.getRun(target));
    const targetIds = targetRuns ? new Set(targetRuns.map((run) => run.runId)) : undefined;
    const closedWithoutResult = targetRuns?.find((run) => run.status === "closed" && !run.latestResultId);
    if (closedWithoutResult) {
      return Promise.reject(new Error(`Agent '${closedWithoutResult.taskName}' closed without a result`));
    }
    const existing = this.findExistingCompletion(targetIds, targetIds === undefined);
    if (existing) {
      this.manager.markDelivered(existing.run.runId, existing.result.resultId);
      return Promise.resolve(completionPayload(existing.run, existing.result));
    }
    const pending = targetIds
      ? targetRuns!.filter((run) => this.isAwaitingResult(run.runId))
      : this.manager.list().filter((agent) => agent.awaiting_result);
    if (pending.length === 0) {
      return Promise.reject(
        new Error(
          targetIds
            ? `No delegated work is pending for ${targetRuns!.map((run) => run.taskName).join(", ")}`
            : "No subagent has delegated work pending; nothing can complete",
        ),
      );
    }

    return new Promise((resolve, reject) => {
      const waiter: OneWaiter = {
        kind: "one",
        resolve,
        reject,
      };
      if (targetIds) waiter.targets = targetIds;
      const removeAbort = bindAbort(signal, () => {
        this.waiters.delete(waiter);
        reject(new HerdrCommandError("Aborted", "aborted"));
      });
      if (removeAbort) waiter.removeAbort = removeAbort;
      this.waiters.add(waiter);
    });
  }

  waitAll(targets: string[] | undefined, signal?: AbortSignal): Promise<CompletionPayload[]> {
    if (signal?.aborted) return Promise.reject(new HerdrCommandError("Aborted", "aborted"));
    const cleanTargets = targets?.map(cleanTarget).filter(Boolean);
    if (targets && cleanTargets?.length === 0) return Promise.reject(new Error("targets must not be empty"));
    const selectedRuns = cleanTargets
      ? cleanTargets.map((target) => this.manager.getRun(target))
      : this.manager
          .list()
          .filter((agent) => agent.awaiting_result || (Boolean(agent.latest_result_id) && !agent.result_delivered))
          .map((agent) => this.manager.getRun(agent.run_id));
    const runs = [...new Map(selectedRuns.map((run) => [run.runId, run])).values()];
    if (runs.length === 0) return Promise.resolve([]);

    const results = new Map<string, Completion>();
    for (const run of runs) {
      if (run.status === "closed" && !run.latestResultId) {
        return Promise.reject(new Error(`Agent '${run.taskName}' closed without a result`));
      }
      if (this.isAwaitingResult(run.runId) || !FINAL_STATUSES.has(run.status) || !run.latestResultId) continue;
      const result = this.manager.latestResult(run.runId);
      if (!result) continue;
      results.set(run.runId, { run, result });
    }
    if (results.size === runs.length) {
      const completions = runs.map((run) => results.get(run.runId)!);
      for (const completion of completions) {
        this.manager.markDelivered(completion.run.runId, completion.result.resultId);
      }
      return Promise.resolve(completions.map(({ run, result }) => completionPayload(run, result)));
    }

    return new Promise((resolve, reject) => {
      const waiter: AllWaiter = {
        kind: "all",
        targets: new Set(runs.map((run) => run.runId)),
        results,
        resolve,
        reject,
      };
      const removeAbort = bindAbort(signal, () => {
        this.waiters.delete(waiter);
        this.releaseWaiterResults(waiter);
        reject(new HerdrCommandError("Aborted", "aborted"));
      });
      if (removeAbort) waiter.removeAbort = removeAbort;
      this.waiters.add(waiter);
    });
  }

  /** Manager hook: run state changed. Also the entry point the root tests drive directly. */
  handleManagerChange(): void {
    this.refreshWidget();
    // Snapshot the waiters: rejecting one removes it from the set while this loop runs.
    const waiters = [...this.waiters];
    for (const waiter of waiters) {
      if (waiter.kind === "one" && !waiter.targets) {
        this.settleUntargetedWaiter(waiter);
        continue;
      }
      const targets = waiter.targets ?? new Set<string>();
      for (const runId of targets) {
        let run: RunRecord;
        try {
          run = this.manager.getRun(runId);
        } catch (error) {
          this.waiters.delete(waiter);
          waiter.removeAbort?.();
          this.releaseWaiterResults(waiter);
          waiter.reject(error instanceof Error ? error : new Error(String(error)));
          break;
        }
        if (run.status !== "closed" || run.latestResultId) continue;
        this.waiters.delete(waiter);
        waiter.removeAbort?.();
        this.releaseWaiterResults(waiter);
        waiter.reject(new Error(`Agent '${run.taskName}' closed without a result`));
        break;
      }
    }
  }

  /**
   * An untargeted wait_agent must not hang forever once nothing can complete:
   * when no run is still awaiting a result, hand over any undelivered completion
   * or reject so the model regains control.
   */
  private settleUntargetedWaiter(waiter: OneWaiter): void {
    if (this.manager.list().some((agent) => agent.awaiting_result)) return;
    this.waiters.delete(waiter);
    waiter.removeAbort?.();
    const existing = this.findExistingCompletion(undefined, true);
    if (existing) {
      this.manager.markDelivered(existing.run.runId, existing.result.resultId);
      waiter.resolve(completionPayload(existing.run, existing.result));
      return;
    }
    waiter.reject(new Error("Every subagent closed or finished without an undelivered result"));
  }

  private releaseWaiterResults(waiter: CompletionWaiter): void {
    if (waiter.kind !== "all" || waiter.results.size === 0) return;
    const completions = [...waiter.results.values()].filter(
      ({ run, result }) => !this.manager.isDelivered(run.runId, result.resultId),
    );
    if (completions.length) this.deliverCompletions(completions);
  }

  refreshWidget(): void {
    if (this.disposed || this.ctx.mode !== "tui") return;
    const visible = this.manager.list().filter(
      (agent) => ACTIVE_STATUSES.has(agent.agent_status) || Boolean(agent.latest_result_id && !agent.result_delivered),
    );
    if (visible.length === 0) {
      this.ctx.ui.setWidget(WIDGET_KEY, undefined);
      return;
    }
    this.ctx.ui.setWidget(WIDGET_KEY, (_tui, theme) => {
      const text = widgetText(visible, theme);
      return new Text(text, 0, 0);
    });
  }

  /** Manager hook: a run produced a result. Also the entry point the root tests drive directly. */
  handleResult(run: RunRecord, result: RunResult): void {
    if (this.offerToWaiters(run, result)) return;
    if (result.status !== "done" || result.source === "return-to-parent") {
      this.deliverCompletions([{ run, result }]);
      return;
    }
    this.enqueueSuccess({ run, result });
  }

  private enqueueSuccess(completion: Completion): void {
    this.pendingSuccesses.set(resultKey(completion), completion);
    if (!this.maxWaitTimer) this.maxWaitTimer = setTimeout(() => this.flushSuccesses(), SUCCESS_MAX_WAIT_MS);
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => this.flushSuccesses(), SUCCESS_DEBOUNCE_MS);
    this.refreshWidget();
  }

  private flushSuccesses(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    if (this.maxWaitTimer) clearTimeout(this.maxWaitTimer);
    this.debounceTimer = undefined;
    this.maxWaitTimer = undefined;
    const completions = [...this.pendingSuccesses.values()].filter(
      ({ run, result }) => !this.manager.isDelivered(run.runId, result.resultId),
    );
    this.pendingSuccesses.clear();
    if (completions.length) this.deliverCompletions(completions);
  }

  private deliverCompletions(completions: Completion[]): void {
    if (this.disposed) return;
    const payload = completions.map(({ run, result }) => boundedCompletionPayload(run, result));
    try {
      this.pi.sendMessage<ResultMessageDetails>(
        {
          customType: RESULT_MESSAGE_TYPE,
          content: `<herdr_subagent_results>\n${JSON.stringify(payload, null, 2)}\n</herdr_subagent_results>`,
          display: true,
          details: {
            agents: payload.map((entry) => ({ name: entry.agent_name, status: entry.status })),
          },
        },
        this.ctx.isIdle() ? { triggerTurn: true } : { deliverAs: "steer", triggerTurn: true },
      );
    } catch {
      // Never drop a result on a delivery failure: requeue it for the next flush.
      for (const completion of completions) this.pendingSuccesses.set(resultKey(completion), completion);
      if (!this.maxWaitTimer) this.maxWaitTimer = setTimeout(() => this.flushSuccesses(), SUCCESS_MAX_WAIT_MS);
      return;
    }
    for (const { run, result } of completions) this.manager.markDelivered(run.runId, result.resultId);
  }

  private deliverBlocked(run: RunRecord): void {
    if (this.disposed) return;
    this.pi.sendMessage<StatusMessageDetails>(
      {
        customType: STATUS_MESSAGE_TYPE,
        content: `<herdr_subagent_status>\n${JSON.stringify(
          {
            agent_name: run.taskName,
            run_id: run.runId,
            status: "blocked",
            message: run.statusMessage ?? "The visible Pi pane needs input.",
            pane_id: run.paneId,
          },
          null,
          2,
        )}\n</herdr_subagent_status>`,
        display: true,
        details: { agent_name: run.taskName, status: "blocked" },
      },
      this.ctx.isIdle() ? { triggerTurn: true } : { deliverAs: "steer", triggerTurn: true },
    );
  }

  private offerToWaiters(run: RunRecord, result: RunResult): boolean {
    let matched = false;
    // Snapshot the waiters: resolving one removes it from the set while this loop runs.
    const waiters = [...this.waiters];
    for (const waiter of waiters) {
      if (waiter.kind === "one") {
        if (waiter.targets && !waiter.targets.has(run.runId)) continue;
        matched = true;
        this.waiters.delete(waiter);
        waiter.removeAbort?.();
        this.manager.markDelivered(run.runId, result.resultId);
        waiter.resolve(completionPayload(run, result));
        continue;
      }
      if (!waiter.targets.has(run.runId) || waiter.results.has(run.runId)) continue;
      matched = true;
      waiter.results.set(run.runId, { run, result });
      if (waiter.results.size !== waiter.targets.size) continue;
      this.waiters.delete(waiter);
      waiter.removeAbort?.();
      const completions = [...waiter.targets].map((runId) => waiter.results.get(runId)!);
      for (const completion of completions) {
        this.manager.markDelivered(completion.run.runId, completion.result.resultId);
      }
      waiter.resolve(completions.map((completion) => completionPayload(completion.run, completion.result)));
    }
    return matched;
  }

  private isAwaitingResult(runId: string): boolean {
    return Boolean(this.manager.list().find((agent) => agent.run_id === runId)?.awaiting_result);
  }

  private findExistingCompletion(targets: Set<string> | undefined, onlyUndelivered: boolean): Completion | undefined {
    const summaries = this.manager.list().filter((agent) => {
      if (targets && !targets.has(agent.run_id)) return false;
      if (agent.awaiting_result) return false;
      if (!FINAL_STATUSES.has(agent.agent_status) || !agent.latest_result_id) return false;
      return !onlyUndelivered || !agent.result_delivered;
    });
    for (const summary of summaries) {
      const result = this.manager.latestResult(summary.run_id);
      if (result) return { run: this.manager.getRun(summary.run_id), result };
    }
    return undefined;
  }
}

export function registerRootRuntime(pi: ExtensionAPI): void {
  let active: RootRuntime | undefined;
  let startupError: string | undefined;

  const requireRuntime = (): RootRuntime => {
    if (active) return active;
    throw new Error(startupError ?? "pi-herdr-live-agents is not attached to an active parent session");
  };

  const spawnTool = () => ({
    name: "spawn_agent",
    label: "Spawn Herdr Agent",
    get description() {
      const profiles = active ? Object.entries(active.config.profiles) : [];
      const profileText = profiles.length
        ? profiles.map(([name, profile]) => `- ${name}: ${profile.provider}/${profile.model}${profile.thinking ? ` (${profile.thinking})` : ""}`).join("\n")
        : "No named model profiles are configured; omit profile to inherit the parent model.";
      return `Spawn a fresh Pi session in a visible Herdr pane. The child receives only the explicit delegated message plus its normal Pi/project context. Continue independent work after spawning; results return automatically.\n\nAvailable model profiles (profiles change only provider/model/thinking):\n${profileText}`;
    },
    promptSnippet: "Delegate concrete work to visible Pi agents in Herdr panes",
    promptGuidelines: [
      "Use spawn_agent when parallel work, independent exploration, or a separate review will help. Write a self-contained task message because the child does not receive the parent conversation.",
      "Do not wait immediately after spawning when useful parent work remains. The child result is delivered automatically.",
    ],
    parameters: Type.Object({
      task_name: Type.String({ description: "Unique task name using letters, digits, underscores, dashes, and optional slash separators." }),
      message: Type.String({ description: "Complete task prompt written for the child Pi session." }),
      profile: Type.Optional(Type.String({ description: "Optional model profile containing only provider/model/thinking." })),
    }),
    async execute(
      _id: string,
      params: { task_name: string; message: string; profile?: string },
      signal: AbortSignal | undefined,
      _update: AgentToolUpdateCallback<SpawnReceipt | null> | undefined,
      ctx: ExtensionContext,
    ) {
      try {
        const receipt = await requireRuntime().spawn(params, ctx, signal);
        return textResult(spawnReceiptText(receipt), receipt);
      } catch (error) {
        throw new Error(`spawn_agent failed: ${errorMessage(error)}`);
      }
    },
    renderCall(args: { task_name?: string; profile?: string }, theme: Theme) {
      return new Text(
        theme.fg("toolTitle", theme.bold("spawn_agent ")) +
          theme.fg("accent", args.task_name ?? "?") +
          (args.profile ? theme.fg("dim", ` [${args.profile}]`) : ""),
        0,
        0,
      );
    },
    renderResult(result: SpawnResultView, _options: ToolRenderResultOptions, theme: Theme) {
      if (result.isError) return new Text(theme.fg("error", "✗ spawn failed"), 0, 0);
      const accepted = result.details?.accepted;
      return new Text(theme.fg(accepted ? "success" : "warning", `${accepted ? "✓" : "!"} ${result.details?.task_name ?? "agent"}`), 0, 0);
    },
  });

  pi.registerMessageRenderer<ResultMessageDetails>(RESULT_MESSAGE_TYPE, (message, { expanded }, theme) => {
    const agents = message.details?.agents ?? [];
    const label = agents.length === 1 ? (agents[0]?.name ?? "subagent") : `${agents.length} subagents`;
    const failed = agents.some((entry) => entry.status !== "done");
    let text = theme.fg(failed ? "warning" : "success", `${failed ? "!" : "✓"} ${label} returned`);
    if (expanded && !Array.isArray(message.content)) text += `\n${theme.fg("dim", message.content)}`;
    return new Text(text, 0, 0);
  });

  pi.registerMessageRenderer<StatusMessageDetails>(STATUS_MESSAGE_TYPE, (message, { expanded }, theme) => {
    let text = theme.fg("warning", `● ${message.details?.agent_name ?? "subagent"} blocked`);
    if (expanded && !Array.isArray(message.content)) text += `\n${theme.fg("dim", message.content)}`;
    return new Text(text, 0, 0);
  });

  pi.registerTool(spawnTool());
  registerManagementTools(pi, requireRuntime);
  registerCommands(pi, requireRuntime);

  pi.on("session_start", async (_event, ctx) => {
    active?.dispose();
    active = undefined;
    startupError = undefined;
    const parentPaneId = process.env.HERDR_PANE_ID;
    if (process.env.HERDR_ENV !== "1" || !parentPaneId) {
      startupError = "pi-herdr-live-agents requires Pi to run inside Herdr (HERDR_ENV=1)";
      ctx.ui.notify(startupError, "warning");
      return;
    }
    try {
      const config = loadConfig(ctx.cwd, {}, ctx.isProjectTrusted());
      const herdr = new HerdrClient((command, args, options) => pi.exec(command, args, options));
      const runtime = new RootRuntime(pi, ctx, config, herdr, parentPaneId);
      active = runtime;
      await runtime.start();
    } catch (error) {
      active?.dispose();
      active = undefined;
      startupError = errorMessage(error);
      ctx.ui.notify(`pi-herdr-live-agents: ${startupError}`, "error");
    }
  });

  pi.on("session_shutdown", () => {
    active?.dispose();
    active = undefined;
  });
}

function registerManagementTools(pi: ExtensionAPI, runtime: () => RootRuntime): void {
  pi.registerTool({
    name: "wait_agent",
    label: "Wait Herdr Agent",
    description: "Wait for one visible agent completion, or the next completion when targets is omitted. Use only when no useful independent work remains.",
    parameters: Type.Object({ targets: Type.Optional(Type.Array(Type.String())) }),
    async execute(_id, params, signal) {
      return textResult(JSON.stringify(await runtime().waitOne(params.targets, signal), null, 2));
    },
  });

  pi.registerTool({
    name: "wait_all_agents",
    label: "Wait All Herdr Agents",
    description: "Wait until all targeted visible agents complete. Omit targets to wait for the current session's agents.",
    parameters: Type.Object({ targets: Type.Optional(Type.Array(Type.String())) }),
    async execute(_id, params, signal) {
      return textResult(JSON.stringify(await runtime().waitAll(params.targets, signal), null, 2));
    },
  });

  pi.registerTool({
    name: "list_agents",
    label: "List Herdr Agents",
    description: "List visible agents owned by this exact parent Pi session.",
    parameters: Type.Object({ path_prefix: Type.Optional(Type.String()) }),
    async execute(_id, params) {
      const agents = runtime().manager.list(params.path_prefix);
      return textResult(JSON.stringify({ agents }, null, 2), { agents });
    },
  });

  pi.registerTool({
    name: "read_agent_response",
    label: "Read Herdr Agent Response",
    description: "Read a byte slice of one current-session agent result. Defaults to the latest result and 64 KiB; pass result_id plus offset to continue an earlier result safely.",
    parameters: Type.Object({
      target: Type.String(),
      result_id: Type.Optional(Type.String()),
      offset: Type.Optional(Type.Integer({ minimum: 0 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 65536 })),
    }),
    async execute(_id, params) {
      return textResult(
        JSON.stringify(runtime().manager.readResponse(params.target, params.offset, params.limit, params.result_id), null, 2),
      );
    },
  });

  pi.registerTool({
    name: "send_message",
    label: "Message Herdr Agent",
    description: "Send a parent-linked message to a visible agent. Steers active work; otherwise starts a new turn.",
    parameters: Type.Object({ target: Type.String(), message: Type.String() }),
    async execute(_id, params, signal) {
      const result = await runtime().manager.sendMessage(params.target, params.message, signal);
      return textResult(result.delivery === "queued" ? "Message queued for the visible agent." : result.delivery === "steer" ? "Message steered into the visible agent." : "Message started a new visible-agent turn.", result);
    },
  });

  pi.registerTool({
    name: "interrupt_agent",
    label: "Interrupt Herdr Agent",
    description: "Interrupt an agent's current turn while keeping its visible Pi session and pane open.",
    parameters: Type.Object({ target: Type.String() }),
    async execute(_id, params, signal) {
      return textResult("Interrupt request sent.", await runtime().manager.interrupt(params.target, signal));
    },
  });

  pi.registerTool({
    name: "focus_agent",
    label: "Focus Herdr Agent",
    description: "Focus the real Herdr pane occupied by a current-session agent.",
    parameters: Type.Object({ target: Type.String() }),
    async execute(_id, params, signal) {
      return textResult("Focused the visible agent pane.", await runtime().manager.focus(params.target, signal));
    },
  });

  pi.registerTool({
    name: "close_agent",
    label: "Close Herdr Agent",
    description: "Close an idle or completed agent pane owned by this session. Refuses working or blocked agents; the model cannot force closure.",
    parameters: Type.Object({ target: Type.String() }),
    async execute(_id, params, signal) {
      const options: CloseOptions = { force: false };
      if (signal) options.signal = signal;
      return textResult("Closed the visible agent pane.", await runtime().manager.close(params.target, options));
    },
  });
}

function registerCommands(pi: ExtensionAPI, runtime: () => RootRuntime): void {
  const agentsHandler = async (args: string, ctx: ExtensionCommandContext) => {
    const [action, target, flag] = args.trim().split(/\s+/).filter(Boolean);
    if (action === "close-done") {
      const { closed, skipped } = await runtime().manager.closeDone();
      const closedText = closed.length ? `Closed: ${closed.join(", ")}` : "No completed agent panes to close.";
      const skippedText = skipped.length
        ? `\nSkipped: ${skipped.map((entry) => `${entry.agent} (${entry.reason})`).join("; ")}`
        : "";
      ctx.ui.notify(`${closedText}${skippedText}`, skipped.length ? "warning" : "info");
      return;
    }
    if (action === "close") {
      if (!target) {
        ctx.ui.notify("Usage: /agents close <name> [--force]", "warning");
        return;
      }
      await runtime().manager.close(target, { force: flag === "--force" });
      ctx.ui.notify(`Closed ${target}.`, "info");
      return;
    }
    if (action === "purge") {
      const count = runtime().manager.purgeClosed();
      ctx.ui.notify(`Purged ${count} closed run${count === 1 ? "" : "s"}.`, "info");
      return;
    }
    if (action && action !== "list") {
      ctx.ui.notify("Usage: /agents [list|close-done|close <name> [--force]|purge]", "warning");
      return;
    }
    const agents = runtime().manager.list();
    if (agents.length === 0) {
      ctx.ui.notify("No agents belong to this parent session.", "info");
      return;
    }
    const labels = agents.map((agent) => `${statusGlyph(agent.agent_status)} ${agent.agent_name} [${agent.agent_status}]${agent.pane_id ? ` · ${agent.pane_id}` : ""}`);
    const selected = await ctx.ui.select("Herdr subagents — select one to focus", labels);
    const index = selected ? labels.indexOf(selected) : -1;
    if (index >= 0) await runtime().manager.focus(agents[index]!.agent_name);
  };

  pi.registerCommand("agents", {
    description: "List, focus, close, or purge visible Herdr subagents.",
    handler: agentsHandler,
  });
  pi.registerCommand("subagents", {
    description: "Alias for /agents.",
    handler: agentsHandler,
  });
  pi.registerCommand("subagent", {
    description: "Focus one visible Herdr subagent pane.",
    handler: async (args, ctx) => {
      const target = cleanTarget(args);
      if (!target) {
        ctx.ui.notify("Usage: /subagent <name>", "warning");
        return;
      }
      await runtime().manager.focus(target);
    },
  });
}

function completionPayload(run: RunRecord, result: RunResult): CompletionPayload {
  const payload: CompletionPayload = {
    agent_name: run.taskName,
    run_id: run.runId,
    result_id: result.resultId,
    status: result.status,
    response: result.response,
    pane_id: run.paneId,
    tab_id: run.tabId,
    child_session_id: run.childSessionId,
    child_session_file: run.childSessionFile,
  };
  if (result.note) payload.note = result.note;
  if (result.error) payload.error = result.error;
  return payload;
}

function boundedCompletionPayload(run: RunRecord, result: RunResult): BoundedCompletionPayload {
  const page = sliceUtf8(result.response, 0, AUTO_RESULT_LIMIT);
  const payload: BoundedCompletionPayload = completionPayload(run, { ...result, response: page.text });
  if (page.nextOffset !== undefined) {
    payload.truncated = true;
    payload.response_bytes = page.totalBytes;
    payload.next_offset = page.nextOffset;
    payload.read_more = `read_agent_response({ target: ${JSON.stringify(run.runId)}, result_id: ${JSON.stringify(result.resultId)}, offset: ${page.nextOffset}, limit: ${AUTO_RESULT_LIMIT} })`;
  }
  return payload;
}

function widgetText(agents: AgentSummary[], theme: Theme): string {
  const prefix = theme.fg("accent", "Subagents ");
  if (agents.length > 3) {
    const working = agents.filter((agent) => agent.agent_status === "working" || agent.agent_status === "starting").length;
    const blocked = agents.filter((agent) => agent.agent_status === "blocked").length;
    const done = agents.filter((agent) => agent.latest_result_id && !agent.result_delivered).length;
    return `${prefix}${theme.fg("text", String(agents.length))}${theme.fg("dim", ` · ${working} working · ${blocked} blocked · ${done} done · /agents`)}`;
  }
  const entries = agents.map((agent) => `${statusDot(agent.agent_status, theme)} ${theme.fg("text", agent.agent_name)} ${theme.fg("dim", agent.agent_status)}`);
  return `${prefix}${entries.join(theme.fg("dim", "  ·  "))}${theme.fg("dim", "  ·  /agents")}`;
}

function statusDot(status: AgentStatus, theme: Theme): string {
  if (status === "blocked") return theme.fg("warning", "●");
  if (status === "failed") return theme.fg("error", "●");
  if (status === "done") return theme.fg("success", "●");
  if (status === "working" || status === "starting") return theme.fg("accent", "●");
  return theme.fg("muted", "○");
}

function statusGlyph(status: AgentStatus): string {
  if (status === "blocked") return "!";
  if (status === "failed") return "✗";
  if (status === "done") return "✓";
  if (status === "working" || status === "starting") return "●";
  return "○";
}

function spawnReceiptText(receipt: SpawnReceipt): string {
  if (receipt.accepted) return `Spawned ${receipt.task_name} in visible pane ${receipt.pane_id}; the child accepted its task.`;
  return `Opened ${receipt.task_name} in visible pane ${receipt.pane_id}, but the task is still queued (${receipt.agent_status}). Inspect the pane if human input is required.`;
}

function textResult<TDetails = null>(text: string, details: TDetails | null = null): ToolTextResult<TDetails | null> {
  return { content: [{ type: "text", text }], details };
}

function bindAbort(signal: AbortSignal | undefined, callback: () => void): (() => void) | undefined {
  if (!signal) return undefined;
  if (signal.aborted) {
    callback();
    return undefined;
  }
  signal.addEventListener("abort", callback, { once: true });
  return () => signal.removeEventListener("abort", callback);
}

function cleanTarget(target: string): string {
  return target.trim().replace(/^\/+/, "");
}

function resultKey(completion: Completion): string {
  return `${completion.run.runId}:${completion.result.resultId}`;
}
