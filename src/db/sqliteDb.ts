import path from "node:path"
import { mkdirSync } from "node:fs"
import Database from "better-sqlite3"
import type { OrchestratorContext } from "../orchestratorTypes.js"
import type { CodexPlanTaskResult } from "../tools/codexPlanTaskTool.js"
import type { CodexRunSubtaskInput, CodexRunSubtaskResult } from "../tools/codexRunSubtaskTool.js"
import type {
    CodexMergeResultsInput,
    CodexMergeResultsResult,
} from "../tools/codexMergeResultsTool.js"
import type { CodexAnalyzeProjectResult } from "../tools/codexAnalyzeProjectTool.js"
import type { CodexRefactorProjectResult } from "../tools/codexRefactorProjectTool.js"
import { appendJobLog } from "../jobLogger.js"

type JobStatus =
    | "analyzing"
    | "refactoring"
    | "planning"
    | "running"
    | "merging"
    | "done"
    | "failed"
    | "needs_manual_review"
type SubtaskStatus = "pending" | "running" | "completed" | "failed"

export function resolveDbPath(): string {
    const fromEnv = process.env.ORCHESTRATOR_DB_PATH
    if (fromEnv?.trim()) return path.resolve(fromEnv.trim())
    return path.resolve(process.cwd(), "orchestrator.db")
}

function ensureDb(): Database.Database {
    const dbPath = resolveDbPath()
    mkdirSync(path.dirname(dbPath), { recursive: true })
    const db = new Database(dbPath)
    db.pragma("journal_mode = WAL")
    db.pragma("foreign_keys = ON")
    return db
}

let dbSingleton: Database.Database | null = null
function db(): Database.Database {
    if (!dbSingleton) {
        dbSingleton = ensureDb()
        migrate(dbSingleton)
    }
    return dbSingleton
}

