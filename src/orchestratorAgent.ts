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
2) For each subtask from the plan, call codex_run_subtask. Group by parallel_group when plan.can_parallelize=true (subtasks with the same parallel_group can run in parallel; otherwise run sequentially). Choose worktree names like "task-<id>" (sanitized) and use base_branch=main unless the user specifies otherwise.
3) Collect subtask outputs as an array of { subtask_id, worktree_path (absolute), summary } and call codex_merge_results with base_branch=main (unless user specified another base).
4) Final reply to the user MUST be derived from the merge JSON only: status + touched_files + notes (if any). Do not invent code details or add extra commentary beyond that summary.

Example skeleton (pseudocode):
- plan = codex_plan_task({ project_root: "<main-worktree-path>", user_task })
- batches: if plan.can_parallelize then group by parallel_group else run sequentially
- For each batch: run codex_run_subtask for each subtask in parallel; collect { subtask_id, worktree_path (absolute), summary }
- merge = codex_merge_results({ project_root: "<main-worktree-path>", base_branch: "main", subtasks_results })
- Final reply: merge JSON as text (status, notes, touched_files)

Verbose logging requirements (respond in plain text):
- After planner: print "PLAN (N subtasks)" and embed the JSON plan (full or truncated if huge).
- For each subtask: log "SUBTASK <id> @ <worktree> -> <status>" and include the returned JSON summary.
- Before merge: show the array you pass into codex_merge_results (subtask_id/worktree_path/summary).
- After merge: print the merge JSON (status/notes/touched_files).
- Final reply: reiterate merge status + touched_files + notes; keep it concise but include counts (subtasks total/completed).

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
