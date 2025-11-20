import { tool, RunContext } from "@openai/agents";
import { z } from "zod";
import { exec } from "child_process";
import { promisify } from "util";
import { promises as fsPromises } from "fs";
import path from "path";
import type { OrchestratorContext } from "../orchestratorTypes.js";

const execAsync = promisify(exec);
const LOG_FILE = path.resolve(process.cwd(), "run_repo_command.log");

function isTruthyEnv(name: string): boolean {
  const value = process.env[name];
  if (!value) return false;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function isAllowedCommand(command: string): boolean {
  const trimmed = command.trim();
  const allowedPrefixes = [
    "git ",
    "codex ",
    "ls",
    "ls ",
    "pwd",
    "pwd ",
    "cat ",
    "npm ",
    "yarn ",
    "pnpm ",
    "pytest ",
    "node ",
  ];

  return allowedPrefixes.some((prefix) => {
    if (prefix === "ls") {
      return trimmed === "ls";
    }
    if (prefix === "pwd") {
      return trimmed === "pwd";
    }
    return trimmed.startsWith(prefix);
  });
}

function detectForbiddenGit(command: string): string | null {
  const normalized = command.trim().toLowerCase().replace(/\s+/g, " ");
  const rules: Array<{ pattern: RegExp; reason: string }> = [
    { pattern: /\bgit\s+push\b/, reason: "git push is blocked" },
    { pattern: /\bgit\s+remote\b/, reason: "git remote modifications are blocked" },
    { pattern: /\bgit\s+reset\b/, reason: "git reset is blocked" },
    { pattern: /\bgit\s+rebase\b/, reason: "git rebase is blocked" },
  ];

  const match = rules.find((rule) => rule.pattern.test(normalized));
  return match?.reason ?? null;
}

async function appendLog(entry: {
  worktree: string;
  cwd: string;
  command: string;
  mode: "dry-run" | "execute";
  outcome: string;
}) {
  const timestamp = new Date().toISOString();
  const lines = [
    `[${timestamp}] worktree=${entry.worktree} cwd=${entry.cwd}`,
    `mode=${entry.mode}`,
    `command=${entry.command}`,
    `outcome=${entry.outcome}`,
    "---",
  ];

  try {
    await fsPromises.appendFile(LOG_FILE, lines.join("\n") + "\n");
  } catch (error) {
    // Swallow logging failures; tracing will surface them if enabled.
    if (isTruthyEnv("ORCHESTRATOR_TRACE")) {
      console.error("run_repo_command log append failed:", error);
    }
  }
}

export async function runRepoCommand(
  { worktree, command }: { worktree: string; command: string },
  runContext?: RunContext<OrchestratorContext>,
) {
  const baseDir =
    runContext?.context?.baseDir ??
    process.env.ORCHESTRATOR_BASE_DIR ??
    path.resolve(process.cwd(), "..");

  const cwd = path.resolve(baseDir, worktree);
  const traceEnabled = isTruthyEnv("ORCHESTRATOR_TRACE");
  const dryRun = isTruthyEnv("ORCHESTRATOR_DRY_RUN");

  try {
    await fsPromises.access(cwd);
  } catch {
    const outcome = `❌ Worktree directory "${worktree}" does not exist under "${baseDir}"`;
    await appendLog({
      worktree,
      cwd,
      command,
      mode: dryRun ? "dry-run" : "execute",
      outcome,
    });
    return outcome;
  }

  if (!isAllowedCommand(command)) {
    const outcome =
      '❌ Command "' +
      command +
      '" is not allowed. Allowed prefixes: git, codex, ls, pwd, cat, npm, yarn, pnpm, pytest, node.';
    await appendLog({ worktree, cwd, command, mode: "execute", outcome });
    return outcome;
  }

  const forbiddenGitReason = detectForbiddenGit(command);
  if (forbiddenGitReason) {
    const outcome = `❌ Command "${command}" is blocked: ${forbiddenGitReason}.`;
    await appendLog({ worktree, cwd, command, mode: "execute", outcome });
    return outcome;
  }

  if (dryRun) {
    const outcome = `# run_repo_command (dry-run)
cwd: ${cwd}
command: ${command}

--- STDOUT ---
(skipped)

--- STDERR ---
(skipped)`;
    await appendLog({ worktree, cwd, command, mode: "dry-run", outcome: "skipped (dry-run)" });
    if (traceEnabled) {
      console.error(`[run_repo_command trace] DRY-RUN ${command} @ ${cwd}`);
    }
    return outcome;
  }

  try {
    const { stdout, stderr } = await execAsync(command, { cwd });
    const safeStdout = stdout?.trim() ? stdout : "(empty)";
    const safeStderr = stderr?.trim() ? stderr : "(empty)";

    const outcomeMessage = `# run_repo_command
cwd: ${cwd}
command: ${command}

--- STDOUT ---
${safeStdout}

--- STDERR ---
${safeStderr}`;
    await appendLog({ worktree, cwd, command, mode: "execute", outcome: "ok" });
    if (traceEnabled) {
      console.error(`[run_repo_command trace] OK ${command} @ ${cwd}`);
    }
    return outcomeMessage;
  } catch (error: any) {
    const details = error?.stderr || error?.message || String(error);
    const outcome = `❌ Command "${command}" failed in "${cwd}":
${details}`;
    await appendLog({ worktree, cwd, command, mode: "execute", outcome });
    if (traceEnabled) {
      console.error(`[run_repo_command trace] FAIL ${command} @ ${cwd}: ${details}`);
    }
    return outcome;
  }
}

export const runRepoCommandTool = tool({
  name: "run_repo_command",
  description: "Run a SAFE shell command inside a specific worktree directory.",
  parameters: z.object({
    worktree: z
      .string()
      .describe(
        'Directory name of the git worktree under baseDir, e.g. "main" or "task-users-search".',
      ),
    command: z
      .string()
      .describe("Shell command to run inside that worktree. Only safe prefixes are allowed."),
  }),
  async execute(params, runContext?: RunContext<OrchestratorContext>) {
    return runRepoCommand(params, runContext);
  },
});
