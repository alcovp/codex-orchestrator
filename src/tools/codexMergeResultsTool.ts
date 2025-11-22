import { tool, RunContext } from "@openai/agents";
import { z } from "zod";
import { access, mkdir, lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { DEFAULT_CODEX_CAPTURE_LIMIT, runWithCodexTee } from "./codexExecLogger.js";
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
  job_id: z
    .string()
    .describe("Job id to place merge worktree under .codex/jobs/<jobId>/worktrees.")
    .optional()
    .nullable(),
  base_branch: z.string().optional().nullable(),
  result_branch: z.string().describe("Result branch name (e.g., result-<jobId>).").optional().nullable(),
  subtasks_results: z
    .array(
      z.object({
        subtask_id: z.string(),
        worktree_path: z.string(),
        branch: z.string(),
        summary: z.string().optional().nullable(),
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
  label?: string;
  allowNonZero?: boolean;
  captureLimit?: number;
}) => Promise<{ stdout: string; stderr: string }>;

const defaultExec: MergeExec = async ({ program, args, cwd, label, captureLimit }) => {
  if (program === "codex") {
    return runWithCodexTee({
      command: program,
      args,
      cwd,
      label: label ?? "codex-merge",
      captureLimit: captureLimit ?? DEFAULT_CODEX_CAPTURE_LIMIT,
    });
  }

  return execFileAsync(program, args, { cwd, maxBuffer: DEFAULT_MAX_BUFFER });
};

let execImplementation: MergeExec = defaultExec;

export function setMergeExecImplementation(fn: MergeExec | null) {
  execImplementation = fn ?? defaultExec;
}

function resolveProjectRoot(projectRoot: string, runContext?: RunContext<OrchestratorContext>): string {
  if (runContext?.context?.repoRoot) return runContext.context.repoRoot;

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

async function runGit(
  args: string[],
  cwd: string,
  exec: MergeExec,
  allowNonZero = false,
): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const { stdout, stderr } = await exec({ program: "git", args, cwd });
    return { stdout: stdout ?? "", stderr: stderr ?? "", code: 0 };
  } catch (error: any) {
    const code = typeof error?.code === "number" ? error.code : 1;
    if (allowNonZero) {
      return {
        stdout: error?.stdout ?? "",
        stderr: error?.stderr ?? error?.message ?? "",
        code,
      };
    }
    throw error;
  }
}

async function getUnmergedFiles(cwd: string, exec: MergeExec): Promise<string[]> {
  const { stdout } = await runGit(["diff", "--name-only", "--diff-filter=U"], cwd, exec, true);
  return stdout
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

async function collectTouchedFiles(baseBranch: string, cwd: string, exec: MergeExec): Promise<string[]> {
  const { stdout } = await runGit(["diff", "--name-only", `${baseBranch}...HEAD`], cwd, exec, true);
  return stdout
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

async function readGitPointerFile(worktreePath: string): Promise<string> {
  const gitPath = path.join(worktreePath, ".git");
  const stats = await lstat(gitPath);
  if (!stats.isFile()) {
    throw new Error(".git in merge worktree is not a file; Codex may have run git init.");
  }
  return readFile(gitPath, "utf8");
}

async function assertGitPointerUnchanged(worktreePath: string, before: string) {
  const gitPath = path.join(worktreePath, ".git");
  const stats = await lstat(gitPath);
  if (!stats.isFile()) {
    throw new Error(".git in merge worktree was modified (not a file anymore); aborting merge.");
  }
  const after = await readFile(gitPath, "utf8");
  if (after.trim() !== before.trim()) {
    throw new Error(".git pointer was modified during Codex run; aborting merge.");
  }
}

function buildConflictPrompt(branch: string, conflictFiles: string[]): string {
  const list = conflictFiles.length ? conflictFiles.join(", ") : "(unknown)";
  return [
    `Ты находишься в рабочем дереве с текущей веткой после git merge --no-commit ветки "${branch}".`,
    "В файлах есть конфликтные маркеры <<<<<<< ======= >>>>>>>.",
    "",
    "ВАЖНО: НЕЛЬЗЯ выполнять любые git-команды (git init/merge/rebase/commit/push/status и т.п.),",
    "нельзя трогать .git/.git-local и другие git-файлы. Только редактируй файлы.",
    "",
    "Твоя задача:",
    "- Разрешить конфликты в перечисленных файлах.",
    `- Файлы с конфликтами: ${list}`,
    "- Сохранить рабочее дерево без маркеров конфликтов.",
    "",
    "Не выполняй git-команды. Просто правь файлы.",
  ].join("\n");
}

async function resolveConflictsWithCodex({
  branch,
  conflictFiles,
  cwd,
  exec,
}: {
  branch: string;
  conflictFiles: string[];
  cwd: string;
  exec: MergeExec;
}) {
  const gitFileBefore = await readGitPointerFile(cwd);
  const prompt = buildConflictPrompt(branch, conflictFiles);
  await exec({
    program: "codex",
    args: ["exec", "--full-auto", prompt],
    cwd,
    label: `codex-merge-conflicts:${branch}`,
    // captureLimit handled inside runWithCodexTee defaults; explicit for clarity
    captureLimit: DEFAULT_CODEX_CAPTURE_LIMIT,
  });
  await assertGitPointerUnchanged(cwd, gitFileBefore);
}

async function mergeBranchIntoResult(
  branch: string,
  mergeWorktree: string,
  resultBranch: string,
  exec: MergeExec,
): Promise<{ branch: string; conflicts: string[] }> {
  const mergeResult = await runGit(["merge", "--no-commit", "--no-ff", branch], mergeWorktree, exec, true);

  let conflicts = await getUnmergedFiles(mergeWorktree, exec);
  const hadConflicts = conflicts.length > 0 || mergeResult.code !== 0;
  if (mergeResult.code !== 0 && conflicts.length === 0) {
    throw new Error(
      `git merge of branch "${branch}" failed without detectable conflicts:\n${mergeResult.stderr || mergeResult.stdout}`,
    );
  }

  if (conflicts.length > 0) {
    await resolveConflictsWithCodex({ branch, conflictFiles: conflicts, cwd: mergeWorktree, exec });
    const remaining = await getUnmergedFiles(mergeWorktree, exec);
    if (remaining.length > 0) {
      throw new Error(
        `Unmerged files remain after Codex conflict resolution for branch "${branch}": ${remaining.join(", ")}`,
      );
    }
    conflicts = remaining;
  }

  await runGit(["add", "-A"], mergeWorktree, exec);
  const message =
    !hadConflicts
      ? `Merge branch ${branch} into ${resultBranch}`
      : `Merge branch ${branch} (conflicts resolved via Codex)`;
  await runGit(["commit", "-m", message], mergeWorktree, exec);

  return { branch, conflicts: hadConflicts ? conflicts : [] };
}

export async function codexMergeResults(
  params: CodexMergeResultsInput,
  runContext?: RunContext<OrchestratorContext>,
): Promise<CodexMergeResultsResult> {
  const repoRoot = resolveProjectRoot(params.project_root, runContext);
  await ensureProjectRoot(repoRoot);

  const contextJobId = runContext?.context?.jobId;
  const contextBaseBranch = runContext?.context?.baseBranch;
  const contextResultBranch = runContext?.context?.resultBranch;

  const resolvedJobId = resolveJobId(contextJobId ?? params.job_id ?? undefined);
  const baseBranch = contextBaseBranch ?? params.base_branch ?? DEFAULT_BASE_BRANCH;
  const context = buildOrchestratorContext({
    repoRoot,
    jobId: resolvedJobId,
    baseBranch,
  });

  const resultBranch = sanitizeBranchName(
    contextResultBranch ?? params.result_branch ?? context.resultBranch,
    context.resultBranch,
  );
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
    summary: r.summary ?? "",
    worktree_path: resolveWorktreePath(r.worktree_path, repoRoot),
  }));

  const mergeSummaries: Array<{ branch: string; conflicts: string[] }> = [];
  for (const result of resolvedResults) {
    const summary = await mergeBranchIntoResult(result.branch, mergeWorktree, resultBranch, execImplementation);
    mergeSummaries.push(summary);
  }

  const touchedFiles = await collectTouchedFiles(context.baseBranch, mergeWorktree, execImplementation);
  const hadConflicts = mergeSummaries.some((s) => s.conflicts.length > 0);
  const notes = hadConflicts
    ? `Merged ${mergeSummaries.length} branches; conflicts were resolved via Codex where needed.`
    : `Merged ${mergeSummaries.length} branches without conflicts.`;

  return {
    status: "ok",
    notes,
    touched_files: touchedFiles,
  };
}

export const codexMergeResultsTool = tool({
  name: "codex_merge_results",
  description: "Create a merge worktree and call Codex CLI to merge subtask results into one branch.",
  parameters: MergeInputSchema,
  async execute(params, runContext?: RunContext<OrchestratorContext>) {
    return codexMergeResults(params, runContext);
  },
});
