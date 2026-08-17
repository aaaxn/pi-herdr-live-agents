import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  jsonArray,
  jsonNumber,
  jsonObject,
  jsonString,
  parseJsonText,
  type JsonObject,
  type JsonValue,
} from "./json.js";
import {
  PROTOCOL_VERSION,
  type AgentStatus,
  type ChildState,
  type DispatchAck,
  type DispatchRequest,
  type PanePlacement,
  type RunRecord,
  type RunResult,
  type ThinkingLevel,
} from "./types.js";

const RUN_FILE = "run.json";
const STATE_FILE = "state.json";
const EVENTS_FILE = "events.jsonl";

/** Every document this module serialises: a protocol record or an already-decoded payload. */
export type PersistedDocument = RunRecord | DispatchRequest | DispatchAck | ChildState | RunResult | JsonObject;

/** Fields recorded alongside a lifecycle event in events.jsonl. */
export interface EventFields {
  [field: string]: JsonValue | undefined;
}

export function storageRoot(): string {
  return process.env.PI_HERDR_SUBAGENTS_STORAGE_DIR ?? path.join(os.homedir(), ".pi", "agent", "pi-herdr-subagents", "runs");
}

export function parentScopeKey(parentSessionId: string): string {
  return createHash("sha256").update(parentSessionId).digest("hex").slice(0, 24);
}

export function scopeDir(parentSessionId: string): string {
  return path.join(storageRoot(), parentScopeKey(parentSessionId));
}

export function runDir(parentSessionId: string, runId: string): string {
  return path.join(scopeDir(parentSessionId), runId);
}

export function createRunDirectory(parentSessionId: string, runId: string = randomUUID()): string {
  const directory = runDir(parentSessionId, runId);
  ensurePrivateDir(path.join(directory, "inbox"));
  ensurePrivateDir(path.join(directory, "acks"));
  ensurePrivateDir(path.join(directory, "results"));
  return directory;
}

export function writeRun(directory: string, record: RunRecord): void {
  writeAtomicJson(path.join(directory, RUN_FILE), record);
}

export function readRun(directory: string): RunRecord | undefined {
  return decodeRun(readJsonObject(path.join(directory, RUN_FILE)));
}

export function listSessionRuns(parentSessionId: string): Array<{ directory: string; record: RunRecord }> {
  return listRunDirectories(scopeDir(parentSessionId)).filter(({ record }) => record.parentSessionId === parentSessionId);
}

export function listAllRuns(): Array<{ directory: string; record: RunRecord }> {
  const root = storageRoot();
  let scopes: fs.Dirent[];
  try {
    scopes = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  return scopes
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => listRunDirectories(path.join(root, entry.name)));
}

export function writeDispatch(directory: string, request: DispatchRequest): string {
  const name = `${String(request.createdAt).padStart(13, "0")}-${safeId(request.requestId)}.json`;
  const filePath = path.join(directory, "inbox", name);
  writeAtomicJson(filePath, request);
  appendEvent(directory, "dispatch.requested", {
    requestId: request.requestId,
    mode: request.mode,
    createdAt: request.createdAt,
  });
  return filePath;
}

export function listDispatches(directory: string, runId: string, capabilityToken: string): Array<{ filePath: string; request: DispatchRequest }> {
  const inbox = path.join(directory, "inbox");
  let entries: string[];
  try {
    entries = fs.readdirSync(inbox).filter((entry) => entry.endsWith(".json")).sort();
  } catch {
    return [];
  }

  const requests: Array<{ filePath: string; request: DispatchRequest }> = [];
  for (const entry of entries) {
    const filePath = path.join(inbox, entry);
    const request = decodeDispatch(readJsonObject(filePath), runId, capabilityToken);
    if (!request) {
      quarantine(filePath);
      continue;
    }
    requests.push({ filePath, request });
  }
  return requests;
}

export function removeDispatch(filePath: string): void {
  fs.rmSync(filePath, { force: true });
}

export function writeAck(directory: string, ack: DispatchAck): void {
  writeAtomicJson(ackPath(directory, ack.requestId), ack);
  appendEvent(directory, "dispatch.acknowledged", {
    requestId: ack.requestId,
    state: ack.state,
    message: ack.message,
    createdAt: ack.createdAt,
  });
}

export function readAck(directory: string, requestId: string, capabilityToken: string): DispatchAck | undefined {
  return decodeAck(readJsonObject(ackPath(directory, requestId)), requestId, capabilityToken);
}

