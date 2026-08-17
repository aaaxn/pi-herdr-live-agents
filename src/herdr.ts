import {
  jsonBoolean,
  jsonNumber,
  jsonObject,
  jsonString,
  parseJsonText,
  type JsonObject,
  type JsonValue,
} from "./json.js";
import type { HerdrAgent, HerdrPane, HerdrTab, PaneLayout } from "./types.js";

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
  killed?: boolean;
}

export type ExecCommand = (
  command: string,
  args: string[],
  options?: { signal?: AbortSignal; timeout?: number },
) => Promise<ExecResult>;

/** Every Herdr CLI call is bounded so a hung server cannot wedge the allocation lock. */
const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
/** Extra headroom over the `--timeout` Herdr itself applies to `agent start`. */
const START_TIMEOUT_MARGIN_MS = 15_000;

interface HerdrErrorDetail {
  message: string;
  code?: string;
}

interface HerdrClientStatus {
  protocol: number;
}

interface HerdrServerStatus {
  status: string;
  version: string;
  protocol: number;
  compatible?: boolean;
}

interface HerdrRuntimeStatus {
  client: HerdrClientStatus;
  server: HerdrServerStatus;
}

export class HerdrCommandError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = "HerdrCommandError";
  }
}

export function isHerdrError(cause: unknown, ...codes: string[]): cause is HerdrCommandError {
  return cause instanceof HerdrCommandError && (codes.length === 0 || (cause.code !== undefined && codes.includes(cause.code)));
}

export function isHerdrAbort(cause: unknown): boolean {
  return isHerdrError(cause, "aborted");
}

export class HerdrClient {
  constructor(private readonly execute: ExecCommand) {}

  async requireVersion(minimum = "0.8.0", signal?: AbortSignal): Promise<string> {
    const versionResult = await this.run(["--version"], signal);
    const firstLine = versionResult.stdout.trim().split("\n", 1)[0] ?? "";
    const match = firstLine.match(/(\d+)\.(\d+)\.(\d+)/);
    if (!match) throw new Error(`Cannot parse Herdr version from '${firstLine}'`);
    const current = match[0];
    if (compareVersions(current, minimum) < 0) {
      throw new Error(`pi-herdr-live-agents requires Herdr >=${minimum}; found ${current}`);
    }

    const statusResult = await this.run(["status", "--json"], signal);
    const status = parseRuntimeStatus(statusResult.stdout);
    if (status.server.status !== "running") throw new Error(`Herdr server is ${status.server.status}`);
    if (status.server.compatible === false) {
      throw new Error(
        `Herdr client/server protocol mismatch (client ${status.client.protocol}, server ${status.server.protocol})`,
      );
    }
    if (compareVersions(status.server.version, minimum) < 0) {
      throw new Error(`pi-herdr-live-agents requires Herdr server >=${minimum}; found ${status.server.version}`);
    }
    return current;
  }

  async getPane(paneId: string, signal?: AbortSignal): Promise<HerdrPane> {
    const result = await this.json<{ pane: HerdrPane }>(["pane", "get", paneId], signal);
    return result.pane;
  }

  async listPanes(workspaceId: string, signal?: AbortSignal): Promise<HerdrPane[]> {
    const result = await this.json<{ panes: HerdrPane[] }>(["pane", "list", "--workspace", workspaceId], signal);
    return result.panes ?? [];
  }

  async getLayout(paneId: string, signal?: AbortSignal): Promise<PaneLayout> {
    const result = await this.json<{ layout: PaneLayout }>(["pane", "layout", "--pane", paneId], signal);
    return result.layout;
  }

  async listTabs(workspaceId: string, signal?: AbortSignal): Promise<HerdrTab[]> {
    const result = await this.json<{ tabs: HerdrTab[] }>(["tab", "list", "--workspace", workspaceId], signal);
    return result.tabs ?? [];
  }

  async createTab(input: {
    workspaceId: string;
    cwd: string;
    label: string;
    env: Record<string, string>;
    signal?: AbortSignal;
  }): Promise<{ tab: HerdrTab; pane: HerdrPane }> {
    const args = [
      "tab",
      "create",
      "--workspace",
      input.workspaceId,
      "--cwd",
      input.cwd,
      "--label",
      input.label,
      "--no-focus",
      ...envArgs(input.env),
    ];
    const result = await this.json<{ tab: HerdrTab; root_pane: HerdrPane }>(args, input.signal);
    return { tab: result.tab, pane: result.root_pane };
  }

  async splitPane(input: {
    sourcePaneId: string;
    direction: "right" | "down";
    cwd: string;
    env: Record<string, string>;
    signal?: AbortSignal;
  }): Promise<HerdrPane> {
    const args = [
      "pane",
      "split",
      input.sourcePaneId,
      "--direction",
      input.direction,
      "--ratio",
      "0.5",
      "--cwd",
      input.cwd,
      "--no-focus",
      ...envArgs(input.env),
    ];
    const result = await this.json<{ pane: HerdrPane }>(args, input.signal);
    return result.pane;
  }

  async renamePane(paneId: string, label: string, signal?: AbortSignal): Promise<void> {
    await this.json(["pane", "rename", paneId, label], signal);
  }

  async closePane(paneId: string, signal?: AbortSignal): Promise<void> {
    await this.json(["pane", "close", paneId], signal);
  }

  async focusAgent(target: string, signal?: AbortSignal): Promise<HerdrAgent> {
    const result = await this.json<{ agent: HerdrAgent }>(["agent", "focus", target], signal);
    return result.agent;
  }

