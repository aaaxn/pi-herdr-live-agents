import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  errorMessage,
  isJsonObject,
  jsonNumber,
  jsonObject,
  jsonString,
  parseJsonText,
  type JsonObject,
  type JsonValue,
} from "./json.js";
import { THINKING_LEVELS, type ExtensionConfig, type ModelProfile, type ThinkingLevel } from "./types.js";

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

  const config: ExtensionConfig = {
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
  if (defaultProfile !== undefined) config.defaultProfile = defaultProfile;
  return config;
}

interface ConfigLayer {
  defaultProfile?: JsonValue | undefined;
  profiles?: JsonValue | undefined;
  layout?: JsonObject | undefined;
  limits?: JsonObject | undefined;
  retention?: JsonObject | undefined;
}

function readConfigLayer(filePath: string): ConfigLayer {
  if (!fs.existsSync(filePath)) return {};
  let value: JsonValue;
  try {
    value = parseJsonText(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(`Cannot parse ${filePath}: ${errorMessage(error)}`);
  }
  if (!isJsonObject(value)) throw new Error(`${filePath} must contain a JSON object`);
  return {
    defaultProfile: value.defaultProfile,
    profiles: value.profiles,
    layout: jsonObject(value.layout),
    limits: jsonObject(value.limits),
    retention: jsonObject(value.retention),
  };
}

function mergeLayers(global: ConfigLayer, project: ConfigLayer): ConfigLayer {
  return {
    defaultProfile: project.defaultProfile ?? global.defaultProfile,
    profiles: { ...jsonObject(global.profiles), ...jsonObject(project.profiles) },
    layout: { ...global.layout, ...project.layout },
    limits: { ...global.limits, ...project.limits },
    retention: { ...global.retention, ...project.retention },
  };
}

function parseProfiles(value: JsonValue | undefined, label: string): Record<string, ModelProfile> {
  if (value === undefined) return {};
  const entries = jsonObject(value);
  if (entries === undefined) throw new Error(`${label} must be an object`);
  return Object.fromEntries(
    Object.entries(entries).map(([name, raw]) => {
      if (!/^[a-z][a-z0-9_-]{0,31}$/.test(name)) {
        throw new Error(`${label}.${name} must use lowercase letters, digits, underscores, or dashes`);
      }
      return [name, parseProfile(raw, `${label}.${name}`)];
    }),
  );
}

function parseProfile(value: JsonValue | undefined, label: string): ModelProfile {
  const raw = jsonObject(value);
  if (raw === undefined) throw new Error(`${label} must be an object`);
  const profile: ModelProfile = {
    provider: requiredString(raw.provider, `${label}.provider`),
    model: requiredString(raw.model, `${label}.model`),
  };
  const thinking = parseThinking(raw.thinking, `${label}.thinking`);
  if (thinking !== undefined) profile.thinking = thinking;
  return profile;
}

function parseThinking(value: JsonValue | undefined, label: string): ThinkingLevel | undefined {
  if (value === undefined) return undefined;
  const thinking = THINKING_LEVELS.find((level) => level === jsonString(value));
  if (thinking === undefined) throw new Error(`${label} is not a supported Pi thinking level`);
  return thinking;
}

function requiredString(value: JsonValue | undefined, label: string): string {
  const parsed = optionalString(value, label);
  if (!parsed) throw new Error(`${label} must be a non-empty string`);
  return parsed;
}

function optionalString(value: JsonValue | undefined, label: string): string | undefined {
  if (value === undefined) return undefined;
  const text = jsonString(value);
  if (text === undefined || !text.trim()) throw new Error(`${label} must be a non-empty string`);
  return text.trim();
}

function positiveInteger(value: JsonValue | undefined, fallback: number, label: string): number {
  if (value === undefined) return fallback;
  const parsed = jsonNumber(value);
  if (parsed === undefined || !Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

function nonNegativeInteger(value: JsonValue | undefined, fallback: number, label: string): number {
  if (value === undefined) return fallback;
  const parsed = jsonNumber(value);
  if (parsed === undefined || !Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return parsed;
}
