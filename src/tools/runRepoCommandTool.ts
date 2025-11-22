import { tool, RunContext } from "@openai/agents";
import { z } from "zod";
import { exec } from "child_process";
import { promisify } from "util";
import { promises as fsPromises } from "fs";
import path from "path";
import type { OrchestratorContext } from "../orchestratorTypes.js";
import { runWithCodexTee } from "./codexExecLogger.js";

const execAsync = promisify(exec);
const LOG_FILE = path.resolve(process.cwd(), "run_repo_command.log");
const DEFAULT_OUTPUT_LIMIT = 4000;

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

function resolveOutputLimit(): number {
  const raw = process.env.RUN_REPO_OUTPUT_LIMIT;
  const parsed = raw ? Number(raw) : NaN;
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }
  return DEFAULT_OUTPUT_LIMIT;
}

function truncate(text: string, limit: number): { value: string; truncated: boolean } {
  if (!text) return { value: "(empty)", truncated: false };
  if (text.length <= limit) return { value: text, truncated: false };
  return {
    value: `${text.slice(0, limit)}\n[truncated ${text.length - limit} chars]`,
    truncated: true,
  };
}

function formatStream(label: string, data: string, limit: number) {
  const safe = data?.trim() ? data.trimEnd() : "(empty)";
  const { value } = truncate(safe, limit);
  return `--- ${label} ---\n${value}`;
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
    runContext?.context?.repoRoot ??
    runContext?.context?.baseDir ??
    process.env.ORCHESTRATOR_BASE_DIR ??
    process.cwd();

  const cwd = path.resolve(baseDir, worktree);
  const traceEnabled = isTruthyEnv("ORCHESTRATOR_TRACE");
  const dryRun = isTruthyEnv("ORCHESTRATOR_DRY_RUN");
  const outputLimit = resolveOutputLimit();

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
    const codexPrefix = command.trim().startsWith("codex");
    const execResult = codexPrefix
      ? await runWithCodexTee({
          command: "bash",
          args: ["-lc", command],
          cwd,
          label: "run_repo_codex",
        })
      : await execAsync(command, { cwd });
    const stdout = execResult.stdout;
    const stderr = execResult.stderr;
    const outcomeMessage = `# run_repo_command
cwd: ${cwd}
command: ${command}

${formatStream("STDOUT", stdout, outputLimit)}

${formatStream("STDERR", stderr, outputLimit)}`;
    await appendLog({ worktree, cwd, command, mode: "execute", outcome: "ok" });
    if (traceEnabled) {
      console.error(`[run_repo_command trace] OK ${command} @ ${cwd}`);
    }
    return outcomeMessage;
  } catch (error: any) {
    const rawDetails = error?.stderr || error?.message || String(error);
    const { value: details } = truncate(rawDetails, outputLimit);
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
        'Directory path (relative to repo root) of the git worktree, e.g. ".", ".codex/jobs/<jobId>/worktrees/task-foo".',
      ),
    command: z
      .string()
      .describe("Shell command to run inside that worktree. Only safe prefixes are allowed."),
  }),
  async execute(params, runContext?: RunContext<OrchestratorContext>) {
    return runRepoCommand(params, runContext);
  },
});
