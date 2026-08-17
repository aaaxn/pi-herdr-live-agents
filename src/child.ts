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
import { errorMessage, jsonObject, jsonString, parseJsonText, type JsonValue } from "./json.js";
import {
  PROTOCOL_VERSION,
  type AgentStatus,
  type ChildState,
  type DispatchRequest,
  type RunRecord,
  type RunResult,
} from "./types.js";

const POLL_INTERVAL_MS = 150;
const INPUT_CONFIRM_TIMEOUT_MS = 5_000;
const TURN_FILE = "linked-turn.json";

type AgentMessage = AgentEndEvent["messages"][number];
/** The caller-supplied half of a RunResult; the rest is stamped by createResult. */
type ResultInput = Omit<RunResult, "version" | "type" | "resultId" | "runId" | "capabilityToken" | "createdAt">;
interface AssistantOutcome {
  response: string;
  status: Extract<AgentStatus, "done" | "failed" | "interrupted">;
  error?: string;
}
type PendingInput = {
  request: DispatchRequest;
  filePath: string;
  deliveryState: "delivered" | "queued";
  sentAt: number;
};

export function registerChildRuntime(pi: ExtensionAPI, directory: string, expectedRunId?: string): void {
  const record = requireOwnedRun(directory, expectedRunId);
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
    const state: ChildState = {
      version: PROTOCOL_VERSION,
      runId: record.runId,
      capabilityToken: record.capabilityToken,
      seq: stateSeq,
      status,
      updatedAt: Date.now(),
    };
    if (message) state.message = message;
    if (childSessionId) state.childSessionId = childSessionId;
    if (childSessionFile) state.childSessionFile = childSessionFile;
    writeChildState(directory, state);
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
      expirePendingInputs(directory, record, pendingInputs, active);
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
      appendEvent(directory, "dispatch.consume-failed", { error: errorMessage(error) });
    } finally {
      polling = false;
    }
  };

  pi.on("session_start", (_event, ctx) => {
    if (pollTimer) clearInterval(pollTimer);
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
    const resultInput: ResultInput = {
      requestId: currentLinkedRequestId,
      source: "linked-turn",
      status: lastStatus,
      response: lastResponse,
    };
    if (lastError) resultInput.error = lastError;
    writeResult(directory, createResult(record, resultInput));
    publishState(lastStatus, lastError);
    currentLinkedRequestId = undefined;
    clearLinkedTurn(directory);
  });

  pi.events.on("herdr:blocked", (data) => {
    // SAFETY: the herdr:blocked channel carries a plain JSON-compatible payload, and
    // jsonObject re-checks the shape at runtime, so an unexpected value decodes to undefined.
    const value = jsonObject(data as JsonValue);
    if (value?.active === false) {
      blockedCount = Math.max(0, blockedCount - 1);
      if (blockedCount === 0) blockedMessage = undefined;
    } else if (value?.active === true) {
      blockedCount += 1;
      blockedMessage = jsonString(value.label) ?? "Waiting for input";
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
      const resultInput: ResultInput = {
        source: "return-to-parent",
        status: lastStatus,
        response: latest,
      };
      if (currentLinkedRequestId) resultInput.requestId = currentLinkedRequestId;
      if (note) resultInput.note = note;
      if (lastError) resultInput.error = lastError;
      writeResult(directory, createResult(record, resultInput));
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
  agentActive: boolean,
): void {
  const deadline = Date.now() - INPUT_CONFIRM_TIMEOUT_MS;
  for (const [message, entries] of pendingInputs) {
    // A queued follow-up is only consumed when the current turn ends, so it may
    // legitimately wait far longer than the confirm timeout while the agent works.
    const expirable = (entry: PendingInput): boolean =>
      entry.sentAt <= deadline && (entry.deliveryState === "delivered" || !agentActive);
    const stale = entries.filter(expirable);
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
    const activeEntries = entries.filter((entry) => !expirable(entry));
    if (activeEntries.length === 0) pendingInputs.delete(message);
    else pendingInputs.set(message, activeEntries);
  }
}

function createResult(record: RunRecord, input: ResultInput): RunResult {
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

function assistantOutcome(messages: AgentMessage[]): AssistantOutcome | undefined {
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
    const outcome: AssistantOutcome = {
      response,
      status: stopReason === "aborted" ? "interrupted" : stopReason === "error" ? "failed" : "done",
    };
    if (error) outcome.error = error;
    return outcome;
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

/**
 * Ownership is proven by readability: the run directory and run.json are created
 * 0700/0600 by the parent, so only the same user can decode the capability token.
 * The token itself never travels through the pane environment or Herdr argv.
 */
function requireOwnedRun(directory: string, expectedRunId?: string): RunRecord {
  const record = readRun(directory);
  if (!record || (expectedRunId !== undefined && record.runId !== expectedRunId)) {
    throw new Error("Invalid pi-herdr-live-agents child ownership metadata");
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
    const value = jsonObject(parseJsonText(fs.readFileSync(path.join(directory, TURN_FILE), "utf8")));
    if (!value) return undefined;
    if (value.runId !== record.runId || value.capabilityToken !== record.capabilityToken) return undefined;
    return jsonString(value.requestId);
  } catch {
    return undefined;
  }
}

function clearLinkedTurn(directory: string): void {
  fs.rmSync(path.join(directory, TURN_FILE), { force: true });
}
