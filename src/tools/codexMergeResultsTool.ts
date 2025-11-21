import { tool, RunContext } from "@openai/agents";
import { z } from "zod";
import { access, mkdir } from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  buildOrchestratorContext,
  DEFAULT_BASE_BRANCH,
  resolveJobId,
  type OrchestratorContext,
} from "../orchestratorTypes.js";

const execFileAsync = promisify(execFile);
const DEFAULT_MAX_BUFFER = 2 * 1024 * 1024;
const OUTPUT_TRUNCATE = 2000;

const MergeInputSchema = z.object({
  project_root: z.string().describe("Absolute or baseDir-relative path to the repository root."),
  job_id: z.string().describe("Job id to place merge worktree under .codex/jobs/<jobId>/worktrees."),
  base_branch: z.string().default("main"),
  result_branch: z.string().describe("Result branch name (e.g., result-<jobId>)."),
  subtasks_results: z
    .array(
      z.object({
        subtask_id: z.string(),
        worktree_path: z.string(),
        branch: z.string(),
        summary: z.string(),
      }),
    )
    .describe("Results from codex_run_subtask: paths may be absolute or relative to project_root."),
});

const MergeOutputSchema = z.object({
  status: z.enum(["ok", "needs_manual_review"]),
  notes: z.string(),
  touched_files: z.array(z.string()),
});

export type CodexMergeResultsInput = z.infer<typeof MergeInputSchema>;
export type CodexMergeResultsResult = z.infer<typeof MergeOutputSchema>;

type MergeExec = (args: {
  program: "git" | "codex";
  args: string[];
  cwd: string;
}) => Promise<{ stdout: string; stderr: string }>;

const defaultExec: MergeExec = async ({ program, args, cwd }) => {
  return execFileAsync(program, args, { cwd, maxBuffer: DEFAULT_MAX_BUFFER });
};

let execImplementation: MergeExec = defaultExec;

export function setMergeExecImplementation(fn: MergeExec | null) {
  execImplementation = fn ?? defaultExec;
}

function resolveProjectRoot(projectRoot: string, runContext?: RunContext<OrchestratorContext>): string {
  if (path.isAbsolute(projectRoot)) return projectRoot;

  const baseDir =
    runContext?.context?.repoRoot ??
    runContext?.context?.baseDir ??
    process.env.ORCHESTRATOR_BASE_DIR ??
    // fallback: current working directory if nothing else is set
    process.cwd();

  return path.resolve(baseDir, projectRoot);
}

function resolveWorktreePath(worktreePath: string, projectRoot: string): string {
  if (path.isAbsolute(worktreePath)) return worktreePath;
  return path.resolve(projectRoot, worktreePath);
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function ensureProjectRoot(p: string) {
  if (!(await pathExists(p))) {
    throw new Error(`project_root does not exist or is not accessible: ${p}`);
  }
}

async function ensureParentDir(p: string) {
  const parent = path.dirname(p);
  await mkdir(parent, { recursive: true });
}

function sanitizeBranchName(name: string, fallback: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9._/-]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned || fallback;
}

function buildMergePrompt(
  subtasksResults: Array<{ subtask_id: string; worktree_path: string; summary: string; branch: string }>,
  targetBranch: string,
  mergeWorktree: string,
): string {
  const jsonPayload = JSON.stringify(subtasksResults, null, 2);
  return [
    `Ты в result-ветке ${targetBranch} (worktree: ${mergeWorktree}).`,
    "",
    "Вот JSON с результатами подзадач:",
    jsonPayload,
    "",
    "Твоя задача:",
    "- Влить все ветки подзадач в эту result-ветку локально (push запрещен).",
    "- Разрулить конфликты, привести стиль к единому виду.",
    "- Обновить документацию/README, если нужно.",
    "- Оставить итоговые коммиты в result-ветке.",
    "- В конце выдать JSON-отчет:",
    "",
    "{",
    '  "status": "ok" | "needs_manual_review",',
    '  "notes": "string",',
    '  "touched_files": ["...", "..."]',
    "}",
    "",
    "Не пиши ничего, кроме валидного JSON.",
  ].join("\n");
}

