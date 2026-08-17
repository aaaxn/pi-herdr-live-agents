import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerChildRuntime } from "./child.js";
import { registerRootRuntime } from "./root.js";

export default function piHerdrSubagents(pi: ExtensionAPI): void {
  const childRunDirectory = process.env.PI_HERDR_SUBAGENT_RUN_DIR;
  if (process.env.PI_HERDR_SUBAGENT === "1" && childRunDirectory) {
    registerChildRuntime(pi, childRunDirectory);
    return;
  }
  registerRootRuntime(pi);
}
