import { ConsoleTaskReporter, createInMemoryTaskSource, runTaskDispatcher } from "./taskDispatcher.js";

export async function main() {
  const envTasks = process.env.DISPATCH_TASKS;

  if (!envTasks) {
    console.error(
      'Set DISPATCH_TASKS (newline-separated task descriptions) to run the dispatcher, e.g.:\nDISPATCH_TASKS="Run smoke tests\\nAdd telemetry hooks" yarn dispatcher',
    );
    process.exit(1);
  }

  const tasks = envTasks
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((description, idx) => ({
      id: `env-${idx + 1}`,
      description,
      source: "env",
    }));

  if (tasks.length === 0) {
    console.error("DISPATCH_TASKS is set but empty after parsing.");
    process.exit(1);
  }

  await runTaskDispatcher({
    sources: [createInMemoryTaskSource("env", tasks)],
    reporter: new ConsoleTaskReporter(),
    stopWhenEmpty: true,
  });
}

main().catch((error) => {
  console.error("Dispatcher failed:", error);
  process.exit(1);
});
