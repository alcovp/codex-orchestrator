import { runOrchestrator, type OrchestratorRunOptions } from "./orchestratorAgent.js";

export async function main() {
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
- ORCHESTRATOR_BASE_DIR: absolute path to the directory containing worktrees (main, task-...)

Example:
export OPENAI_API_KEY="sk-..."
export ORCHESTRATOR_BASE_DIR="/path/to/your/worktrees"
yarn orchestrator "Refactor billing module and add tests"
*/
