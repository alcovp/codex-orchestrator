import path from "node:path"
import { access } from "node:fs/promises"
import { codexPlanTask, type CodexPlanTaskResult } from "./tools/codexPlanTaskTool.js"
import { codexRunSubtask, type CodexRunSubtaskResult } from "./tools/codexRunSubtaskTool.js"
import { codexMergeResults, type CodexMergeResultsResult } from "./tools/codexMergeResultsTool.js"
import {
    buildOrchestratorContext,
    resolveRepoRoot,
    type OrchestratorContext,
} from "./orchestratorTypes.js"
import { resolveBaseBranch } from "./baseBranch.js"

type SubtaskPlan = CodexPlanTaskResult["subtasks"][number]

export interface DeterministicOrchestratorOptions {
    userTask: string
    baseDir?: string
    projectRoot?: string
    repoRoot?: string
    baseBranch?: string
    jobId?: string
    pushResult?: boolean
}

export interface SubtaskRunOutput {
    subtask: SubtaskPlan
    worktreePath: string
    result: CodexRunSubtaskResult
}

export interface DeterministicOrchestratorResult {
    plan: CodexPlanTaskResult
    subtaskResults: SubtaskRunOutput[]
    mergeResult: CodexMergeResultsResult
}

export function formatDeterministicReport(result: DeterministicOrchestratorResult): string {
    const lines: string[] = []

    const indentJson = (value: unknown) => JSON.stringify(value, null, 2)

    lines.push(`PLAN (${result.plan.subtasks.length} subtasks):`)
    lines.push(indentJson(result.plan))

    for (const item of result.subtaskResults) {
        lines.push(
            `SUBTASK ${item.subtask.id} @ ${item.worktreePath} -> ${item.result.status}`,
            indentJson(item.result),
        )
    }

    const mergeInput = result.subtaskResults.map((r) => ({
        subtask_id: r.subtask.id,
        worktree_path: r.worktreePath,
        branch: r.result.branch,
        summary: r.result.summary,
    }))

    lines.push("MERGE INPUT:", indentJson(mergeInput))
    lines.push("MERGE RESULT:", indentJson(result.mergeResult))

    const touched =
        result.mergeResult.touched_files && result.mergeResult.touched_files.length > 0
            ? result.mergeResult.touched_files.join(", ")
            : "(none)"
    const notes = result.mergeResult.notes?.trim() || "(none)"
    lines.push(
        "FINAL:",
        `status=${result.mergeResult.status}; subtasks=${result.subtaskResults.length}; touched_files=${touched}; notes=${notes}`,
    )

    return lines.join("\n")
}

async function ensureDirExists(directory: string) {
    await access(directory)
}

function sanitizeFragment(value: string, fallback: string): string {
    const normalized = value
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, "-")
        .replace(/^-+|-+$/g, "")
    return normalized || fallback
}

function makeWorktreeName(subtask: SubtaskPlan, idx: number, taken: Set<string>): string {
    const base = `task-${sanitizeFragment(subtask.id, `subtask-${idx + 1}`)}`
    if (!taken.has(base)) {
        taken.add(base)
        return base
    }

    let suffix = 2
    while (taken.has(`${base}-${suffix}`)) {
        suffix += 1
    }
    const name = `${base}-${suffix}`
    taken.add(name)
    return name
}

function buildBatches(plan: CodexPlanTaskResult): SubtaskPlan[][] {
    const batches: SubtaskPlan[][] = []
    const groupIndex = new Map<string, number>()

    plan.subtasks.forEach((subtask, idx) => {
        const groupKey = plan.can_parallelize
            ? subtask.parallel_group || `solo-${idx + 1}`
            : `seq-${idx + 1}`

        if (!groupIndex.has(groupKey)) {
            groupIndex.set(groupKey, batches.length)
            batches.push([])
        }

        batches[groupIndex.get(groupKey)!].push(subtask)
    })

    return batches
}

export async function runDeterministicOrchestrator(
    options: DeterministicOrchestratorOptions,
): Promise<DeterministicOrchestratorResult> {
    const repoRoot = resolveRepoRoot(options.repoRoot ?? options.projectRoot ?? options.baseDir)
    const baseBranch = await resolveBaseBranch({ repoRoot, explicitBranch: options.baseBranch })
    const context = buildOrchestratorContext({
        repoRoot,
        baseBranch,
        jobId: options.jobId,
        taskDescription: options.userTask,
        userTask: options.userTask,
        pushResult: options.pushResult,
    })
    const projectRoot = context.repoRoot

    await ensureDirExists(projectRoot)

    const plan = await codexPlanTask({ project_root: projectRoot, user_task: options.userTask }, {
        context,
    } as any)

    const batches = buildBatches(plan)
    const takenNames = new Set<string>()
    const subtaskResults: SubtaskRunOutput[] = []
    let subtaskSeq = 0

    for (const batch of batches) {
        const batchPromises = batch.map(async (subtask, idxInBatch) => {
            const seq = subtaskSeq++
            const worktreeName = makeWorktreeName(subtask, seq, takenNames)
            const worktreePath = path.resolve(context.worktreesRoot, worktreeName)

            const result = await codexRunSubtask(
                {
                    project_root: projectRoot,
                    worktree_name: worktreeName,
                    job_id: context.jobId,
                    base_branch: context.baseBranch,
                    user_task: options.userTask,
                    subtask,
                },
                { context } as any,
            )

            subtaskResults.push({ subtask, worktreePath, result })
        })

        await Promise.all(batchPromises)
    }

    const mergeResult = await codexMergeResults(
        {
            project_root: projectRoot,
            job_id: context.jobId,
            base_branch: context.baseBranch,
            result_branch: context.resultBranch,
            push_result: context.pushResult,
            subtasks_results: subtaskResults.map((r) => {
                if (!r.result.branch) {
                    throw new Error(`Missing branch for subtask ${r.subtask.id}`)
                }
                return {
                    subtask_id: r.subtask.id,
                    worktree_path: r.worktreePath,
                    branch: r.result.branch,
                    summary: r.result.summary,
                }
            }),
        },
        { context } as any,
    )

    return { plan, subtaskResults, mergeResult }
}

export async function runDeterministicWithLogging(
    options: DeterministicOrchestratorOptions,
): Promise<string> {
    const result = await runDeterministicOrchestrator(options)
    return formatDeterministicReport(result)
}
