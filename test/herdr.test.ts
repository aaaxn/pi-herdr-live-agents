import { describe, expect, it } from "vitest";
import { compareVersions, HerdrClient, HerdrCommandError, type ExecResult } from "../src/herdr.js";

describe("HerdrClient", () => {
  it("parses and enforces the Herdr client and server versions", async () => {
    const client = new HerdrClient(async (_command, args) => ({
      code: 0,
      stdout:
        args[0] === "--version"
          ? "herdr 0.8.0\n"
          : JSON.stringify({
              client: { version: "0.8.0", protocol: 19 },
              server: { status: "running", version: "0.8.0", protocol: 19, compatible: true },
            }),
      stderr: "",
    }));
    await expect(client.requireVersion("0.8.0")).resolves.toBe("0.8.0");
    await expect(client.requireVersion("0.9.0")).rejects.toThrow("requires Herdr >=0.9.0");
  });

  it("rejects an incompatible Herdr server protocol", async () => {
    const client = new HerdrClient(async (_command, args) => ({
      code: 0,
      stdout:
        args[0] === "--version"
          ? "herdr 0.8.0\n"
          : JSON.stringify({
              client: { protocol: 19 },
              server: { status: "running", version: "0.8.0", protocol: 18, compatible: false },
            }),
      stderr: "",
    }));

    await expect(client.requireVersion()).rejects.toThrow("protocol mismatch");
  });

  it("creates an unfocused tab with explicit cwd and child environment", async () => {
    const calls: string[][] = [];
    const execute = async (_command: string, args: string[]): Promise<ExecResult> => {
      calls.push(args);
      return {
        code: 0,
        stderr: "",
        stdout: JSON.stringify({
          result: {
            tab: { tab_id: "t2", workspace_id: "w1", label: "agents", focused: false, agent_status: "idle" },
            root_pane: {
              pane_id: "p2",
              workspace_id: "w1",
              tab_id: "t2",
              focused: false,
              agent_status: "idle",
            },
          },
        }),
      };
    };
    const client = new HerdrClient(execute);

    await client.createTab({ workspaceId: "w1", cwd: "/repo", label: "agents", env: { RUN_ID: "123" } });

    expect(calls[0]).toEqual([
      "tab",
      "create",
      "--workspace",
      "w1",
      "--cwd",
      "/repo",
      "--label",
      "agents",
      "--no-focus",
      "--env",
      "RUN_ID=123",
    ]);
  });

  it("normalizes executor abort rejections", async () => {
    const abort = new AbortController();
    const client = new HerdrClient(async () => {
      abort.abort();
      throw new Error("process rejected");
    });

    const error = await client.getPane("p1", abort.signal).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ name: "HerdrCommandError", code: "aborted" });
  });

  it("preserves structured Herdr error codes", async () => {
    const client = new HerdrClient(async () => ({
      code: 1,
      stdout: JSON.stringify({ error: { code: "pane_not_found", message: "Pane does not exist" } }),
      stderr: "",
    }));

    const error = await client.getPane("missing").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(HerdrCommandError);
    expect(error).toMatchObject({ message: "Pane does not exist", code: "pane_not_found" });
  });
});

describe("compareVersions", () => {
  it("compares semantic triples", () => {
    expect(compareVersions("0.8.0", "0.8.0")).toBe(0);
    expect(compareVersions("0.8.1", "0.8.0")).toBe(1);
    expect(compareVersions("0.7.9", "0.8.0")).toBe(-1);
  });
});
