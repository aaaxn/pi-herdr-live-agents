import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  PROTOCOL_VERSION,
  type ChildState,
  type DispatchAck,
  type DispatchRequest,
  type RunRecord,
  type RunResult,
} from "./types.js";

const RUN_FILE = "run.json";
const STATE_FILE = "state.json";
const EVENTS_FILE = "events.jsonl";

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
  const value = readJson(path.join(directory, RUN_FILE));
  if (!isRecord(value) || value.version !== PROTOCOL_VERSION) return undefined;
  if (typeof value.runId !== "string" || typeof value.parentSessionId !== "string" || typeof value.taskName !== "string") {
    return undefined;
  }
  if (!Array.isArray(value.deliveredResultIds)) return undefined;
  return value as unknown as RunRecord;
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
    const value = readJson(filePath);
    if (!isDispatch(value, runId, capabilityToken)) {
      quarantine(filePath);
      continue;
    }
    requests.push({ filePath, request: value });
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
  const value = readJson(ackPath(directory, requestId));
  if (!isRecord(value) || value.version !== PROTOCOL_VERSION || value.type !== "dispatch-ack") return undefined;
  if (value.requestId !== requestId || value.capabilityToken !== capabilityToken) return undefined;
  return value as unknown as DispatchAck;
}

export function removeAck(directory: string, requestId: string): void {
  fs.rmSync(ackPath(directory, requestId), { force: true });
}

export function writeChildState(directory: string, state: ChildState): void {
  writeAtomicJson(path.join(directory, STATE_FILE), state);
  appendEvent(directory, "child.state", {
    seq: state.seq,
    status: state.status,
    ...(state.message ? { message: state.message } : {}),
    updatedAt: state.updatedAt,
  });
}

export function readChildState(directory: string, record: RunRecord): ChildState | undefined {
  const value = readJson(path.join(directory, STATE_FILE));
  if (!isRecord(value) || value.version !== PROTOCOL_VERSION) return undefined;
  if (value.runId !== record.runId || value.capabilityToken !== record.capabilityToken) return undefined;
  if (typeof value.seq !== "number" || typeof value.status !== "string") return undefined;
  return value as unknown as ChildState;
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
    const value = readJson(path.join(resultsDir, entry));
    if (!isResult(value, record)) continue;
    results.push(value);
  }
  return results.sort((left, right) => left.createdAt - right.createdAt);
}

export function readResult(directory: string, record: RunRecord, resultId: string): RunResult | undefined {
  const value = readJson(resultPath(directory, resultId));
  return isResult(value, record) ? value : undefined;
}

export function appendEvent(directory: string, type: string, data: Record<string, unknown> = {}): void {
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

export function writeAtomicJson(filePath: string, value: unknown): void {
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

function readJson(filePath: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return undefined;
  }
}

function isDispatch(value: unknown, runId: string, token: string): value is DispatchRequest {
  if (!isRecord(value) || value.version !== PROTOCOL_VERSION || value.type !== "dispatch") return false;
  return (
    value.runId === runId &&
    value.capabilityToken === token &&
    typeof value.requestId === "string" &&
    typeof value.message === "string" &&
    value.message.trim().length > 0 &&
    (value.mode === "auto" || value.mode === "steer") &&
    typeof value.createdAt === "number"
  );
}

function isResult(value: unknown, record: RunRecord): value is RunResult {
  if (!isRecord(value) || value.version !== PROTOCOL_VERSION || value.type !== "result") return false;
  return (
    value.runId === record.runId &&
    value.capabilityToken === record.capabilityToken &&
    typeof value.resultId === "string" &&
    typeof value.response === "string" &&
    typeof value.createdAt === "number"
  );
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
