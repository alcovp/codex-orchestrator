import { tool, RunContext } from "@openai/agents";
import { z } from "zod";
import { exec } from "child_process";
import { promisify } from "util";
import { promises as fsPromises } from "fs";
import path from "path";
import type { OrchestratorContext } from "../orchestratorTypes.js";

const execAsync = promisify(exec);

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
  async execute({ worktree, command }, runContext?: RunContext<OrchestratorContext>) {
    const baseDir =
      runContext?.context?.baseDir ??
      process.env.ORCHESTRATOR_BASE_DIR ??
      path.resolve(process.cwd(), "..");

    const cwd = path.resolve(baseDir, worktree);

    try {
      await fsPromises.access(cwd);
    } catch {
      return `❌ Worktree directory "${worktree}" does not exist under "${baseDir}"`;
    }

    if (!isAllowedCommand(command)) {
      return '❌ Command "' +
        command +
        '" is not allowed. Allowed prefixes: git, codex, ls, pwd, cat, npm, yarn, pnpm, pytest, node.';
    }

    try {
      const { stdout, stderr } = await execAsync(command, { cwd });
      const safeStdout = stdout?.trim() ? stdout : "(empty)";
      const safeStderr = stderr?.trim() ? stderr : "(empty)";

      return `# run_repo_command
cwd: ${cwd}
command: ${command}

--- STDOUT ---
${safeStdout}

--- STDERR ---
${safeStderr}`;
    } catch (error: any) {
      const details = error?.stderr || error?.message || String(error);
      return `❌ Command "${command}" failed in "${cwd}":
${details}`;
    }
  },
});
