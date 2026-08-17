import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createRunDirectory,
  listDispatches,
  listResults,
  listSessionRuns,
  readAck,
  readChildState,
  removeDispatch,
  writeAck,
  writeChildState,
  writeDispatch,
  writeResult,
  writeRun,
} from "../src/storage.js";
import { PROTOCOL_VERSION, type RunRecord } from "../src/types.js";

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-herdr-storage-"));
  process.env.PI_HERDR_SUBAGENTS_STORAGE_DIR = root;
});

afterEach(() => {
  delete process.env.PI_HERDR_SUBAGENTS_STORAGE_DIR;
  fs.rmSync(root, { recursive: true, force: true });
});

describe("run mailbox storage", () => {
  it("persists and validates dispatch, state, acknowledgment, and result artifacts", () => {
    const record = runRecord();
    const directory = createRunDirectory(record.parentSessionId, record.runId);
    writeRun(directory, record);

    const request = {
      version: PROTOCOL_VERSION,
      type: "dispatch" as const,
      requestId: "request-1",
      runId: record.runId,
      capabilityToken: record.capabilityToken,
      message: "Inspect the project",
      mode: "auto" as const,
      createdAt: 10,
    };
    const requestPath = writeDispatch(directory, request);
    expect(listDispatches(directory, record.runId, record.capabilityToken).map((entry) => entry.request)).toEqual([request]);
    removeDispatch(requestPath);
    expect(listDispatches(directory, record.runId, record.capabilityToken)).toEqual([]);

    const ack = {
      version: PROTOCOL_VERSION,
      type: "dispatch-ack" as const,
      requestId: request.requestId,
      runId: record.runId,
      capabilityToken: record.capabilityToken,
      state: "delivered" as const,
      message: "accepted",
      createdAt: 20,
    };
    writeAck(directory, ack);
    expect(readAck(directory, request.requestId, record.capabilityToken)).toEqual(ack);

    const state = {
      version: PROTOCOL_VERSION,
      runId: record.runId,
      capabilityToken: record.capabilityToken,
      seq: 1,
      status: "working" as const,
      updatedAt: 30,
    };
    writeChildState(directory, state);
    expect(readChildState(directory, record)).toEqual(state);

    const result = {
      version: PROTOCOL_VERSION,
      type: "result" as const,
      resultId: "result-1",
      runId: record.runId,
      capabilityToken: record.capabilityToken,
      requestId: request.requestId,
      source: "linked-turn" as const,
      status: "done" as const,
      response: "Mapped the project.",
      createdAt: 40,
    };
    writeResult(directory, result);
    expect(listResults(directory, record)).toEqual([result]);
    expect(listSessionRuns(record.parentSessionId).map((entry) => entry.record.taskName)).toEqual(["explore"]);
  });

  it("does not adopt a misplaced run from another parent session", () => {
    const record = { ...runRecord(), parentSessionId: "parent-2" };
    const directory = createRunDirectory("parent-1", record.runId);
    writeRun(directory, record);

    expect(listSessionRuns("parent-1")).toEqual([]);
  });

  it("rejects a stored run whose fields do not match the protocol", () => {
    const record = runRecord();
    const directory = createRunDirectory(record.parentSessionId, record.runId);
    writeRun(directory, record);
    fs.writeFileSync(path.join(directory, "run.json"), JSON.stringify({ ...record, deliveredResultIds: "none" }));

    expect(listSessionRuns(record.parentSessionId)).toEqual([]);
  });

  it("quarantines requests with the wrong capability token", () => {
    const record = runRecord();
    const directory = createRunDirectory(record.parentSessionId, record.runId);
    writeRun(directory, record);
    writeDispatch(directory, {
      version: PROTOCOL_VERSION,
      type: "dispatch",
      requestId: "bad",
      runId: record.runId,
      capabilityToken: "wrong",
      message: "Do not deliver",
      mode: "auto",
      createdAt: 10,
    });

    expect(listDispatches(directory, record.runId, record.capabilityToken)).toEqual([]);
    expect(fs.readdirSync(path.join(directory, "inbox"))).toEqual([expect.stringMatching(/\.invalid$/)]);
  });
});

function runRecord(): RunRecord {
  return {
    version: PROTOCOL_VERSION,
    runId: "run-1",
    taskName: "explore",
    parentSessionId: "parent-1",
    cwd: "/repo",
    capabilityToken: "secret",
    provider: "openai",
    model: "gpt",
    herdrAgentName: "sa-explore-run1",
    status: "starting",
    deliveredResultIds: [],
    createdAt: 1,
    updatedAt: 1,
  };
}
