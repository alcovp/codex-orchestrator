import { Agent, run } from "@openai/agents";
import path from "node:path";
import type { OrchestratorContext } from "./orchestratorTypes.js";
import { codexPlanTaskTool } from "./tools/codexPlanTaskTool.js";
import { codexRunSubtaskTool } from "./tools/codexRunSubtaskTool.js";
import { codexMergeResultsTool } from "./tools/codexMergeResultsTool.js";
import { runRepoCommandTool } from "./tools/runRepoCommandTool.js";

export interface OrchestratorRunOptions {
  /**
   * High-level task description for the orchestrator, e.g.
   * "Add /api/v1/users/search endpoint and write tests".
   */
  taskDescription: string;

  /**
   * Absolute path to the directory containing all worktrees (defaults to env).
   */
  baseDir?: string;
}

const orchestratorAgent = new Agent<OrchestratorContext>({
  name: "Codex Orchestrator",
  model: "gpt-5.1",
  instructions: `
You are the Codex Orchestrator. You are intentionally dumb: do NOT write code, do NOT analyze source files, do NOT improvise implementation details. Your job is only to call tools and pass JSON between them.

Protocol (for any dev request):
1) Always call codex_plan_task first with the user task and project root to get a JSON plan.
2) For each subtask from the plan, run codex_run_subtask (parallel when parallel_group allows). Choose a worktree name like "task-<id>" or similar; base branch defaults to main unless the user says otherwise.
3) After all subtasks finish, call codex_merge_results with the subtask results (base_branch defaults to main) to combine changes and clean up.
4) Final reply to the user: merge summary/status and the list of touched files/subsystems from the merge JSON. Do not invent code details.

Constraints:
- Never skip codex_plan_task on dev work.
- Never return early without running the tools above.
- Use run_repo_command only for basic git/shell helpers if absolutely necessary; prefer codex_* tools.
`,
  tools: [runRepoCommandTool, codexPlanTaskTool, codexRunSubtaskTool, codexMergeResultsTool],
});

type RunImplementation = typeof run;
let runImplementation: RunImplementation = run;

// For testing: allow injecting a mock run implementation.
export function setRunImplementationForTesting(fn: RunImplementation) {
  runImplementation = fn;
}

export async function runOrchestrator(options: OrchestratorRunOptions): Promise<string> {
  const baseDir: string =
    options.baseDir ?? process.env.ORCHESTRATOR_BASE_DIR ?? path.resolve(process.cwd(), "..");

  try {
    const result = await runImplementation(orchestratorAgent, options.taskDescription, {
      context: { baseDir },
      maxTurns: 30,
    });
    return result.finalOutput ?? "";
  } catch (error) {
    console.error("Failed to run orchestrator agent:", error);
    throw error;
  }
}
