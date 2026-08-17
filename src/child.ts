import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { AgentEndEvent, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  appendEvent,
  listDispatches,
  readAck,
  readChildState,
  readRun,
  removeDispatch,
  writeAck,
  writeAtomicJson,
  writeChildState,
  writeResult,
} from "./storage.js";
import { PROTOCOL_VERSION, type AgentStatus, type DispatchRequest, type RunRecord, type RunResult } from "./types.js";

const POLL_INTERVAL_MS = 150;
const INPUT_CONFIRM_TIMEOUT_MS = 5_000;
const TURN_FILE = "linked-turn.json";

type AgentMessage = AgentEndEvent["messages"][number];
type PendingInput = {
  request: DispatchRequest;
  filePath: string;
  deliveryState: "delivered" | "queued";
  sentAt: number;
};

export function registerChildRuntime(pi: ExtensionAPI, directory: string): void {
  const record = requireOwnedRun(directory);
  let activeContext: ExtensionContext | undefined;
  let pollTimer: NodeJS.Timeout | undefined;
  let polling = false;
  const persistedState = readChildState(directory, record);
  let stateSeq = persistedState?.seq ?? 0;
  let active = false;
  let terminalized =
    persistedState?.status === "done" || persistedState?.status === "failed" || persistedState?.status === "interrupted";
  let blockedCount = 0;
  let blockedMessage: string | undefined;
  let currentLinkedRequestId = readLinkedTurn(directory, record);
  let lastResponse = "";
  let lastError: string | undefined;
  let lastStatus: Extract<AgentStatus, "done" | "failed" | "interrupted"> =
    persistedState?.status === "failed" || persistedState?.status === "interrupted" ? persistedState.status : "done";
  const pendingInputs = new Map<string, PendingInput[]>();

  const publishState = (status: AgentStatus, message?: string): void => {
    const ctx = activeContext;
    stateSeq += 1;
    const childSessionId = ctx?.sessionManager.getSessionId();
    const childSessionFile = ctx?.sessionManager.getSessionFile();
    writeChildState(directory, {
      version: PROTOCOL_VERSION,
      runId: record.runId,
      capabilityToken: record.capabilityToken,
      seq: stateSeq,
      status,
      ...(message ? { message } : {}),
      ...(childSessionId ? { childSessionId } : {}),
      ...(childSessionFile ? { childSessionFile } : {}),
      updatedAt: Date.now(),
    });
  };

  const desiredActiveStatus = (): AgentStatus => {
    if (blockedCount > 0) return "blocked";
    if (active) return "working";
    return terminalized ? lastStatus : "idle";
  };

  const consumeInbox = (): void => {
    const ctx = activeContext;
    if (!ctx || polling) return;
    polling = true;
    try {
      expirePendingInputs(directory, record, pendingInputs);
      if ([...pendingInputs.values()].some((entries) => entries.length > 0)) return;
      const next = listDispatches(directory, record.runId, record.capabilityToken)[0];
      if (!next) return;
      const priorAck = readAck(directory, next.request.requestId, record.capabilityToken);
      if (priorAck) {
        removeDispatch(next.filePath);
        return;
      }
      if (currentLinkedRequestId === next.request.requestId) {
        writeAck(directory, {
          version: PROTOCOL_VERSION,
          type: "dispatch-ack",
          requestId: next.request.requestId,
          runId: record.runId,
          capabilityToken: record.capabilityToken,
          state: "delivered",
          message: "Recovered a delegated input already accepted by Pi.",
          createdAt: Date.now(),
        });
        removeDispatch(next.filePath);
        return;
      }
      deliverRequest(pi, ctx, next, pendingInputs);
    } catch (error) {
      appendEvent(directory, "dispatch.consume-failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      polling = false;
    }
  };

  pi.on("session_start", (_event, ctx) => {
    activeContext = ctx;
    active = !ctx.isIdle();
    publishState(desiredActiveStatus(), blockedMessage);
    consumeInbox();
    pollTimer = setInterval(consumeInbox, POLL_INTERVAL_MS);
    pollTimer.unref?.();
  });

  pi.on("session_shutdown", () => {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = undefined;
    activeContext = undefined;
  });

  pi.on("input", (event) => {
    if (event.source === "extension") {
      const entries = pendingInputs.get(event.text);
      const pending = entries?.shift();
      if (entries?.length === 0) pendingInputs.delete(event.text);
      if (pending) {
        terminalized = false;
        currentLinkedRequestId = pending.request.requestId;
        writeLinkedTurn(directory, record, currentLinkedRequestId);
        writeAck(directory, {
          version: PROTOCOL_VERSION,
          type: "dispatch-ack",
          requestId: pending.request.requestId,
          runId: record.runId,
          capabilityToken: record.capabilityToken,
          state: pending.deliveryState,
          message:
            pending.deliveryState === "delivered"
              ? "Pi accepted the delegated message."
              : "Pi queued the delegated follow-up.",
          createdAt: Date.now(),
        });
        removeDispatch(pending.filePath);
        return { action: "continue" as const };
      }
    }
    terminalized = false;
    // A human typing mid-turn steers the delegated work; the parent still owns
    // that turn and must receive its result. Only a new manual turn breaks the link.
    if (!active) {
      currentLinkedRequestId = undefined;
      clearLinkedTurn(directory);
    }
    return { action: "continue" as const };
  });

  pi.on("agent_start", () => {
    active = true;
    terminalized = false;
    lastResponse = "";
    lastError = undefined;
    lastStatus = "done";
    publishState(desiredActiveStatus(), blockedMessage);
  });

  pi.on("message_end", (event) => {
    const final = assistantOutcome([event.message]);
    if (!final) return;
    lastResponse = final.response;
    lastError = final.error;
    lastStatus = final.status;
  });

  pi.on("agent_end", (event) => {
    const final = assistantOutcome(event.messages);
    if (!final) return;
    lastResponse = final.response;
    lastError = final.error;
    lastStatus = final.status;
  });

  pi.on("agent_settled", () => {
    active = false;
    if (!currentLinkedRequestId) {
      terminalized = false;
      publishState(desiredActiveStatus(), blockedMessage);
      return;
    }

    terminalized = true;
    const result = createResult(record, {
      requestId: currentLinkedRequestId,
      source: "linked-turn",
      status: lastStatus,
      response: lastResponse,
      ...(lastError ? { error: lastError } : {}),
    });
    writeResult(directory, result);
    publishState(lastStatus, lastError);
    currentLinkedRequestId = undefined;
    clearLinkedTurn(directory);
  });

  pi.events.on("herdr:blocked", (data: unknown) => {
    const value = isRecord(data) ? data : {};
    if (value.active === false) {
      blockedCount = Math.max(0, blockedCount - 1);
      if (blockedCount === 0) blockedMessage = undefined;
    } else if (value.active === true) {
      blockedCount += 1;
      blockedMessage = typeof value.label === "string" ? value.label : "Waiting for input";
    }
    publishState(desiredActiveStatus(), blockedMessage);
  });

  pi.registerCommand("return-to-parent", {
    description: "Return the latest final assistant response to the parent subagent session.",
    handler: async (args, ctx) => {
      const latest = lastResponse || latestAssistantFromSession(ctx);
      if (!latest) {
        ctx.ui.notify("No assistant response is available to return.", "warning");
        return;
      }
      const note = args.trim();
      const result = createResult(record, {
        ...(currentLinkedRequestId ? { requestId: currentLinkedRequestId } : {}),
        source: "return-to-parent",
        status: lastStatus,
        response: latest,
        ...(note ? { note } : {}),
        ...(lastError ? { error: lastError } : {}),
      });
      writeResult(directory, result);
      terminalized = true;
      publishState(lastStatus, lastError);
      ctx.ui.notify("Returned the latest response to the parent.", "info");
    },
  });
}

function deliverRequest(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  input: { request: DispatchRequest; filePath: string },
  pendingInputs: Map<string, PendingInput[]>,
): void {
  const { request, filePath } = input;
  const busy = !ctx.isIdle();
  const deliveryState = busy && request.mode === "auto" ? "queued" : "delivered";
  const entries = pendingInputs.get(request.message) ?? [];
  entries.push({ request, filePath, deliveryState, sentAt: Date.now() });
  pendingInputs.set(request.message, entries);
  try {
    if (!busy) pi.sendUserMessage(request.message);
    else pi.sendUserMessage(request.message, { deliverAs: request.mode === "steer" ? "steer" : "followUp" });
  } catch (error) {
    entries.pop();
    if (entries.length === 0) pendingInputs.delete(request.message);
    throw error;
  }
}

function expirePendingInputs(
  directory: string,
  record: RunRecord,
  pendingInputs: Map<string, PendingInput[]>,
): void {
  const deadline = Date.now() - INPUT_CONFIRM_TIMEOUT_MS;
  for (const [message, entries] of pendingInputs) {
    const stale = entries.filter((entry) => entry.sentAt <= deadline);
    if (stale.length === 0) continue;
    for (const pending of stale) {
      writeAck(directory, {
        version: PROTOCOL_VERSION,
        type: "dispatch-ack",
        requestId: pending.request.requestId,
        runId: record.runId,
        capabilityToken: record.capabilityToken,
        state: "failed",
        message: "Pi did not confirm the delegated input within 5 seconds.",
        createdAt: Date.now(),
      });
      removeDispatch(pending.filePath);
      appendEvent(directory, "dispatch.input-timeout", { requestId: pending.request.requestId });
    }
    const activeEntries = entries.filter((entry) => entry.sentAt > deadline);
    if (activeEntries.length === 0) pendingInputs.delete(message);
    else pendingInputs.set(message, activeEntries);
  }
}

function createResult(
  record: RunRecord,
  input: Omit<RunResult, "version" | "type" | "resultId" | "runId" | "capabilityToken" | "createdAt">,
): RunResult {
  return {
    version: PROTOCOL_VERSION,
    type: "result",
    resultId: randomUUID(),
    runId: record.runId,
    capabilityToken: record.capabilityToken,
    ...input,
    createdAt: Date.now(),
  };
}

function assistantOutcome(messages: AgentMessage[]): {
  response: string;
  status: Extract<AgentStatus, "done" | "failed" | "interrupted">;
  error?: string;
} | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || message.role !== "assistant") continue;
    const response = message.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n")
      .trim();
    const stopReason = message.stopReason;
    const error = message.errorMessage;
    if (stopReason === "aborted") return { response, status: "interrupted", ...(error ? { error } : {}) };
    if (stopReason === "error") return { response, status: "failed", ...(error ? { error } : {}) };
    return { response, status: "done", ...(error ? { error } : {}) };
  }
  return undefined;
}

