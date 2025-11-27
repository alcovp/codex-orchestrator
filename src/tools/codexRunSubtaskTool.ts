import { tool, RunContext } from "@openai/agents"
import { z } from "zod"
import { access, mkdir } from "node:fs/promises"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import path from "node:path"
import {
    buildOrchestratorContext,
    DEFAULT_BASE_BRANCH,
    resolveJobId,
    type OrchestratorContext,
} from "../orchestratorTypes.js"
import { DEFAULT_CODEX_CAPTURE_LIMIT, runWithCodexTee } from "./codexExecLogger.js"
import { appendJobLog } from "../jobLogger.js"
import { recordSubtaskResult, recordSubtaskStart } from "../db/sqliteDb.js"

const execFileAsync = promisify(execFile)
const DEFAULT_MAX_BUFFER = 2 * 1024 * 1024
const OUTPUT_TRUNCATE = 2000

const SubtaskInputSchema = z.object({
    project_root: z.string().describe("Absolute or baseDir-relative path to the repository root."),
    worktree_name: z
        .string()
        .describe("Name for the worktree under .codex/jobs/<jobId>/worktrees/."),
    job_id: z
        .string()
        .describe("Job id to place worktrees under .codex/jobs/<jobId>.")
        .optional()
        .nullable(),
    user_task: z
        .string()
        .describe("Full original user task for context (helps keep subtasks aligned).")
        .optional()
        .nullable(),
    base_branch: z
        .string()
        .describe("Base branch/ref for git worktree add (e.g., main, HEAD, origin/main).")
        .optional()
        .nullable(),
    subtask: z.object({
        id: z.string(),
        title: z.string(),
        description: z.string(),
        parallel_group: z
            .string()
            .describe("Parallel group id (string, can be empty).")
            .optional()
            .nullable(),
        context: z.string().optional().nullable(),
        notes: z.string().optional().nullable(),
    }),
})

const SubtaskOutputSchema = z.object({
    subtask_id: z.string(),
    status: z.enum(["ok", "failed"]),
    summary: z.string(),
    branch: z.string().optional(),
    important_files: z.array(z.string()),
})

export type CodexRunSubtaskInput = z.infer<typeof SubtaskInputSchema>
export type CodexRunSubtaskResult = z.infer<typeof SubtaskOutputSchema>

type SubtaskExec = (args: {
    program: "git" | "codex"
    args: string[]
    cwd: string
    label?: string
}) => Promise<{ stdout: string; stderr: string }>

const defaultExec: SubtaskExec = async ({ program, args, cwd, label }) => {
    if (program === "codex") {
        return runWithCodexTee({
            command: program,
            args,
            cwd,
            label: label ?? "codex-subtask",
            captureLimit: DEFAULT_CODEX_CAPTURE_LIMIT,
        })
    }

    return execFileAsync(program, args, { cwd, maxBuffer: DEFAULT_MAX_BUFFER })
}

let execImplementation: SubtaskExec = defaultExec

export function setSubtaskExecImplementation(fn: SubtaskExec | null) {
    execImplementation = fn ?? defaultExec
}

function resolveProjectRoot(
    projectRoot: string,
    runContext?: RunContext<OrchestratorContext>,
): string {
    if (runContext?.context?.repoRoot) return runContext.context.repoRoot

    if (path.isAbsolute(projectRoot)) return projectRoot

    const baseDir =
        runContext?.context?.repoRoot ??
        runContext?.context?.baseDir ??
        process.env.ORCHESTRATOR_BASE_DIR ??
        // fallback: current working directory if nothing else is set
        process.cwd()

    return path.resolve(baseDir, projectRoot)
}

async function pathExists(p: string): Promise<boolean> {
    try {
        await access(p)
        return true
    } catch {
        return false
    }
}

async function ensureProjectRoot(p: string) {
    if (!(await pathExists(p))) {
        throw new Error(`project_root does not exist or is not accessible: ${p}`)
    }
}