export function removeAck(directory: string, requestId: string): void {
  fs.rmSync(ackPath(directory, requestId), { force: true });
}

export function writeChildState(directory: string, state: ChildState): void {
  writeAtomicJson(path.join(directory, STATE_FILE), state);
  const fields: EventFields = {
    seq: state.seq,
    status: state.status,
  };
  if (state.message) fields.message = state.message;
  fields.updatedAt = state.updatedAt;
  appendEvent(directory, "child.state", fields);
}

export function readChildState(directory: string, record: RunRecord): ChildState | undefined {
  return decodeChildState(readJsonObject(path.join(directory, STATE_FILE)), record);
}

export function writeResult(directory: string, result: RunResult): string {
  const filePath = resultPath(directory, result.resultId);
  writeAtomicJson(filePath, result);
  appendEvent(directory, "result.written", {
    resultId: result.resultId,
    requestId: result.requestId,
    source: result.source,
    status: result.status,
    createdAt: result.createdAt,
  });
  return filePath;
}

export function listResults(directory: string, record: RunRecord): RunResult[] {
  const resultsDir = path.join(directory, "results");
  let entries: string[];
  try {
    entries = fs.readdirSync(resultsDir).filter((entry) => entry.endsWith(".json")).sort();
  } catch {
    return [];
  }
  const results: RunResult[] = [];
  for (const entry of entries) {
    const result = decodeResult(readJsonObject(path.join(resultsDir, entry)), record);
    if (!result) continue;
    results.push(result);
  }
  return results.sort((left, right) => left.createdAt - right.createdAt);
}

export function readResult(directory: string, record: RunRecord, resultId: string): RunResult | undefined {
  return decodeResult(readJsonObject(resultPath(directory, resultId)), record);
}

export function appendEvent(directory: string, type: string, data: EventFields = {}): void {
  const line = JSON.stringify({ version: PROTOCOL_VERSION, type, at: Date.now(), ...data });
  try {
    fs.appendFileSync(path.join(directory, EVENTS_FILE), `${line}\n`, { encoding: "utf8", mode: 0o600 });
  } catch {
    // Lifecycle artifacts are useful for diagnosis but never gate agent work.
  }
}

export function removeRunDirectory(directory: string): void {
  fs.rmSync(directory, { recursive: true, force: true });
  try {
    fs.rmdirSync(path.dirname(directory));
  } catch {
    // The parent scope still contains other runs.
  }
}

export function writeAtomicJson(filePath: string, value: PersistedDocument): void {
  ensurePrivateDir(path.dirname(filePath));
  const temporary = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, filePath);
    try {
      fs.chmodSync(filePath, 0o600);
    } catch {
      // chmod is best effort on platforms without POSIX permissions.
    }
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

export function ensurePrivateDir(directory: string): void {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(directory, 0o700);
  } catch {
    // chmod is best effort on platforms without POSIX permissions.
  }
}

function listRunDirectories(directory: string): Array<{ directory: string; record: RunRecord }> {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  const runs: Array<{ directory: string; record: RunRecord }> = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const child = path.join(directory, entry.name);
    const record = readRun(child);
    if (record) runs.push({ directory: child, record });
  }
  return runs.sort((left, right) => left.record.createdAt - right.record.createdAt);
}

function ackPath(directory: string, requestId: string): string {
  return path.join(directory, "acks", `${safeId(requestId)}.json`);
}

function resultPath(directory: string, resultId: string): string {
  return path.join(directory, "results", `${safeId(resultId)}.json`);
}

function safeId(id: string): string {
  return Buffer.from(id).toString("base64url");
}

function quarantine(filePath: string): void {
  try {
    fs.renameSync(filePath, `${filePath}.invalid`);
  } catch {
    fs.rmSync(filePath, { force: true });
  }
}

function readJsonObject(filePath: string): JsonObject | undefined {
  try {
    return jsonObject(parseJsonText(fs.readFileSync(filePath, "utf8")));
  } catch {
    return undefined;
  }
}

