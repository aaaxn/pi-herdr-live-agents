import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerChildRuntime } from "../src/child.js";
import {
  createRunDirectory,
  listDispatches,
  listResults,
  readAck,
  writeDispatch,
  writeRun,
} from "../src/storage.js";
import { PROTOCOL_VERSION, type DispatchRequest, type RunRecord } from "../src/types.js";

let root: string;
let directory: string;
let record: RunRecord;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-herdr-child-"));
  process.env.PI_HERDR_SUBAGENTS_STORAGE_DIR = root;
  record = runRecord();
  directory = createRunDirectory(record.parentSessionId, record.runId);
  writeRun(directory, record);
  process.env.PI_HERDR_SUBAGENT_RUN_ID = record.runId;
  process.env.PI_HERDR_SUBAGENT_TOKEN = record.capabilityToken;
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env.PI_HERDR_SUBAGENTS_STORAGE_DIR;
  delete process.env.PI_HERDR_SUBAGENT_RUN_ID;
  delete process.env.PI_HERDR_SUBAGENT_TOKEN;
  fs.rmSync(root, { recursive: true, force: true });
});

describe("child mailbox", () => {
  it("keeps a dispatch durable until Pi confirms the extension input", () => {
    const request = dispatch("request-1", "Inspect the parser.", 1);
    writeDispatch(directory, request);
    const runtime = fakePi();
    registerChildRuntime(runtime.pi, directory);

    runtime.emit("session_start", {}, childContext());

    expect(runtime.sent).toEqual([request.message]);
    expect(listDispatches(directory, record.runId, record.capabilityToken)).toHaveLength(1);
    expect(readAck(directory, request.requestId, record.capabilityToken)).toBeUndefined();

    runtime.emit("input", { source: "extension", text: request.message });

    expect(listDispatches(directory, record.runId, record.capabilityToken)).toHaveLength(0);
    expect(readAck(directory, request.requestId, record.capabilityToken)).toMatchObject({
      requestId: request.requestId,
      state: "delivered",
    });
    runtime.emit("session_shutdown", {});
  });

  it("rebuilds an acknowledgement after a crash following accepted input", () => {
    const request = dispatch("request-recovered", "Resume accepted work", 1);
    writeDispatch(directory, request);
    fs.writeFileSync(
      path.join(directory, "linked-turn.json"),
      JSON.stringify({
        version: PROTOCOL_VERSION,
        runId: record.runId,
        capabilityToken: record.capabilityToken,
        requestId: request.requestId,
      }),
    );
    const runtime = fakePi();
    registerChildRuntime(runtime.pi, directory);

    runtime.emit("session_start", {}, childContext());

    expect(runtime.sent).toEqual([]);
    expect(listDispatches(directory, record.runId, record.capabilityToken)).toHaveLength(0);
    expect(readAck(directory, request.requestId, record.capabilityToken)).toMatchObject({
      requestId: request.requestId,
      state: "delivered",
    });
    runtime.emit("session_shutdown", {});
  });

  it("delivers mailbox requests one at a time", async () => {
    const first = dispatch("request-1", "First message", 1);
    const second = dispatch("request-2", "Second message", 2);
    writeDispatch(directory, first);
    writeDispatch(directory, second);
    const runtime = fakePi();
    registerChildRuntime(runtime.pi, directory);

    runtime.emit("session_start", {}, childContext());
    expect(runtime.sent).toEqual([first.message]);

    runtime.emit("input", { source: "extension", text: first.message });
    await vi.waitFor(() => expect(runtime.sent).toEqual([first.message, second.message]));
    runtime.emit("input", { source: "extension", text: second.message });

    expect(listDispatches(directory, record.runId, record.capabilityToken)).toHaveLength(0);
    runtime.emit("session_shutdown", {});
  });

  it("keeps the delegated turn linked when a human types during it", () => {
    const request = dispatch("request-steered", "Delegated work", 1);
    writeDispatch(directory, request);
    const runtime = fakePi();
    registerChildRuntime(runtime.pi, directory);

    runtime.emit("session_start", {}, childContext());
    runtime.emit("input", { source: "extension", text: request.message });
    runtime.emit("agent_start", {});
    runtime.emit("input", { source: "interactive", text: "also check the tests" });
    runtime.emit("agent_end", { messages: [assistantMessage("Finished the delegated work.")] });
    runtime.emit("agent_settled", {});

    const results = listResults(directory, record);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ source: "linked-turn", status: "done", requestId: request.requestId });
    runtime.emit("session_shutdown", {});
  });

  it("reports a failed acknowledgement when Pi never confirms an input", () => {
    vi.useFakeTimers();
    const request = dispatch("request-timeout", "Unconfirmed message", Date.now());
    writeDispatch(directory, request);
    const runtime = fakePi();
    registerChildRuntime(runtime.pi, directory);

    runtime.emit("session_start", {}, childContext());
    vi.advanceTimersByTime(5_200);

    expect(readAck(directory, request.requestId, record.capabilityToken)).toMatchObject({
      requestId: request.requestId,
      state: "failed",
    });
    expect(listDispatches(directory, record.runId, record.capabilityToken)).toHaveLength(0);
    runtime.emit("session_shutdown", {});
  });
});

type Handler = (...args: unknown[]) => void;

interface FakePi {
  pi: ExtensionAPI;
  sent: string[];
  emit(name: string, ...args: unknown[]): void;
}

function fakePi(): FakePi {
  const handlers = new Map<string, Handler[]>();
  const sent: string[] = [];
  // SAFETY: ExtensionAPI.on is a set of per-event overloads. This double dispatches by
  // event name alone, so it deliberately collapses that overload set into one signature.
  const on = ((name: string, handler: Handler) => {
    const entries = handlers.get(name) ?? [];
    entries.push(handler);
    handlers.set(name, entries);
  }) as ExtensionAPI["on"];
  const double: Partial<ExtensionAPI> = {
    on,
    sendUserMessage(message: string) {
      sent.push(message);
    },
    registerCommand: vi.fn(),
    events: { emit: vi.fn(), on: vi.fn() },
  };
  // SAFETY: registerChildRuntime only touches on, sendUserMessage, registerCommand and
  // events, all of which this double provides; the rest of ExtensionAPI is never reached.
  const pi = double as ExtensionAPI;
  return {
    pi,
    sent,
    emit(name, ...args) {
      for (const handler of handlers.get(name) ?? []) handler(...args);
    },
  };
}

function childContext() {
  return {
    isIdle: () => true,
    sessionManager: {
      getSessionId: () => "child-session",
      getSessionFile: () => "/tmp/child-session.jsonl",
      getBranch: () => [],
    },
  };
}

function assistantMessage(text: string) {
  return { role: "assistant", content: [{ type: "text", text }], stopReason: "stop" };
}

function runRecord(): RunRecord {
  return {
    version: PROTOCOL_VERSION,
    runId: "run-1",
    taskName: "child-test",
    parentSessionId: "parent-1",
    cwd: "/repo",
    capabilityToken: "secret-token",
    provider: "openai",
    model: "gpt-test",
    herdrAgentName: "sa-child-test-run-1",
    status: "starting",
    deliveredResultIds: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

function dispatch(requestId: string, message: string, createdAt: number): DispatchRequest {
  return {
    version: PROTOCOL_VERSION,
    type: "dispatch",
    requestId,
    runId: record.runId,
    capabilityToken: record.capabilityToken,
    message,
    mode: "auto",
    createdAt,
  };
}
