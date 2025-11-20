import { loadEnv } from "./loadEnv.js";
import { ConsoleTaskReporter, createInMemoryTaskSource, runTaskDispatcher } from "./taskDispatcher.js";
import { TelegramTaskSource } from "./taskSources/telegramTaskSource.js";

export async function main() {
  loadEnv();

  const envTasks = process.env.DISPATCH_TASKS;
  const telegramToken = process.env.TELEGRAM_BOT_TOKEN;
  const adminTelegramId = process.env.ADMIN_TELEGRAM_ID;

  const sources = [];
  let stopWhenEmpty = true;

  if (telegramToken && adminTelegramId) {
    const adminId = Number(adminTelegramId);
    if (Number.isNaN(adminId)) {
      console.error("ADMIN_TELEGRAM_ID must be a number.");
      process.exit(1);
    }

    console.log("[dispatcher] Telegram source enabled (polling bot for tasks)");
    sources.push(
      new TelegramTaskSource({
        token: telegramToken,
        adminUserId: adminId,
      }),
    );
    // When polling Telegram, keep running even if no other sources provide tasks.
    stopWhenEmpty = false;
  }

  if (envTasks) {
    const tasks = envTasks
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((description, idx) => ({
        id: `env-${idx + 1}`,
        description,
        source: "env",
      }));

    if (tasks.length > 0) {
      sources.push(createInMemoryTaskSource("env", tasks));
    }
  }

  if (sources.length === 0) {
    console.error(
      [
        "No task sources configured.",
        'Either set TELEGRAM_BOT_TOKEN and ADMIN_TELEGRAM_ID for Telegram polling,',
        'or provide DISPATCH_TASKS="Task 1\\nTask 2" for an in-memory run.',
      ].join(" "),
    );
    process.exit(1);
  }

  await runTaskDispatcher({
    sources,
    reporter: new ConsoleTaskReporter(),
    stopWhenEmpty,
  });
}

main().catch((error) => {
  console.error("Dispatcher failed:", error);
  process.exit(1);
});