function decodeRun(value: JsonObject | undefined): RunRecord | undefined {
  if (value === undefined || value.version !== PROTOCOL_VERSION) return undefined;
  const runId = jsonString(value.runId);
  const taskName = jsonString(value.taskName);
  const parentSessionId = jsonString(value.parentSessionId);
  const cwd = jsonString(value.cwd);
  const capabilityToken = jsonString(value.capabilityToken);
  const provider = jsonString(value.provider);
  const model = jsonString(value.model);
  const herdrAgentName = jsonString(value.herdrAgentName);
  const status = decodeAgentStatus(value.status);
  const deliveredResultIds = decodeStringList(value.deliveredResultIds);
  const createdAt = jsonNumber(value.createdAt);
  const updatedAt = jsonNumber(value.updatedAt);
  if (
    runId === undefined ||
    taskName === undefined ||
    parentSessionId === undefined ||
    cwd === undefined ||
    capabilityToken === undefined ||
    provider === undefined ||
    model === undefined ||
    herdrAgentName === undefined ||
    status === undefined ||
    deliveredResultIds === undefined ||
    createdAt === undefined ||
    updatedAt === undefined
  ) {
    return undefined;
  }

  const record: RunRecord = {
    version: PROTOCOL_VERSION,
    runId,
    taskName,
    parentSessionId,
    cwd,
    capabilityToken,
    provider,
    model,
    herdrAgentName,
    status,
    deliveredResultIds,
    createdAt,
    updatedAt,
  };
  const parentSessionFile = jsonString(value.parentSessionFile);
  if (parentSessionFile !== undefined) record.parentSessionFile = parentSessionFile;
  const profile = jsonString(value.profile);
  if (profile !== undefined) record.profile = profile;
  const thinking = decodeThinking(value.thinking);
  if (thinking !== undefined) record.thinking = thinking;
  const workspaceId = jsonString(value.workspaceId);
  if (workspaceId !== undefined) record.workspaceId = workspaceId;
  const tabId = jsonString(value.tabId);
  if (tabId !== undefined) record.tabId = tabId;
  const paneId = jsonString(value.paneId);
  if (paneId !== undefined) record.paneId = paneId;
  const placement = decodePlacement(value.placement);
  if (placement !== undefined) record.placement = placement;
  const agentTabId = jsonString(value.agentTabId);
  if (agentTabId !== undefined) record.agentTabId = agentTabId;
  const childSessionId = jsonString(value.childSessionId);
  if (childSessionId !== undefined) record.childSessionId = childSessionId;
  const childSessionFile = jsonString(value.childSessionFile);
  if (childSessionFile !== undefined) record.childSessionFile = childSessionFile;
  const statusMessage = jsonString(value.statusMessage);
  if (statusMessage !== undefined) record.statusMessage = statusMessage;
  const pendingRequestId = jsonString(value.pendingRequestId);
  if (pendingRequestId !== undefined) record.pendingRequestId = pendingRequestId;
  const latestResultId = jsonString(value.latestResultId);
  if (latestResultId !== undefined) record.latestResultId = latestResultId;
  const retention = jsonObject(value.retention);
  const deliveredDays = jsonNumber(retention?.deliveredDays);
  const undeliveredDays = jsonNumber(retention?.undeliveredDays);
  if (deliveredDays !== undefined && undeliveredDays !== undefined) {
    record.retention = { deliveredDays, undeliveredDays };
  }
  const closedAt = jsonNumber(value.closedAt);
  if (closedAt !== undefined) record.closedAt = closedAt;
  return record;
}

function decodeDispatch(value: JsonObject | undefined, runId: string, token: string): DispatchRequest | undefined {
  if (value === undefined || value.version !== PROTOCOL_VERSION || value.type !== "dispatch") return undefined;
  if (value.runId !== runId || value.capabilityToken !== token) return undefined;
  const requestId = jsonString(value.requestId);
  const message = jsonString(value.message);
  const mode = decodeDispatchMode(value.mode);
  const createdAt = jsonNumber(value.createdAt);
  if (requestId === undefined || message === undefined || mode === undefined || createdAt === undefined) return undefined;
  if (message.trim().length === 0) return undefined;
  return {
    version: PROTOCOL_VERSION,
    type: "dispatch",
    requestId,
    runId,
    capabilityToken: token,
    message,
    mode,
    createdAt,
  };
}

function decodeAck(value: JsonObject | undefined, requestId: string, token: string): DispatchAck | undefined {
  if (value === undefined || value.version !== PROTOCOL_VERSION || value.type !== "dispatch-ack") return undefined;
  if (value.requestId !== requestId || value.capabilityToken !== token) return undefined;
  const runId = jsonString(value.runId);
  const state = decodeAckState(value.state);
  const message = jsonString(value.message);
  const createdAt = jsonNumber(value.createdAt);
  if (runId === undefined || state === undefined || message === undefined || createdAt === undefined) return undefined;
  return {
    version: PROTOCOL_VERSION,
    type: "dispatch-ack",
    requestId,
    runId,
    capabilityToken: token,
    state,
    message,
    createdAt,
  };
}

