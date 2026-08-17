import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const temporary: string[] = [];

afterEach(() => {
  for (const directory of temporary.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("loadConfig", () => {
  it("merges global defaults with project overrides by profile name", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-herdr-config-"));
    temporary.push(directory);
    const global = path.join(directory, "global.json");
    const project = path.join(directory, "project.json");
    fs.writeFileSync(
      global,
      JSON.stringify({
        defaultProfile: "explore",
        profiles: {
          explore: { provider: "openai", model: "gpt-global", thinking: "high" },
          review: { provider: "anthropic", model: "opus" },
        },
        limits: { maxConcurrentAgents: 3 },
      }),
    );
    fs.writeFileSync(
      project,
      JSON.stringify({
        profiles: { explore: { provider: "openai", model: "gpt-project", thinking: "xhigh" } },
        layout: { minPaneWidth: 80 },
      }),
    );

    const config = loadConfig(directory, { global, project });

    expect(config.defaultProfile).toBe("explore");
    expect(config.profiles.explore).toEqual({ provider: "openai", model: "gpt-project", thinking: "xhigh" });
    expect(config.profiles.review).toEqual({ provider: "anthropic", model: "opus" });
    expect(config.layout).toEqual({ minPaneWidth: 80, minPaneHeight: 20 });
    expect(config.limits).toEqual({ maxConcurrentAgents: 3, maxOpenPanes: 8 });
  });

  it("rejects a default profile that does not exist", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-herdr-config-"));
    temporary.push(directory);
    const project = path.join(directory, "project.json");
    fs.writeFileSync(project, JSON.stringify({ defaultProfile: "missing" }));

    expect(() => loadConfig(directory, { global: path.join(directory, "none"), project })).toThrow(
      "defaultProfile 'missing' does not exist",
    );
  });
});
