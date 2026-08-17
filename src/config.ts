import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionConfig, ModelProfile, ThinkingLevel } from "./types.js";

export const DEFAULT_CONFIG: ExtensionConfig = {
  profiles: {},
  layout: {
    minPaneWidth: 72,
    minPaneHeight: 20,
  },
  limits: {
    maxConcurrentAgents: 4,
    maxOpenPanes: 8,
  },
  retention: {
    deliveredDays: 7,
    undeliveredDays: 30,
  },
};

export function globalConfigPath(): string {
  return path.join(os.homedir(), ".pi", "agent", "pi-herdr-subagents.json");
}

export function projectConfigPath(cwd: string): string {
  return path.join(cwd, ".pi", "pi-herdr-subagents.json");
}

export function loadConfig(
  cwd: string,
  paths: { global?: string; project?: string } = {},
  includeProject = true,
): ExtensionConfig {
  const global = readConfigLayer(paths.global ?? globalConfigPath());
  const project = includeProject ? readConfigLayer(paths.project ?? projectConfigPath(cwd)) : {};
  const raw = mergeLayers(global, project);

  const profiles = parseProfiles(raw.profiles, "profiles");
  const defaultProfile = optionalString(raw.defaultProfile, "defaultProfile");
  if (defaultProfile && !profiles[defaultProfile]) {
    throw new Error(`defaultProfile '${defaultProfile}' does not exist in profiles`);
  }

  return {
    ...(defaultProfile ? { defaultProfile } : {}),
    profiles,
    layout: {
      minPaneWidth: positiveInteger(raw.layout?.minPaneWidth, DEFAULT_CONFIG.layout.minPaneWidth, "layout.minPaneWidth"),
      minPaneHeight: positiveInteger(raw.layout?.minPaneHeight, DEFAULT_CONFIG.layout.minPaneHeight, "layout.minPaneHeight"),
    },
    limits: {
      maxConcurrentAgents: positiveInteger(
        raw.limits?.maxConcurrentAgents,
        DEFAULT_CONFIG.limits.maxConcurrentAgents,
        "limits.maxConcurrentAgents",
      ),
      maxOpenPanes: positiveInteger(raw.limits?.maxOpenPanes, DEFAULT_CONFIG.limits.maxOpenPanes, "limits.maxOpenPanes"),
    },
    retention: {
      deliveredDays: nonNegativeInteger(
        raw.retention?.deliveredDays,
        DEFAULT_CONFIG.retention.deliveredDays,
        "retention.deliveredDays",
      ),
      undeliveredDays: nonNegativeInteger(
        raw.retention?.undeliveredDays,
        DEFAULT_CONFIG.retention.undeliveredDays,
        "retention.undeliveredDays",
      ),
    },
  };
}

type ConfigLayer = {
  defaultProfile?: unknown;
  profiles?: unknown;
  layout?: Record<string, unknown>;
  limits?: Record<string, unknown>;
  retention?: Record<string, unknown>;
};

function readConfigLayer(filePath: string): ConfigLayer {
  if (!fs.existsSync(filePath)) return {};
  let value: unknown;
  try {
    value = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(`Cannot parse ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(value)) throw new Error(`${filePath} must contain a JSON object`);
  return value;
}

function mergeLayers(global: ConfigLayer, project: ConfigLayer): ConfigLayer {
  return {
    defaultProfile: project.defaultProfile ?? global.defaultProfile,
    profiles: {
      ...(isRecord(global.profiles) ? global.profiles : {}),
      ...(isRecord(project.profiles) ? project.profiles : {}),
    },
    layout: { ...global.layout, ...project.layout },
    limits: { ...global.limits, ...project.limits },
    retention: { ...global.retention, ...project.retention },
  };
}

function parseProfiles(value: unknown, label: string): Record<string, ModelProfile> {
  if (value === undefined) return {};
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  const profiles: Record<string, ModelProfile> = {};
  for (const [name, raw] of Object.entries(value)) {
    if (!/^[a-z][a-z0-9_-]{0,31}$/.test(name)) {
      throw new Error(`${label}.${name} must use lowercase letters, digits, underscores, or dashes`);
    }
    if (!isRecord(raw)) throw new Error(`${label}.${name} must be an object`);
    const provider = requiredString(raw.provider, `${label}.${name}.provider`);
    const model = requiredString(raw.model, `${label}.${name}.model`);
    const thinking = parseThinking(raw.thinking, `${label}.${name}.thinking`);
    profiles[name] = { provider, model, ...(thinking ? { thinking } : {}) };
  }
  return profiles;
}

function parseThinking(value: unknown, label: string): ThinkingLevel | undefined {
  if (value === undefined) return undefined;
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
  throw new Error(`${label} is not a supported Pi thinking level`);
}

function requiredString(value: unknown, label: string): string {
  const parsed = optionalString(value, label);
  if (!parsed) throw new Error(`${label} must be a non-empty string`);
  return parsed;
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value.trim();
}

function positiveInteger(value: unknown, fallback: number, label: string): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || (value as number) < 1) throw new Error(`${label} must be a positive integer`);
  return value as number;
}

function nonNegativeInteger(value: unknown, fallback: number, label: string): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || (value as number) < 0) throw new Error(`${label} must be a non-negative integer`);
  return value as number;
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