function tryParseJson(text: string): unknown | null {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function extractJsonObject(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) {
    throw new Error("Merge output is empty");
  }

  const direct = tryParseJson(trimmed);
  if (direct !== null) return direct;

  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first === -1 || last === -1 || last <= first) {
    throw new Error("No JSON object boundaries found in merge output");
  }

  const candidate = trimmed.slice(first, last + 1);
  const parsed = tryParseJson(candidate);
  if (parsed !== null) return parsed;

  throw new Error("Unable to parse JSON object from merge output");
}

function normalizeOutput(raw: unknown): CodexMergeResultsResult {
  const parsed = MergeOutputSchema.parse(raw);
  return {
    ...parsed,
    touched_files: parsed.touched_files ?? [],
  };
}

function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)} ... [truncated ${text.length - limit} chars]`;
}

async function ensureResultBranch(
  repoRoot: string,
  resultBranch: string,
  baseBranch: string,
  exec: MergeExec,
) {
  try {
    await exec({ program: "git", args: ["rev-parse", "--verify", resultBranch], cwd: repoRoot });
    return;
  } catch {
    // fall through
  }
  await exec({
    program: "git",
    args: ["branch", resultBranch, baseBranch],
    cwd: repoRoot,
  });
}

export async function codexMergeResults(
  params: CodexMergeResultsInput,
  runContext?: RunContext<OrchestratorContext>,
): Promise<CodexMergeResultsResult> {
  const repoRoot = resolveProjectRoot(params.project_root, runContext);
  await ensureProjectRoot(repoRoot);

  const resolvedJobId = resolveJobId(params.job_id ?? runContext?.context?.jobId);
  const baseBranch = params.base_branch ?? runContext?.context?.baseBranch ?? DEFAULT_BASE_BRANCH;
  const context = buildOrchestratorContext({
    repoRoot,
    jobId: resolvedJobId,
    baseBranch,
  });

  const resultBranch = sanitizeBranchName(params.result_branch, context.resultBranch);
  const mergeWorktree = path.resolve(context.resultWorktree);
  await ensureParentDir(mergeWorktree);
  await ensureResultBranch(repoRoot, resultBranch, context.baseBranch, execImplementation);

  const exists = await pathExists(mergeWorktree);
  if (!exists) {
    await execImplementation({
      program: "git",
      args: ["worktree", "add", mergeWorktree, resultBranch],
      cwd: repoRoot,
    });
  }

  const resolvedResults = params.subtasks_results.map((r) => ({
    ...r,
    worktree_path: resolveWorktreePath(r.worktree_path, repoRoot),
  }));

  const prompt = buildMergePrompt(resolvedResults, resultBranch, mergeWorktree);
  let stdout = "";
  let stderr = "";

  try {
    const result = await execImplementation({
      program: "codex",
      args: ["exec", "--full-auto", prompt],
      cwd: mergeWorktree,
    });
    stdout = result.stdout ?? "";
    stderr = result.stderr ?? "";
    return normalizeOutput(extractJsonObject(stdout || stderr));
  } catch (error: any) {
    stdout = (error?.stdout ?? stdout ?? "") as string;
    stderr = (error?.stderr ?? stderr ?? error?.message ?? "") as string;
    try {
      return normalizeOutput(extractJsonObject(`${stdout}\n${stderr}`));
    } catch {
      const parts = [
        "codex_merge_results failed: could not parse final JSON.",
        stdout ? `stdout (truncated):\n${truncate(stdout, OUTPUT_TRUNCATE)}` : null,
        stderr ? `stderr (truncated):\n${truncate(stderr, OUTPUT_TRUNCATE)}` : null,
        error?.message ? `error: ${error.message}` : null,
      ].filter(Boolean);
      throw new Error(parts.join("\n\n"));
    }
  }
}

export const codexMergeResultsTool = tool({
  name: "codex_merge_results",
  description: "Create a merge worktree and call Codex CLI to merge subtask results into one branch.",
  parameters: MergeInputSchema,
  async execute(params, runContext?: RunContext<OrchestratorContext>) {
    return codexMergeResults(params, runContext);
  },
});
