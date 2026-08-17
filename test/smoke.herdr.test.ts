import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.js";
import { HerdrClient, type ExecResult } from "../src/herdr.js";
import { AgentManager } from "../src/manager.js";
import type { RunResult } from "../src/types.js";

/**
 * Real Herdr smoke test. It creates a visible pane, starts a real child Pi, and
 * waits for the delegated response. The child loads this package from the normal
 * Pi installation, so run it after `pi install`. Enable it explicitly:
 *
 *   PI_HERDR_SMOKE=1 npx vitest run test/smoke.herdr.test.ts
 */
const enabled = process.env.PI_HERDR_SMOKE === "1" && process.env.HERDR_ENV === "1";
const parentPaneId = process.env.HERDR_PANE_ID ?? "";
const sessionId = `smoke-${Date.now()}`;
let storage: string;

beforeAll(() => {
  storage = fs.mkdtempSync(path.join(os.tmpdir(), "pi-herdr-smoke-"));
  process.env.PI_HERDR_SUBAGENTS_STORAGE_DIR = storage;
});

afterAll(() => {
  delete process.env.PI_HERDR_SUBAGENTS_STORAGE_DIR;
  fs.rmSync(storage, { recursive: true, force: true });
});

describe.runIf(enabled)("real Herdr subagent", () => {
  it("opens a visible pane, runs a child Pi, and returns its response", async () => {
    const results: RunResult[] = [];
    const manager = new AgentManager(
      new HerdrClient(runHerdr),
      DEFAULT_CONFIG,
      { sessionId, cwd: process.cwd(), paneId: parentPaneId },
      { onChange: () => {}, onResult: (_run, result) => results.push(result), onBlocked: () => {} },
    );
    await manager.start();

    let receipt: Awaited<ReturnType<AgentManager["spawn"]>> | undefined;
    try {
      receipt = await manager.spawn({
        taskName: "smoke-check",
        message: "Reply with exactly this text and nothing else: SMOKE OK",
        inherited: {
          provider: process.env.PI_HERDR_SMOKE_PROVIDER ?? "anthropic",
          model: process.env.PI_HERDR_SMOKE_MODEL ?? "claude-opus-5",
          thinking: "low",
        },
      });

      expect(receipt.accepted).toBe(true);
      expect(receipt.pane_id).not.toBe(parentPaneId);

      await vi.waitFor(() => expect(results).toHaveLength(1), { timeout: 240_000, interval: 500 });
      expect(results[0]?.status).toBe("done");
      expect(results[0]?.response).toContain("SMOKE OK");
      expect(manager.readResponse("smoke-check").response).toContain("SMOKE OK");
      await manager.close(receipt.run_id, { force: true });
      await expect(new HerdrClient(runHerdr).getPane(receipt.pane_id)).rejects.toThrow();
    } finally {
      if (receipt) {
        await new HerdrClient(runHerdr)
          .closePane(receipt.pane_id)
          .catch((error: unknown) => console.error("pane cleanup failed:", error));
      }
      manager.stop();
    }
  }, 300_000);
});

function runHerdr(command: string, args: string[]): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile(command, args, { maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({
        code: error && typeof (error as { code?: unknown }).code === "number" ? ((error as { code: number }).code) : error ? 1 : 0,
        stdout,
        stderr,
      });
    });
  });
}
