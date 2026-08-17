import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerChildRuntime } from "./child.js";
import { registerRootRuntime } from "./root.js";

export default function piHerdrLiveAgents(pi: ExtensionAPI): void {
  const childRunDirectory = process.env.PI_HERDR_SUBAGENT_RUN_DIR;
  const childRunId = process.env.PI_HERDR_SUBAGENT_RUN_ID;
  const isChild = process.env.PI_HERDR_SUBAGENT === "1" && Boolean(childRunDirectory);
  // Scrub the mailbox markers so any Pi process this session spawns (a grandchild
  // via a bash tool, for example) cannot adopt the same run directory.
  delete process.env.PI_HERDR_SUBAGENT;
  delete process.env.PI_HERDR_SUBAGENT_RUN_DIR;
  delete process.env.PI_HERDR_SUBAGENT_RUN_ID;
  if (isChild && childRunDirectory) {
    registerChildRuntime(pi, childRunDirectory, childRunId);
    return;
  }
  registerRootRuntime(pi);
}