  async getAgent(target: string, signal?: AbortSignal): Promise<HerdrAgent> {
    const result = await this.json<{ agent: HerdrAgent }>(["agent", "get", target], signal);
    return result.agent;
  }

  async listAgents(signal?: AbortSignal): Promise<HerdrAgent[]> {
    const result = await this.json<{ agents: HerdrAgent[] }>(["agent", "list"], signal);
    return result.agents ?? [];
  }

  async startPiAgent(input: {
    name: string;
    paneId: string;
    provider: string;
    model: string;
    thinking?: string;
    timeoutMs?: number;
    signal?: AbortSignal;
  }): Promise<HerdrAgent> {
    const piArgs = ["--provider", input.provider, "--model", input.model];
    if (input.thinking) piArgs.push("--thinking", input.thinking);
    const args = [
      "agent",
      "start",
      input.name,
      "--kind",
      "pi",
      "--pane",
      input.paneId,
      "--timeout",
      String(input.timeoutMs ?? 30_000),
      "--",
      ...piArgs,
    ];
    const result = await this.json<{ agent: HerdrAgent }>(args, input.signal, (input.timeoutMs ?? 30_000) + START_TIMEOUT_MARGIN_MS);
    return result.agent;
  }

  async interruptAgent(target: string, signal?: AbortSignal): Promise<void> {
    await this.json(["agent", "send-keys", target, "esc"], signal);
  }

  private async json<T = JsonObject>(args: string[], signal?: AbortSignal, timeoutMs?: number): Promise<T> {
    const result = await this.run(args, signal, timeoutMs);
    const text = result.stdout.trim();
    if (!text) throw new Error(`Herdr returned no JSON for: herdr ${args.join(" ")}`);
    let decoded: JsonValue;
    try {
      decoded = parseJsonText(text);
    } catch {
      throw new Error(`Herdr returned invalid JSON for: herdr ${args.join(" ")}`);
    }
    const envelope = jsonObject(decoded);
    const failure = envelope?.["error"];
    if (failure) {
      const detail = jsonObject(failure);
      const message = jsonString(detail?.["message"]);
      const code = jsonString(detail?.["code"]);
      throw new HerdrCommandError(message || code || "Herdr request failed", code);
    }
    if (envelope === undefined || !("result" in envelope)) {
      throw new Error(`Herdr response has no result for: herdr ${args.join(" ")}`);
    }
    const payload = envelope["result"];
    // SAFETY: this method validates the envelope framing; the payload itself is the
    // `herdr <args> --json` result documented for the argv each caller passes, and every
    // call site names exactly that documented shape as T.
    return payload as T;
  }

  private async run(args: string[], signal?: AbortSignal, timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS): Promise<ExecResult> {
    const options: NonNullable<Parameters<ExecCommand>[2]> = { timeout: timeoutMs };
    if (signal) options.signal = signal;
    let result: ExecResult;
    try {
      result = await this.execute("herdr", args, options);
    } catch (error) {
      if (signal?.aborted) throw new HerdrCommandError("Aborted", "aborted");
      throw error;
    }
    if (signal?.aborted) throw new HerdrCommandError("Aborted", "aborted");
    if (result.killed) {
      throw new HerdrCommandError(`herdr timed out after ${timeoutMs}ms: herdr ${args.join(" ")}`, "timeout");
    }
    if (result.code !== 0) {
      const parsed = parseHerdrError(result.stderr) ?? parseHerdrError(result.stdout);
      throw new HerdrCommandError(parsed?.message ?? `herdr exited with ${result.code}`, parsed?.code);
    }
    return result;
  }
}

export function compareVersions(left: string, right: string): number {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

function envArgs(env: Record<string, string>): string[] {
  return Object.entries(env).flatMap(([key, value]) => ["--env", `${key}=${value}`]);
}

function parseRuntimeStatus(output: string): HerdrRuntimeStatus {
  let decoded: JsonValue;
  try {
    decoded = parseJsonText(output);
  } catch {
    throw new Error("Herdr status returned invalid JSON");
  }
  const root = jsonObject(decoded);
  const client = jsonObject(root?.["client"]);
  const server = jsonObject(root?.["server"]);
  if (!client || !server) {
    throw new Error("Herdr status response is incomplete");
  }
  const clientProtocol = jsonNumber(client["protocol"]);
  const status = jsonString(server["status"]);
  const version = jsonString(server["version"]);
  const serverProtocol = jsonNumber(server["protocol"]);
  const compatible = jsonBoolean(server["compatible"]);
  if (
    clientProtocol === undefined ||
    status === undefined ||
    version === undefined ||
    serverProtocol === undefined ||
    (server["compatible"] !== undefined && compatible === undefined)
  ) {
    throw new Error("Herdr status response has invalid runtime fields");
  }
  const serverStatus: HerdrServerStatus = { status, version, protocol: serverProtocol };
  if (compatible !== undefined) serverStatus.compatible = compatible;
  return { client: { protocol: clientProtocol }, server: serverStatus };
}

function parseHerdrError(output: string): HerdrErrorDetail | undefined {
  const text = output.trim();
  if (!text) return undefined;
  let decoded: JsonValue;
  try {
    decoded = parseJsonText(text);
  } catch {
    return { message: text };
  }
  const error = jsonObject(jsonObject(decoded)?.["error"]);
  if (!error) return { message: text };
  const message = jsonString(error["message"]);
  const code = jsonString(error["code"]);
  const detail: HerdrErrorDetail = { message: message || code || text };
  if (code) detail.code = code;
  return detail;
}