async function ensureParentDir(p: string) {
    const parent = path.dirname(p)
    await mkdir(parent, { recursive: true })
}

function sanitizeBranchName(name: string, fallback: string): string {
    const cleaned = name.replace(/[^A-Za-z0-9._/-]+/g, "-").replace(/^-+|-+$/g, "")
    return cleaned || fallback
}

function buildSubtaskPrompt(
    subtask: CodexRunSubtaskInput["subtask"],
    fullUserTask: string,
    plannerContext?: string | null,
): string {
    const userTaskSection = fullUserTask
        ? [
              "Исходная задача пользователя (полный текст, не сокращай и не перепоручай заново):",
              fullUserTask,
              "",
          ]
        : []

    const plannerContextSection =
        plannerContext && plannerContext !== fullUserTask
            ? ["Контекст от планера (как есть, только для справки):", plannerContext, ""]
            : []

    return [
        ...userTaskSection,
        ...plannerContextSection,
        `Твоя подзадача: ${subtask.title}`,
        "",
        "Описание подзадачи:",
        subtask.description,
        "",
        "Держи в фокусе именно эту подзадачу и проверяй, что решение вписывается в исходный запрос.",
        "",
        "Требования:",
        "- Работай строго в контексте текущего репозитория.",
        "- НЕ выполняй git-команды (commit/merge/rebase/init/push/status и т.п.) и не трогай .git/.git-local.",
        "- Внеси нужные правки в код/конфиги/тесты. Коммиты выполняет оркестратор.",
        "- В конце сделай краткий summary изменений в виде JSON:",
        "",
        "{",
        `  "subtask_id": "${subtask.id}",`,
        '  "status": "ok" | "failed",',
        '  "summary": "string",',
        '  "important_files": ["path/file1.tsx", "..."]',
        "}",
        "",
        "Верни этот JSON в конце ответа.",
        "Если нужно комментировать код — комментируй, но JSON должен быть последним и валидным.",
    ].join("\n")
}

async function ensureResultBranch(
    repoRoot: string,
    branch: string,
    baseBranch: string,
    exec: SubtaskExec,
) {
    try {
        await exec({ program: "git", args: ["rev-parse", "--verify", branch], cwd: repoRoot })
        return
    } catch {
        // branch is missing, fall through to create it
    }

    await exec({ program: "git", args: ["branch", branch, baseBranch], cwd: repoRoot })
}

async function detectCurrentBranch(worktreeDir: string, exec: SubtaskExec): Promise<string | null> {
    try {
        const { stdout } = await exec({
            program: "git",
            args: ["rev-parse", "--abbrev-ref", "HEAD"],
            cwd: worktreeDir,
        })
        const branch = stdout?.trim()
        return branch ? branch.split("\n")[0]?.trim() || null : null
    } catch {
        return null
    }
}

function tryParseJson(text: string): unknown | null {
    try {
        return JSON.parse(text)
    } catch {
        return null
    }
}

function extractLastJsonObject(text: string): unknown {
    const trimmed = text.trim()
    if (!trimmed) {
        throw new Error("Subtask output is empty")
    }

    const direct = tryParseJson(trimmed)
    if (direct !== null) return direct

    const lastClosing = trimmed.lastIndexOf("}")
    if (lastClosing === -1) {
        throw new Error("No JSON object boundaries found in subtask output")
    }

    for (
        let start = trimmed.lastIndexOf("{", lastClosing);
        start !== -1;
        start = trimmed.lastIndexOf("{", start - 1)
    ) {
        const candidate = trimmed.slice(start, lastClosing + 1)
        const parsed = tryParseJson(candidate)
        if (parsed !== null) return parsed
    }

    throw new Error("Unable to parse JSON object from subtask output")
}

function normalizeOutput(raw: unknown): CodexRunSubtaskResult {
    const parsed = SubtaskOutputSchema.parse(raw)
    return {
        ...parsed,
        important_files: parsed.important_files ?? [],
    }
}

