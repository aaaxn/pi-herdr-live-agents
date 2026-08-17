export const PROTOCOL_VERSION = 1 as const;

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export const AGENT_STATUSES = [
  "starting",
  "working",
  "blocked",
  "done",
  "failed",
  "interrupted",
  "idle",
  "closed",
] as const;
export type AgentStatus = (typeof AGENT_STATUSES)[number];

/** The lifecycle states the Herdr CLI itself reports for a pane's agent. */
export type NativeAgentStatus = "idle" | "working" | "blocked" | "done" | "unknown";

/** Statuses that count against concurrency limits and mean a result is still coming. */
export const ACTIVE_STATUSES: ReadonlySet<AgentStatus> = new Set(["starting", "working", "blocked"]);

export interface ModelProfile {
  provider: string;
  model: string;
  thinking?: ThinkingLevel;
}

export interface ExtensionConfig {
  defaultProfile?: string;
  profiles: Record<string, ModelProfile>;
  layout: {
    minPaneWidth: number;
    minPaneHeight: number;
  };
  limits: {
    maxConcurrentAgents: number;
    maxOpenPanes: number;
  };
  retention: {
    deliveredDays: number;
    undeliveredDays: number;
  };
}

export type PanePlacement = "sibling" | "agents-tab";

export interface RunRecord {
  version: typeof PROTOCOL_VERSION;
  runId: string;
  taskName: string;
  parentSessionId: string;
  parentSessionFile?: string;
  cwd: string;
  capabilityToken: string;
  profile?: string;
  provider: string;
  model: string;
  thinking?: ThinkingLevel;
  herdrAgentName: string;
  workspaceId?: string;
  tabId?: string;
  paneId?: string;
  placement?: PanePlacement;
  agentTabId?: string;
  childSessionId?: string;
  childSessionFile?: string;
  status: AgentStatus;
  statusMessage?: string;
  pendingRequestId?: string;
  latestResultId?: string;
  deliveredResultIds: string[];
  retention?: {
    deliveredDays: number;
    undeliveredDays: number;
  };
  createdAt: number;
  updatedAt: number;
  closedAt?: number;
}

export interface DispatchRequest {
  version: typeof PROTOCOL_VERSION;
  type: "dispatch";
  requestId: string;
  runId: string;
  capabilityToken: string;
  message: string;
  mode: "auto" | "steer";
  createdAt: number;
}

export interface DispatchAck {
  version: typeof PROTOCOL_VERSION;
  type: "dispatch-ack";
  requestId: string;
  runId: string;
  capabilityToken: string;
  state: "delivered" | "queued" | "failed";
  message: string;
  createdAt: number;
}

export interface ChildState {
  version: typeof PROTOCOL_VERSION;
  runId: string;
  capabilityToken: string;
  seq: number;
  status: AgentStatus;
  message?: string;
  childSessionId?: string;
  childSessionFile?: string;
  updatedAt: number;
}

export interface RunResult {
  version: typeof PROTOCOL_VERSION;
  type: "result";
  resultId: string;
  runId: string;
  capabilityToken: string;
  requestId?: string;
  source: "linked-turn" | "return-to-parent" | "runtime";
  status: Extract<AgentStatus, "done" | "failed" | "interrupted">;
  response: string;
  note?: string;
  error?: string;
  createdAt: number;
}

export interface HerdrPane {
  pane_id: string;
  workspace_id: string;
  tab_id: string;
  focused: boolean;
  cwd?: string;
  foreground_cwd?: string;
  label?: string;
  agent?: string;
  agent_status: NativeAgentStatus;
}

export interface HerdrAgent {
  name?: string;
  agent?: string;
  display_agent?: string;
  agent_status: NativeAgentStatus;
  workspace_id: string;
  tab_id: string;
  pane_id: string;
  focused: boolean;
  cwd?: string;
}

export interface HerdrTab {
  tab_id: string;
  workspace_id: string;
  label: string;
  focused: boolean;
  agent_status: NativeAgentStatus;
}

export interface PaneRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PaneLayout {
  workspace_id: string;
  tab_id: string;
  zoomed: boolean;
  focused_pane_id: string;
  area: PaneRect;
  panes: Array<{ pane_id: string; focused: boolean; rect: PaneRect }>;
  splits: Array<{ id: string; direction: "right" | "down"; ratio: number; rect: PaneRect }>;
}

export interface AgentSummary {
  agent_name: string;
  run_id: string;
  agent_status: AgentStatus;
  status_message?: string;
  pane_id?: string;
  tab_id?: string;
  profile?: string;
  provider: string;
  model: string;
  thinking?: ThinkingLevel;
  created_at: number;
  updated_at: number;
  latest_result_id?: string;
  result_delivered: boolean;
  awaiting_result: boolean;
}
