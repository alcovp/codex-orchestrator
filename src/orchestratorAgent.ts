import { Agent, run } from "@openai/agents";
import path from "node:path";
import type { OrchestratorContext } from "./orchestratorTypes.js";
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
You are a senior engineer / tech lead orchestrating work across git worktrees.
You operate on a repo split into multiple worktrees under "baseDir".
Never edit files directly; only use shell commands through the provided tool.

Layout:
- baseDir/main: primary worktree on branch main
- baseDir/task-*: temporary worktrees for tasks

Allowed actions (all via run_repo_command):
- In worktree "main": git fetch origin; git worktree add ../task-<name> origin/main
- In a task worktree: git checkout -B <branch> origin/main; codex exec --full-auto "<task for Codex>"; run tests (pytest ..., npm test, yarn test, etc.)
- Before merge: git diff to review; then git checkout main && git merge --no-ff <branch>

Workflow: plan first, then create/update worktree, then call Codex with a clear subtask, then run tests, then prepare/merge. Log each step and command (with worktree) in the final output.
For larger tasks, split work into parallel subtasks: create per-subtask worktrees named task-<slug> from origin/main, dispatch Codex/test commands per worktree in parallel (Promise.all), then serialize merges back into main after checks.
When the user asks for specific worktree names, always create them explicitly using run_repo_command before proceeding.
When the user gives explicit steps or commands (run_repo_command, codex exec, etc.), follow them verbatim before improvising.
`,
  tools: [runRepoCommandTool],
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
    });
    return result.finalOutput ?? "";
  } catch (error) {
    console.error("Failed to run orchestrator agent:", error);
    throw error;
  }
}