function latestAssistantFromSession(ctx: ExtensionContext): string {
  const entries = ctx.sessionManager.getBranch();
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.type !== "message" || entry.message.role !== "assistant") continue;
    return entry.message.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n")
      .trim();
  }
  return "";
}

function requireOwnedRun(directory: string): RunRecord {
  const record = readRun(directory);
  const token = process.env.PI_HERDR_SUBAGENT_TOKEN;
  const runId = process.env.PI_HERDR_SUBAGENT_RUN_ID;
  if (!record || !token || !runId || record.runId !== runId || record.capabilityToken !== token) {
    throw new Error("Invalid pi-herdr-subagents child ownership metadata");
  }
  return record;
}

function writeLinkedTurn(directory: string, record: RunRecord, requestId: string): void {
  writeAtomicJson(path.join(directory, TURN_FILE), {
    version: PROTOCOL_VERSION,
    runId: record.runId,
    capabilityToken: record.capabilityToken,
    requestId,
  });
}

function readLinkedTurn(directory: string, record: RunRecord): string | undefined {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(directory, TURN_FILE), "utf8")) as unknown;
    if (!isRecord(value)) return undefined;
    if (value.runId !== record.runId || value.capabilityToken !== record.capabilityToken) return undefined;
    return typeof value.requestId === "string" ? value.requestId : undefined;
  } catch {
    return undefined;
  }
}

function clearLinkedTurn(directory: string): void {
  fs.rmSync(path.join(directory, TURN_FILE), { force: true });
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