function truncate(text: string, limit: number): string {
    if (text.length <= limit) return text
    return `${text.slice(0, limit)} ... [truncated ${text.length - limit} chars]`
}

async function runGit(
    args: string[],
    cwd: string,
    exec: SubtaskExec,
    allowNonZero = false,
): Promise<{ stdout: string; stderr: string; code: number }> {
    try {
        const { stdout, stderr } = await exec({ program: "git", args, cwd })
        return { stdout: stdout ?? "", stderr: stderr ?? "", code: 0 }
    } catch (error: any) {
        const code = typeof error?.code === "number" ? error.code : 1
        if (allowNonZero) {
            return {
                stdout: error?.stdout ?? "",
                stderr: error?.stderr ?? error?.message ?? "",
                code,
            }
        }
        throw error
    }
}

async function commitIfNeeded({
    cwd,
    exec,
    subtaskId,
    jobId,
    summary,
}: {
    cwd: string
    exec: SubtaskExec
    subtaskId: string
    jobId: string
    summary: string
}) {
    const status = await runGit(["status", "--porcelain"], cwd, exec, true)
    if (!status.stdout.trim()) {
        return false
    }

    await runGit(["add", "-A"], cwd, exec)
    const message = `job ${jobId}: subtask ${subtaskId} – ${summary.slice(0, 120)}`
    const commitResult = await runGit(
        [
            "-c",
            "user.name=Codex Orchestrator",
            "-c",
            "user.email=codex@example.invalid",
            "commit",
            "-m",
            message,
        ],
        cwd,
        exec,
        true,
    )

    if (commitResult.code !== 0 && !commitResult.stderr.includes("nothing to commit")) {
        throw new Error(
            `git commit failed for subtask ${subtaskId}: ${commitResult.stderr || commitResult.stdout}`,
        )
    }

    return commitResult.code === 0
}

