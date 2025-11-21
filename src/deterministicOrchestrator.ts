import path from "node:path";
import { access } from "node:fs/promises";
import {
  codexPlanTask,
  type CodexPlanTaskResult,
} from "./tools/codexPlanTaskTool.js";
import {
  codexRunSubtask,
  type CodexRunSubtaskResult,
} from "./tools/codexRunSubtaskTool.js";
import {
  codexMergeResults,
  type CodexMergeResultsResult,
} from "./tools/codexMergeResultsTool.js";
import type { OrchestratorContext } from "./orchestratorTypes.js";

type SubtaskPlan = CodexPlanTaskResult["subtasks"][number];

export interface DeterministicOrchestratorOptions {
  userTask: string;
  baseDir?: string;
  projectRoot?: string;
  baseBranch?: string;
}

export interface SubtaskRunOutput {
  subtask: SubtaskPlan;
  worktreePath: string;
  result: CodexRunSubtaskResult;
}

export interface DeterministicOrchestratorResult {
  plan: CodexPlanTaskResult;
  subtaskResults: SubtaskRunOutput[];
  mergeResult: CodexMergeResultsResult;
}

function resolveBaseDir(baseDir?: string): string {
  return baseDir ?? process.env.ORCHESTRATOR_BASE_DIR ?? path.resolve(process.cwd(), "..");
}

function resolveProjectRoot(baseDir: string, projectRoot?: string): string {
  if (!projectRoot) return path.resolve(baseDir, "main");
  if (path.isAbsolute(projectRoot)) return projectRoot;
  return path.resolve(baseDir, projectRoot);
}

async function ensureDirExists(directory: string) {
  await access(directory);
}

function sanitizeFragment(value: string, fallback: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized || fallback;
}

function makeWorktreeName(subtask: SubtaskPlan, idx: number, taken: Set<string>): string {
  const base = `task-${sanitizeFragment(subtask.id, `subtask-${idx + 1}`)}`;
  if (!taken.has(base)) {
    taken.add(base);
    return base;
  }

  let suffix = 2;
  while (taken.has(`${base}-${suffix}`)) {
    suffix += 1;
  }
  const name = `${base}-${suffix}`;
  taken.add(name);
  return name;
}

function buildBatches(plan: CodexPlanTaskResult): SubtaskPlan[][] {
  const batches: SubtaskPlan[][] = [];
  const groupIndex = new Map<string, number>();

  plan.subtasks.forEach((subtask, idx) => {
    const groupKey = plan.can_parallelize
      ? subtask.parallel_group || `solo-${idx + 1}`
      : `seq-${idx + 1}`;

    if (!groupIndex.has(groupKey)) {
      groupIndex.set(groupKey, batches.length);
      batches.push([]);
    }

    batches[groupIndex.get(groupKey)!].push(subtask);
  });

  return batches;
}

export async function runDeterministicOrchestrator(
  options: DeterministicOrchestratorOptions,
): Promise<DeterministicOrchestratorResult> {
  const baseDir = resolveBaseDir(options.baseDir);
  const projectRoot = resolveProjectRoot(baseDir, options.projectRoot);
  const baseBranch = options.baseBranch ?? "main";

  await ensureDirExists(projectRoot);

  const runContext: OrchestratorContext = { baseDir };

  const plan = await codexPlanTask(
    { project_root: projectRoot, user_task: options.userTask },
    { context: runContext } as any,
  );

  const batches = buildBatches(plan);
  const takenNames = new Set<string>();
  const subtaskResults: SubtaskRunOutput[] = [];
  let subtaskSeq = 0;

  for (const batch of batches) {
    const batchPromises = batch.map(async (subtask, idxInBatch) => {
      const seq = subtaskSeq++;
      const worktreeName = makeWorktreeName(subtask, seq, takenNames);
      const worktreePath = path.resolve(projectRoot, "work3", worktreeName);

      const result = await codexRunSubtask(
        {
          project_root: projectRoot,
          worktree_name: worktreeName,
          base_branch: baseBranch,
          subtask,
        },
        { context: runContext } as any,
      );

      subtaskResults.push({ subtask, worktreePath, result });
    });

    await Promise.all(batchPromises);
  }

  const mergeResult = await codexMergeResults(
    {
      project_root: projectRoot,
      base_branch: baseBranch,
      subtasks_results: subtaskResults.map((r) => ({
        subtask_id: r.subtask.id,
        worktree_path: r.worktreePath,
        summary: r.result.summary,
      })),
    },
    { context: runContext } as any,
  );

  return { plan, subtaskResults, mergeResult };
}