function decodeChildState(value: JsonObject | undefined, record: RunRecord): ChildState | undefined {
  if (value === undefined || value.version !== PROTOCOL_VERSION) return undefined;
  if (value.runId !== record.runId || value.capabilityToken !== record.capabilityToken) return undefined;
  const seq = jsonNumber(value.seq);
  const status = decodeAgentStatus(value.status);
  const updatedAt = jsonNumber(value.updatedAt);
  if (seq === undefined || status === undefined || updatedAt === undefined) return undefined;

  const state: ChildState = {
    version: PROTOCOL_VERSION,
    runId: record.runId,
    capabilityToken: record.capabilityToken,
    seq,
    status,
    updatedAt,
  };
  const message = jsonString(value.message);
  if (message !== undefined) state.message = message;
  const childSessionId = jsonString(value.childSessionId);
  if (childSessionId !== undefined) state.childSessionId = childSessionId;
  const childSessionFile = jsonString(value.childSessionFile);
  if (childSessionFile !== undefined) state.childSessionFile = childSessionFile;
  return state;
}

function decodeResult(value: JsonObject | undefined, record: RunRecord): RunResult | undefined {
  if (value === undefined || value.version !== PROTOCOL_VERSION || value.type !== "result") return undefined;
  if (value.runId !== record.runId || value.capabilityToken !== record.capabilityToken) return undefined;
  const resultId = jsonString(value.resultId);
  const source = decodeResultSource(value.source);
  const status = decodeResultStatus(value.status);
  const response = jsonString(value.response);
  const createdAt = jsonNumber(value.createdAt);
  if (
    resultId === undefined ||
    source === undefined ||
    status === undefined ||
    response === undefined ||
    createdAt === undefined
  ) {
    return undefined;
  }

  const result: RunResult = {
    version: PROTOCOL_VERSION,
    type: "result",
    resultId,
    runId: record.runId,
    capabilityToken: record.capabilityToken,
    source,
    status,
    response,
    createdAt,
  };
  const requestId = jsonString(value.requestId);
  if (requestId !== undefined) result.requestId = requestId;
  const note = jsonString(value.note);
  if (note !== undefined) result.note = note;
  const error = jsonString(value.error);
  if (error !== undefined) result.error = error;
  return result;
}

function decodeStringList(value: JsonValue | undefined): string[] | undefined {
  const entries = jsonArray(value);
  if (entries === undefined) return undefined;
  const list: string[] = [];
  for (const entry of entries) {
    const text = jsonString(entry);
    if (text === undefined) return undefined;
    list.push(text);
  }
  return list;
}

function decodeAgentStatus(value: JsonValue | undefined): AgentStatus | undefined {
  if (
    value === "starting" ||
    value === "working" ||
    value === "blocked" ||
    value === "done" ||
    value === "failed" ||
    value === "interrupted" ||
    value === "idle" ||
    value === "closed"
  ) {
    return value;
  }
  return undefined;
}

function decodeThinking(value: JsonValue | undefined): ThinkingLevel | undefined {
  if (
    value === "off" ||
    value === "minimal" ||
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh" ||
    value === "max"
  ) {
    return value;
  }
  return undefined;
}

function decodePlacement(value: JsonValue | undefined): PanePlacement | undefined {
  return value === "sibling" || value === "agents-tab" ? value : undefined;
}

function decodeDispatchMode(value: JsonValue | undefined): DispatchRequest["mode"] | undefined {
  return value === "auto" || value === "steer" ? value : undefined;
}

function decodeAckState(value: JsonValue | undefined): DispatchAck["state"] | undefined {
  return value === "delivered" || value === "queued" || value === "failed" ? value : undefined;
}

function decodeResultSource(value: JsonValue | undefined): RunResult["source"] | undefined {
  return value === "linked-turn" || value === "return-to-parent" || value === "runtime" ? value : undefined;
}

function decodeResultStatus(value: JsonValue | undefined): RunResult["status"] | undefined {
  return value === "done" || value === "failed" || value === "interrupted" ? value : undefined;
}