export async function codexRunSubtask(
    params: CodexRunSubtaskInput,
    runContext?: RunContext<OrchestratorContext>,
): Promise<CodexRunSubtaskResult> {
    const repoRoot = resolveProjectRoot(params.project_root, runContext)
    await ensureProjectRoot(repoRoot)

    const contextJobId = runContext?.context?.jobId
    const contextBaseBranch = runContext?.context?.baseBranch

    const resolvedJobId = resolveJobId(contextJobId ?? params.job_id ?? undefined)
    const baseBranch = contextBaseBranch ?? params.base_branch ?? DEFAULT_BASE_BRANCH
    const context = buildOrchestratorContext({
        repoRoot,
        jobId: resolvedJobId,
        baseBranch,
    })

    await ensureParentDir(context.worktreesRoot)
    await ensureResultBranch(
        context.repoRoot,
        context.resultBranch,
        context.baseBranch,
        execImplementation,
    )

    const worktreeDir = path.resolve(context.worktreesRoot, params.worktree_name)
    await ensureParentDir(worktreeDir)

    let branchName = sanitizeBranchName(
        `task-${params.worktree_name}-${context.jobId}`,
        `task-${Date.now()}`,
    )

    const exists = await pathExists(worktreeDir)
    if (!exists) {
        await execImplementation({
            program: "git",
            args: ["worktree", "add", "-b", branchName, worktreeDir, context.baseBranch],
            cwd: repoRoot,
        })
    } else {
        const current = await detectCurrentBranch(worktreeDir, execImplementation)
        branchName = current || branchName
    }

    await recordSubtaskStart({
        context,
        subtask: params.subtask,
        worktreePath: worktreeDir,
        branchName,
    })

    const userTaskContextRaw =
        params.user_task ??
        runContext?.context?.userTask ??
        runContext?.context?.taskDescription ??
        params.subtask.context ??
        ""
    const plannerContext =
        typeof params.subtask.context === "string" ? params.subtask.context.trim() : null
    const userTaskContext = typeof userTaskContextRaw === "string" ? userTaskContextRaw.trim() : ""
    const prompt = buildSubtaskPrompt(
        params.subtask,
        userTaskContext || plannerContext || "",
        plannerContext,
    )
    let stdout = ""
    let stderr = ""

    const jobLabel = context.jobId ? `[job ${context.jobId}]` : "[job]"
    const subtaskLabel = `${jobLabel} subtask ${params.subtask.id}`
    const startMessage = `${subtaskLabel} started @ ${worktreeDir}`
    console.log(startMessage)
    appendJobLog(startMessage).catch(() => {})

    try {
        const result = await execImplementation({
            program: "codex",
            args: ["exec", "--full-auto", prompt],
            cwd: worktreeDir,
            label: `codex-subtask:${params.subtask.id}`,
        })
        stdout = result.stdout ?? ""
        stderr = result.stderr ?? ""
        const parsed = normalizeOutput(extractLastJsonObject(stdout || stderr))
        await commitIfNeeded({
            cwd: worktreeDir,
            exec: execImplementation,
            subtaskId: params.subtask.id,
            jobId: context.jobId,
            summary: parsed.summary,
        })
        await recordSubtaskResult({
            context,
            subtask: params.subtask,
            worktreePath: worktreeDir,
            branchName,
            result: parsed,
        })
        const finishMessage = `${subtaskLabel} finished (${parsed.status})`
        console.log(finishMessage)
        appendJobLog(finishMessage).catch(() => {})
        return {
            ...parsed,
            branch: parsed.branch || branchName || undefined,
        }
    } catch (error: any) {
        stdout = (error?.stdout ?? stdout ?? "") as string
        stderr = (error?.stderr ?? stderr ?? error?.message ?? "") as string
        try {
            const parsed = normalizeOutput(extractLastJsonObject(`${stdout}\n${stderr}`))
            await commitIfNeeded({
                cwd: worktreeDir,
                exec: execImplementation,
                subtaskId: params.subtask.id,
                jobId: context.jobId,
                summary: parsed.summary,
            })
            await recordSubtaskResult({
                context,
                subtask: params.subtask,
                worktreePath: worktreeDir,
                branchName,
                result: parsed,
            })
            const finishMessage = `${subtaskLabel} finished (${parsed.status})`
            console.log(finishMessage)
            appendJobLog(finishMessage).catch(() => {})
            return {
                ...parsed,
                branch: parsed.branch || branchName || undefined,
            }
        } catch (error: any) {
            const failMessage = `${subtaskLabel} failed`
            console.log(failMessage)
            appendJobLog(failMessage).catch(() => {})
            await recordSubtaskResult({
                context,
                subtask: params.subtask,
                worktreePath: worktreeDir,
                branchName,
                result: {
                    subtask_id: params.subtask.id,
                    status: "failed",
                    summary: "Failed to parse subtask JSON result",
                    important_files: [],
                },
                errorMessage: error?.message ?? "Failed to parse subtask JSON result",
            })
            const parts = [
                "codex_run_subtask failed: could not parse final JSON.",
                stdout ? `stdout (truncated):\n${truncate(stdout, OUTPUT_TRUNCATE)}` : null,
                stderr ? `stderr (truncated):\n${truncate(stderr, OUTPUT_TRUNCATE)}` : null,
                error?.message ? `error: ${error.message}` : null,
            ].filter(Boolean)
            throw new Error(parts.join("\n\n"))
        }
    }
}

export const codexRunSubtaskTool = tool({
    name: "codex_run_subtask",
    description:
        "Create a worktree for a subtask and call Codex CLI to execute it. Returns the subtask JSON summary.",
    parameters: SubtaskInputSchema,
    async execute(params, runContext?: RunContext<OrchestratorContext>) {
        return codexRunSubtask(params, runContext)
    },
})