function migrate(database: Database.Database) {
    database.exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      job_id TEXT PRIMARY KEY,
      repo_root TEXT NOT NULL,
      base_branch TEXT NOT NULL,
      task_description TEXT NOT NULL,
      user_task TEXT NOT NULL,
      push_result INTEGER NOT NULL,
      status TEXT NOT NULL,
      started_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS subtasks (
      job_id TEXT NOT NULL,
      subtask_id TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      parallel_group TEXT,
      status TEXT NOT NULL,
      worktree TEXT,
      branch TEXT,
      summary TEXT,
      important_files TEXT,
      error TEXT,
      last_reasoning TEXT,
      started_at TEXT,
      finished_at TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (job_id, subtask_id),
      FOREIGN KEY (job_id) REFERENCES jobs(job_id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS artifacts (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      type TEXT NOT NULL,
      label TEXT,
      subtask_id TEXT,
      created_at TEXT NOT NULL,
      data TEXT NOT NULL,
      FOREIGN KEY (job_id) REFERENCES jobs(job_id) ON DELETE CASCADE
    );
  `)
    try {
        database.exec(`ALTER TABLE subtasks ADD COLUMN last_reasoning TEXT`)
    } catch {
        // column may already exist
    }
}

const isoNow = () => new Date().toISOString()
const makeId = () => `${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`

function logDbError(message: string, error: unknown) {
    appendJobLog(
        `[db] ${message}: ${error instanceof Error ? error.message : String(error)}`,
    ).catch(() => {})
}

export function markJobStatus(context: OrchestratorContext, status: JobStatus) {
    try {
        const row = db()
            .prepare("SELECT status FROM jobs WHERE job_id = ?")
            .get(context.jobId) as { status?: string } | undefined

        const current = row?.status as JobStatus | undefined
        if (!current) {
            upsertJob(context, status)
            return
        }

        const priority: Record<JobStatus, number> = {
            failed: 7,
            needs_manual_review: 6,
            done: 5,
            merging: 4,
            running: 3,
            planning: 2,
            refactoring: 1,
            analyzing: 0,
        }

        if (priority[status] < priority[current]) return

        const now = isoNow()
        db()
            .prepare(
                `UPDATE jobs SET status = @status, updated_at = @updated_at WHERE job_id = @job_id`,
            )
            .run({ job_id: context.jobId, status, updated_at: now })
    } catch (error) {
        logDbError("markJobStatus failed", error)
    }
}

export function readJobStatus(context: OrchestratorContext): JobStatus | null {
    try {
        const row = db()
            .prepare("SELECT status FROM jobs WHERE job_id = ?")
            .get(context.jobId) as { status?: JobStatus } | undefined
        return row?.status ?? null
    } catch (error) {
        logDbError("readJobStatus failed", error)
        return null
    }
}

export function ensureTerminalJobStatus(
    context: OrchestratorContext,
    fallback: JobStatus = "done",
) {
    try {
        const row = db()
            .prepare("SELECT status FROM jobs WHERE job_id = ?")
            .get(context.jobId) as { status?: JobStatus } | undefined
        const current = row?.status
        if (!current) return

        const isTerminal =
            current === "done" || current === "failed" || current === "needs_manual_review"
        if (isTerminal) return

        markJobStatus(context, fallback)
    } catch (error) {
        logDbError("ensureTerminalJobStatus failed", error)
    }
}

export function recordSubtaskReasoning(params: {
    context: OrchestratorContext
    subtaskId: string
    reasoning: string
}) {
    try {
        const now = isoNow()
        db()
            .prepare(
                `UPDATE subtasks SET last_reasoning=@reasoning, updated_at=@updated_at WHERE job_id=@job_id AND subtask_id=@subtask_id`,
            )
            .run({
                job_id: params.context.jobId,
                subtask_id: params.subtaskId,
                reasoning: params.reasoning,
                updated_at: now,
            })
    } catch (error) {
        logDbError("recordSubtaskReasoning failed", error)
    }
}

function upsertJob(context: OrchestratorContext, status: JobStatus) {
    const now = isoNow()
    const taskDescription = context.taskDescription || context.userTask || ""
    const userTask = context.userTask || context.taskDescription || ""
    const stmt = db().prepare(
        `
    INSERT INTO jobs (job_id, repo_root, base_branch, task_description, user_task, push_result, status, started_at, updated_at)
    VALUES (@job_id, @repo_root, @base_branch, @task_description, @user_task, @push_result, @status, @started_at, @updated_at)
    ON CONFLICT(job_id) DO UPDATE SET
      repo_root=excluded.repo_root,
      base_branch=excluded.base_branch,
      task_description=excluded.task_description,
      user_task=excluded.user_task,
      push_result=excluded.push_result,
      status=excluded.status,
      updated_at=excluded.updated_at
    `,
    )
    stmt.run({
        job_id: context.jobId,
        repo_root: context.repoRoot,
        base_branch: context.baseBranch,
        task_description: taskDescription,
        user_task: userTask,
        push_result: context.pushResult ? 1 : 0,
        status,
        started_at: now,
        updated_at: now,
    })
}

export function recordPlannerOutput(params: {
    context: OrchestratorContext
    plan: CodexPlanTaskResult
    userTask: string
}) {
    try {
        const now = isoNow()
        const contextWithTask = {
            ...params.context,
            taskDescription:
                params.context.taskDescription || params.userTask || params.context.userTask || "",
            userTask: params.context.userTask || params.userTask || params.context.taskDescription || "",
        }
        const tx = db().transaction(() => {
            upsertJob(contextWithTask, "planning")
            const subtaskStmt = db().prepare(
                `
        INSERT INTO subtasks (job_id, subtask_id, title, description, parallel_group, status, updated_at)
        VALUES (@job_id, @subtask_id, @title, @description, @parallel_group, @status, @updated_at)
        ON CONFLICT(job_id, subtask_id) DO UPDATE SET
          title=excluded.title,
          description=excluded.description,
          parallel_group=excluded.parallel_group,
          status=excluded.status,
          updated_at=excluded.updated_at
        `,
            )
            params.plan.subtasks.forEach((s) =>
                subtaskStmt.run({
                    job_id: params.context.jobId,
                    subtask_id: s.id,
                    title: s.title,
                    description: s.description,
                    parallel_group: s.parallel_group ?? null,
                    status: "pending",
                    updated_at: now,
                }),
            )
            db()
                .prepare(
                    `INSERT INTO artifacts (id, job_id, type, label, created_at, data)
           VALUES (@id, @job_id, 'plan', 'planner-output', @created_at, @data)`,
                )
                .run({
                    id: makeId(),
                    job_id: params.context.jobId,
                    created_at: now,
                    data: JSON.stringify(params.plan),
                })
        })
        tx()
    } catch (error) {
        logDbError("recordPlannerOutput failed", error)
    }
}

export function recordAnalysisOutput(params: {
    context: OrchestratorContext
    analysis: CodexAnalyzeProjectResult
    userTask?: string
}) {
    try {
        const now = isoNow()
        const contextWithTask = {
            ...params.context,
            taskDescription:
                params.context.taskDescription ||
                params.userTask ||
                params.context.userTask ||
                "",
            userTask:
                params.context.userTask ||
                params.userTask ||
                params.context.taskDescription ||
                "",
        }
        const tx = db().transaction(() => {
            upsertJob(contextWithTask, "analyzing")
            db()
                .prepare(
                    `INSERT INTO artifacts (id, job_id, type, label, created_at, data)
           VALUES (@id, @job_id, 'analysis', 'analysis-output', @created_at, @data)`,
                )
                .run({
                    id: makeId(),
                    job_id: params.context.jobId,
                    created_at: now,
                    data: JSON.stringify(params.analysis),
                })
        })
        tx()
    } catch (error) {
        logDbError("recordAnalysisOutput failed", error)
    }
}

export function recordRefactorOutput(params: {
    context: OrchestratorContext
    result: CodexRefactorProjectResult
    userTask?: string
}) {
    try {
        const now = isoNow()
        const contextWithTask = {
            ...params.context,
            taskDescription:
                params.context.taskDescription ||
                params.userTask ||
                params.context.userTask ||
                "",
            userTask:
                params.context.userTask ||
                params.userTask ||
                params.context.taskDescription ||
                "",
        }
        const tx = db().transaction(() => {
            upsertJob(contextWithTask, "refactoring")
            db()
                .prepare(
                    `INSERT INTO artifacts (id, job_id, type, label, created_at, data)
           VALUES (@id, @job_id, 'refactor', 'prefactor-output', @created_at, @data)`,
                )
                .run({
                    id: makeId(),
                    job_id: params.context.jobId,
                    created_at: now,
                    data: JSON.stringify(params.result),
                })
        })
        tx()
    } catch (error) {
        logDbError("recordRefactorOutput failed", error)
    }
}

export function recordSubtaskStart(params: {
    context: OrchestratorContext
    subtask: CodexRunSubtaskInput["subtask"]
    worktreePath: string
    branchName: string
}) {
    try {
        const now = isoNow()
        const tx = db().transaction(() => {
            upsertJob(params.context, "running")
            db()
                .prepare(
                    `
          INSERT INTO subtasks (job_id, subtask_id, title, description, parallel_group, status, worktree, branch, started_at, updated_at)
          VALUES (@job_id, @subtask_id, @title, @description, @parallel_group, @status, @worktree, @branch, @started_at, @updated_at)
          ON CONFLICT(job_id, subtask_id) DO UPDATE SET
            title=excluded.title,
            description=excluded.description,
            parallel_group=excluded.parallel_group,
            status=excluded.status,
            worktree=excluded.worktree,
            branch=excluded.branch,
            started_at=COALESCE(subtasks.started_at, excluded.started_at),
            updated_at=excluded.updated_at
        `,
                )
                .run({
                    job_id: params.context.jobId,
                    subtask_id: params.subtask.id,
                    title: params.subtask.title,
                    description: params.subtask.description,
                    parallel_group: params.subtask.parallel_group ?? null,
                    status: "running",
                    worktree: params.worktreePath,
                    branch: params.branchName,
                    started_at: now,
                    updated_at: now,
                })
        })
        tx()
    } catch (error) {
        logDbError("recordSubtaskStart failed", error)
    }
}

export function recordSubtaskResult(params: {
    context: OrchestratorContext
    subtask: CodexRunSubtaskInput["subtask"]
    worktreePath: string
    branchName: string
    result: CodexRunSubtaskResult
    errorMessage?: string
}) {
    try {
        const now = isoNow()
        const isOk = params.result.status === "ok"
        const tx = db().transaction(() => {
            upsertJob(params.context, isOk ? "running" : "failed")
            db()
                .prepare(
                    `
          INSERT INTO subtasks (job_id, subtask_id, title, description, parallel_group, status, worktree, branch, summary, important_files, error, last_reasoning, started_at, finished_at, updated_at)
          VALUES (@job_id, @subtask_id, @title, @description, @parallel_group, @status, @worktree, @branch, @summary, @important_files, @error, @last_reasoning, @started_at, @finished_at, @updated_at)
          ON CONFLICT(job_id, subtask_id) DO UPDATE SET
            title=excluded.title,
            description=excluded.description,
            parallel_group=excluded.parallel_group,
            status=excluded.status,
            worktree=excluded.worktree,
            branch=excluded.branch,
            summary=excluded.summary,
            important_files=excluded.important_files,
            error=excluded.error,
            last_reasoning=excluded.last_reasoning,
            started_at=COALESCE(subtasks.started_at, excluded.started_at),
            finished_at=excluded.finished_at,
            updated_at=excluded.updated_at
        `,
                )
                .run({
                    job_id: params.context.jobId,
                    subtask_id: params.subtask.id,
                    title: params.subtask.title,
                    description: params.subtask.description,
                    parallel_group: params.subtask.parallel_group ?? null,
                    status: isOk ? "completed" : "failed",
                    worktree: params.worktreePath,
                    branch: params.result.branch ?? params.branchName,
                    summary: params.result.summary,
                    important_files: JSON.stringify(params.result.important_files ?? []),
                    error: params.errorMessage ?? null,
                    last_reasoning: null,
                    started_at: now,
                    finished_at: now,
                    updated_at: now,
                })

            db()
                .prepare(
                    `INSERT INTO artifacts (id, job_id, type, label, subtask_id, created_at, data)
           VALUES (@id, @job_id, 'subtask_result', @label, @subtask_id, @created_at, @data)`,
                )
                .run({
                    id: makeId(),
                    job_id: params.context.jobId,
                    label: `subtask-${params.subtask.id}`,
                    subtask_id: params.subtask.id,
                    created_at: now,
                    data: JSON.stringify(params.result),
                })
        })
        tx()
    } catch (error) {
        logDbError("recordSubtaskResult failed", error)
    }
}

export function recordMergeStart(params: {
    context: OrchestratorContext
    mergeInput: CodexMergeResultsInput
}) {
    try {
        const now = isoNow()
        const tx = db().transaction(() => {
            upsertJob(params.context, "merging")
            db()
                .prepare(
                    `INSERT INTO artifacts (id, job_id, type, label, created_at, data)
           VALUES (@id, @job_id, 'merge_input', 'merge-input', @created_at, @data)`,
                )
                .run({
                    id: makeId(),
                    job_id: params.context.jobId,
                    created_at: now,
                    data: JSON.stringify(params.mergeInput),
                })
        })
        tx()
    } catch (error) {
        logDbError("recordMergeStart failed", error)
    }
}

export function recordMergeResult(params: {
    context: OrchestratorContext
    mergeResult: CodexMergeResultsResult
}) {
    try {
        const now = isoNow()
        const tx = db().transaction(() => {
            upsertJob(
                params.context,
                params.mergeResult.status === "needs_manual_review"
                    ? "needs_manual_review"
                    : "done",
            )
            db()
                .prepare(
                    `INSERT INTO artifacts (id, job_id, type, label, created_at, data)
           VALUES (@id, @job_id, 'merge_result', 'merge-result', @created_at, @data)`,
                )
                .run({
                    id: makeId(),
                    job_id: params.context.jobId,
                    created_at: now,
                    data: JSON.stringify(params.mergeResult),
                })
        })
        tx()
    } catch (error) {
        logDbError("recordMergeResult failed", error)
    }
}

export function recordMergeFailure(params: {
    context: OrchestratorContext
    error: { message: string; stdout?: string | null; stderr?: string | null }
}) {
    try {
        const now = isoNow()
        const tx = db().transaction(() => {
            upsertJob(params.context, "failed")
            db()
                .prepare(
                    `INSERT INTO artifacts (id, job_id, type, label, created_at, data)
           VALUES (@id, @job_id, 'merge_error', 'merge-error', @created_at, @data)`,
                )
                .run({
                    id: makeId(),
                    job_id: params.context.jobId,
                    created_at: now,
                    data: JSON.stringify(params.error),
                })
        })
        tx()
    } catch (error) {
        logDbError("recordMergeFailure failed", error)
    }
}

export function readDashboardData(): {
    jobs: Array<{
        jobId: string
        repoRoot: string
        baseBranch: string
        taskDescription: string
        userTask: string
        pushResult: boolean
        status: string
        startedAt: string
        updatedAt: string
        plan?: CodexPlanTaskResult
        mergeResult?: CodexMergeResultsResult
        subtasks: Array<{
            id: string
            title: string
            description?: string
            parallel_group?: string
            status: SubtaskStatus
            worktree?: string
            branch?: string
            summary?: string
            important_files?: string[]
            error?: string
            last_reasoning?: string
            startedAt?: string
            finishedAt?: string
            updatedAt: string
        }>
        artifacts: Array<{
            id: string
            type: string
            label?: string
            subtaskId?: string
            createdAt: string
            data: unknown
        }>
    }>
} {
    try {
        const jobs = db()
            .prepare("SELECT * FROM jobs ORDER BY started_at DESC")
            .all()
            .map((row: any) => ({
                jobId: row.job_id as string,
                repoRoot: row.repo_root as string,
                baseBranch: row.base_branch as string,
                taskDescription:
                    (row.task_description as string) || (row.user_task as string) || "",
                userTask: (row.user_task as string) || (row.task_description as string) || "",
                pushResult: Boolean(row.push_result),
                status: row.status as string,
                startedAt: row.started_at as string,
                updatedAt: row.updated_at as string,
            }))

        const subtasks = db()
            .prepare("SELECT * FROM subtasks")
            .all()
            .map((row: any) => ({
                jobId: row.job_id as string,
                id: row.subtask_id as string,
                title: row.title as string,
                description: row.description ?? undefined,
                parallel_group: row.parallel_group ?? undefined,
                status: row.status as SubtaskStatus,
                worktree: row.worktree ?? undefined,
                branch: row.branch ?? undefined,
                summary: row.summary ?? undefined,
                important_files: row.important_files
                    ? (JSON.parse(row.important_files) as string[])
                    : [],
                error: row.error ?? undefined,
                last_reasoning: row.last_reasoning ?? undefined,
                startedAt: row.started_at ?? undefined,
                finishedAt: row.finished_at ?? undefined,
                updatedAt: row.updated_at as string,
            }))

        const artifacts = db()
            .prepare("SELECT * FROM artifacts ORDER BY created_at DESC")
            .all()
            .map((row: any) => ({
                jobId: row.job_id as string,
                id: row.id as string,
                type: row.type as string,
                label: row.label ?? undefined,
                subtaskId: row.subtask_id ?? undefined,
                createdAt: row.created_at as string,
                data: JSON.parse(row.data as string),
            }))

        const jobsWithData = jobs.map((job) => ({
            ...job,
            subtasks: subtasks.filter((s) => s.jobId === job.jobId),
            artifacts: artifacts.filter((a) => a.jobId === job.jobId),
            plan: artifacts.find((a) => a.jobId === job.jobId && a.type === "plan")?.data as
                | CodexPlanTaskResult
                | undefined,
            mergeResult: artifacts.find((a) => a.jobId === job.jobId && a.type === "merge_result")
                ?.data as CodexMergeResultsResult | undefined,
        }))

        return { jobs: jobsWithData }
    } catch (error) {
        logDbError("readDashboardData failed", error)
        return { jobs: [] }
    }
}

export function readActiveJob():
    | ReturnType<typeof readDashboardData>["jobs"][number]
    | null {
    try {
        const job = db()
            .prepare(
                "SELECT * FROM jobs WHERE status NOT IN ('done','failed','needs_manual_review') ORDER BY started_at DESC LIMIT 1",
            )
            .get() as any
        if (!job) return null

        const artifacts = db()
            .prepare("SELECT * FROM artifacts WHERE job_id = ? ORDER BY created_at DESC")
            .all(job.job_id)
            .map((row: any) => ({
                jobId: row.job_id as string,
                id: row.id as string,
                type: row.type as string,
                label: row.label ?? undefined,
                subtaskId: row.subtask_id ?? undefined,
                createdAt: row.created_at as string,
                data: JSON.parse(row.data as string),
            }))

        const subtasks = db()
            .prepare("SELECT * FROM subtasks WHERE job_id = ?")
            .all(job.job_id)
            .map((row: any) => ({
                jobId: row.job_id as string,
                id: row.subtask_id as string,
                title: row.title as string,
                description: row.description ?? undefined,
                parallel_group: row.parallel_group ?? undefined,
                status: row.status as SubtaskStatus,
                worktree: row.worktree ?? undefined,
                branch: row.branch ?? undefined,
                summary: row.summary ?? undefined,
                important_files: row.important_files
                    ? (JSON.parse(row.important_files) as string[])
                    : [],
                last_reasoning: row.last_reasoning ?? undefined,
                error: row.error ?? undefined,
                startedAt: row.started_at ?? undefined,
                finishedAt: row.finished_at ?? undefined,
                updatedAt: row.updated_at as string,
            }))

        return {
            jobId: job.job_id as string,
            repoRoot: job.repo_root as string,
            baseBranch: job.base_branch as string,
            taskDescription:
                (job.task_description as string) || (job.user_task as string) || "",
            userTask: (job.user_task as string) || (job.task_description as string) || "",
            pushResult: Boolean(job.push_result),
            status: job.status as string,
            startedAt: job.started_at as string,
            updatedAt: job.updated_at as string,
            subtasks,
            artifacts,
            plan: artifacts.find((a) => a.type === "plan")?.data as
                | CodexPlanTaskResult
                | undefined,
            mergeResult: artifacts.find((a) => a.type === "merge_result")
                ?.data as CodexMergeResultsResult | undefined,
        }
    } catch (error) {
        logDbError("readActiveJob failed", error)
        return null
    }
}
