import { Agent, run } from "@openai/agents";

const agent = new Agent({
  name: "SmokeTestAgent",
  instructions: "You are a minimal smoke-test agent.",
  model: "gpt-5.1",
});

export async function main() {
  const taskDescription = process.argv.slice(2).join(" ");

  if (!taskDescription) {
    console.error('Usage: yarn orchestrator "<task description>"');
    process.exit(1);
  }

  try {
    const result = await run(agent, taskDescription);
    console.log(result.finalOutput);
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}

main();

/*
Before running, set the OPENAI_API_KEY environment variable.
Example: yarn orchestrator "Say hello"
*/
