import { loadEnv } from "./loadEnv.js";
import { runOrchestrator, type OrchestratorRunOptions } from "./orchestratorAgent.js";

export async function main() {
  loadEnv();

  const taskDescription = process.argv.slice(2).join(" ");

  if (!taskDescription) {
    console.error('Usage: yarn orchestrator "<task description>"');
    process.exit(1);
  }

  const options: OrchestratorRunOptions = {
    taskDescription,
  };

  try {
    const result = await runOrchestrator(options);
    console.log(result);
  } catch (error) {
    console.error("Orchestrator failed:", error);
    process.exitCode = 1;
  }
}

main();

/*
Before running, set:
- OPENAI_API_KEY: your OpenAI key
- ORCHESTRATOR_BASE_DIR: absolute path to the repository root (worktrees go to .codex/jobs/<jobId>/worktrees)

Example:
export OPENAI_API_KEY="sk-..."
export ORCHESTRATOR_BASE_DIR="/path/to/your/repo"
yarn orchestrator "Refactor billing module and add tests"
*/
