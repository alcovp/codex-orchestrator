import path from "node:path";

export interface OrchestratorContext {
  /**
   * Absolute path to the primary repository (base worktree).
   */
  repoRoot: string;
  /**
   * For backward compatibility with earlier references; always equal to repoRoot.
   */
  baseDir: string;
  /**
   * Identifier for the current orchestrator job (used under .codex/jobs/<jobId>).
   */
  jobId: string;
  /**
   * Base branch for new worktrees (e.g., main).
   */
  baseBranch: string;
  /**
   * Path to .codex/jobs/<jobId>.
   */
  jobsRoot: string;
  /**
   * Path to .codex/jobs/<jobId>/worktrees.
   */
  worktreesRoot: string;
  /**
   * Name of the shared result branch (e.g., result/<jobId>).
   */
  resultBranch: string;
  /**
   * Worktree path for the merge/result stage.
   */
  resultWorktree: string;
  /**
   * Original user task/description for the current run.
   */
  taskDescription: string;
  /**
   * Raw user task text for this run (same as taskDescription, kept for clarity).
   */
  userTask: string;
}

export const DEFAULT_BASE_BRANCH = "main";
const JOBS_ROOT = ".codex/jobs";

function sanitizeSegment(value: string, fallback: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/-+/g, "-").replace(/^[-.]+|[-.]+$/g, "");
  return cleaned || fallback;
}

function defaultJobId(): string {
  const now = new Date();
  const date = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
  ].join("");
  const time = [
    String(now.getHours()).padStart(2, "0"),
    String(now.getMinutes()).padStart(2, "0"),
    String(now.getSeconds()).padStart(2, "0"),
  ].join("");
  return `job-${date}-${time}`;
}

export function resolveRepoRoot(baseDir?: string): string {
  const root = baseDir ?? process.env.ORCHESTRATOR_BASE_DIR ?? process.cwd();
  return path.resolve(root);
}

export function resolveJobId(jobId?: string): string {
  const fromEnv = process.env.ORCHESTRATOR_JOB_ID;
  const raw = (jobId ?? fromEnv ?? "").trim() || defaultJobId();
  return sanitizeSegment(raw, defaultJobId());
}

export function buildOrchestratorContext(options: {
  repoRoot?: string;
  baseDir?: string;
  jobId?: string;
  baseBranch?: string;
  taskDescription?: string;
  userTask?: string;
}): OrchestratorContext {
  const repoRoot = resolveRepoRoot(options.repoRoot ?? options.baseDir);
  const jobId = resolveJobId(options.jobId);
  const baseBranch = options.baseBranch ?? DEFAULT_BASE_BRANCH;
  const jobsRoot = path.resolve(repoRoot, JOBS_ROOT, jobId);
  const worktreesRoot = path.join(jobsRoot, "worktrees");
  const resultBranch = sanitizeSegment(`result-${jobId}`, `result-${jobId}`);
  const resultWorktree = path.join(worktreesRoot, "result");
  const taskDescription = options.taskDescription ?? options.userTask ?? "";
  const userTask = options.userTask ?? options.taskDescription ?? "";

  return {
    repoRoot,
    baseDir: repoRoot,
    jobId,
    baseBranch,
    jobsRoot,
    worktreesRoot,
    resultBranch,
    resultWorktree,
    taskDescription,
    userTask,
  };
}
