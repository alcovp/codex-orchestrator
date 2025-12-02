import { tool, type RunContext } from "@openai/agents"
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
import { recordRefactorOutput, markJobStatus, recordRefactorProgress } from "../db/sqliteDb.js"

const execFileAsync = promisify(execFile)
const OUTPUT_TRUNCATE = 2000
const DEFAULT_MAX_BUFFER = 2 * 1024 * 1024

const AnalyzeLikeSchema = z.object({
    should_refactor: z.boolean(),
    reasons: z.array(z.string()),
    focus_areas: z.array(
        z.object({
            path: z.string(),
            why: z.string(),
            suggested_split: z.string().nullable(),
        }),
    ),
    notes: z.string().nullable(),
})

const RefactorParamsSchema = z.object({
    project_root: z.string().describe("Absolute or baseDir-relative path to the repository root."),
    user_task: z
        .string()
        .describe("Full original user task to keep context for the refactor and downstream work."),
    analysis: AnalyzeLikeSchema.describe(
        "Optional analysis JSON from codex_analyze_project (should match its output shape).",
    )
        .nullable()
        .optional(),
    worktree_name: z
        .string()
        .describe("Optional custom worktree name under .codex/jobs/<jobId>/worktrees.")
        .nullable()
        .optional(),
    base_branch: z
        .string()
        .describe("Optional override base branch/ref for the refactor worktree.")
        .nullable()
        .optional(),
})

const RefactorOutputSchema = z.object({
    status: z.enum(["ok", "skipped", "failed"]),
    summary: z.string(),
    branch: z.string(),
    worktree_path: z.string(),
    touched_files: z.array(z.string()).default([]),
    notes: z.string().optional().nullable(),
})

export type CodexRefactorProjectInput = z.infer<typeof RefactorParamsSchema>
export type CodexRefactorProjectResult = z.infer<typeof RefactorOutputSchema>

type RefactorExec = (args: {
    program: "git" | "codex"
    args: string[]
    cwd: string
    label?: string
    onStdoutLine?: (line: string) => void
    onStderrLine?: (line: string) => void
}) => Promise<{ stdout: string; stderr: string }>

const defaultExec: RefactorExec = async ({ program, args, cwd, label, onStdoutLine, onStderrLine }) => {
    if (program === "codex") {
        return runWithCodexTee({
            command: program,
            args,
            cwd,
            label: label ?? "codex-refactor",
            captureLimit: DEFAULT_CODEX_CAPTURE_LIMIT,
            onStdoutLine,
            onStderrLine,
        })
    }

    return execFileAsync(program, args, { cwd, maxBuffer: DEFAULT_MAX_BUFFER })
}

let execImplementation: RefactorExec = defaultExec

export function setRefactorExecImplementation(fn: RefactorExec | null) {
    execImplementation = fn ?? defaultExec
}

function resolveProjectRoot(
    projectRoot: string,
    runContext?: RunContext<OrchestratorContext>,
): string {
    if (runContext?.context?.repoRoot) return runContext.context.repoRoot

    if (path.isAbsolute(projectRoot)) return projectRoot

    const baseDir =
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

function buildRefactorPrompt(params: {
    userTask: string
    analysis: unknown
    branchName: string
    baseBranch: string
}): string {
    const { userTask, analysis, branchName, baseBranch } = params
    const analysisBlock = analysis
        ? [
              "Результаты стадии analyze (как есть, используй как подсказку, но проверяй по коду):",
              JSON.stringify(analysis, null, 2),
              "",
          ]
        : []

    return [
        "Единственная цель этой стадии — подготовить код к параллельной работе Codex. Делай минимально достаточный рефакторинг: распили только явно сцепленные куски на модули с меньшей ответственностью и минимальными связями.",
        "Сохрани поведение. Не добавляй новые фичи и не улучшай код ради стиля; только структурные правки, именования, разбиение файлов и очень мелкие шлифовки (док/комментарии) если нужны для распила.",
        "Если явных препятствий для параллели нет, верни status=\"skipped\" или status=\"ok\" без изменений.",
        "Если нужно, добавь лёгкие sanity-тесты/чеки, но без тяжёлых прогонов.",
        "",
        "Исходный запрос пользователя:",
        userTask,
        "",
        ...analysisBlock,
        `Работай в ветке ${branchName} (от ${baseBranch}), git-команды не выполняй. Оркестратор сам закоммитит изменения, если они есть.`,
        "",
        "В конце верни краткий JSON:",
        "{",
        '  "status": "ok" | "failed" | "skipped",',
        '  "summary": "string",',
        '  "branch": "string",',
        '  "worktree_path": "string",',
        '  "touched_files": ["path1", "path2"],',
        '  "notes": "string | null"',
        "}",
        "Без текста после JSON.",
    ].join("\n")
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
        throw new Error("Refactor output is empty")
    }

    const direct = tryParseJson(trimmed)
    if (direct !== null) return direct

    const lastClosing = trimmed.lastIndexOf("}")
    if (lastClosing === -1) {
        throw new Error("No JSON object boundaries found in refactor output")
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

    throw new Error("Unable to parse JSON object from refactor output")
}

function normalizeOutput(raw: unknown): CodexRefactorProjectResult {
    const parsed = RefactorOutputSchema.parse(raw)
    return {
        ...parsed,
        touched_files: parsed.touched_files ?? [],
        notes: parsed.notes ?? null,
    }
}

function truncate(text: string, limit: number): string {
    if (text.length <= limit) return text
    return `${text.slice(0, limit)} ... [truncated ${text.length - limit} chars]`
}

async function runGit(
    args: string[],
    cwd: string,
    exec: RefactorExec,
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
    jobId,
}: {
    cwd: string
    exec: RefactorExec
    jobId: string
}) {
    const status = await runGit(["status", "--porcelain"], cwd, exec, true)
    if (!status.stdout.trim()) {
        return false
    }

    await runGit(["add", "-A"], cwd, exec)
    const message = `job ${jobId}: pre-refactor for parallel work`
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
        throw new Error(`git commit failed: ${commitResult.stderr || commitResult.stdout}`)
    }

    return commitResult.code === 0
}

async function detectCurrentBranch(worktreeDir: string, exec: RefactorExec): Promise<string | null> {
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

async function listTouchedFiles(baseBranch: string, cwd: string, exec: RefactorExec) {
    try {
        const { stdout } = await exec({
            program: "git",
            args: ["diff", "--name-only", `${baseBranch}..HEAD`],
            cwd,
        })
        return stdout
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean)
    } catch {
        return []
    }
}

export async function codexRefactorProject(
    params: CodexRefactorProjectInput,
    runContext?: RunContext<OrchestratorContext>,
): Promise<CodexRefactorProjectResult> {
    const repoRoot = resolveProjectRoot(params.project_root, runContext)
    await ensureProjectRoot(repoRoot)

    const contextJobId = runContext?.context?.jobId
    const contextBaseBranch = runContext?.context?.baseBranch

    const resolvedJobId = resolveJobId(contextJobId ?? undefined)
    const baseBranch = params.base_branch ?? contextBaseBranch ?? DEFAULT_BASE_BRANCH
    const context = buildOrchestratorContext({
        repoRoot,
        jobId: resolvedJobId,
        baseBranch,
    })

    await ensureParentDir(context.worktreesRoot)

    const defaultWorktreeName = params.worktree_name?.trim() || "refactor"
    const worktreeDir = path.resolve(context.worktreesRoot, defaultWorktreeName)
    await ensureParentDir(worktreeDir)

    let branchName = sanitizeBranchName(`refactor-${context.jobId}`, `refactor-${Date.now()}`)
    const branchCheck = await runGit(
        ["rev-parse", "--verify", branchName],
        repoRoot,
        execImplementation,
        true,
    )
    const branchExists = branchCheck.code === 0

    const exists = await pathExists(worktreeDir)
    if (!exists) {
        const args = branchExists
            ? ["worktree", "add", worktreeDir, branchName]
            : ["worktree", "add", "-b", branchName, worktreeDir, context.baseBranch]
        await execImplementation({
            program: "git",
            args,
            cwd: repoRoot,
        })
    } else {
        const current = await detectCurrentBranch(worktreeDir, execImplementation)
        branchName = current || branchName
    }

    const prompt = buildRefactorPrompt({
        userTask: params.user_task,
        analysis: params.analysis,
        branchName,
        baseBranch: context.baseBranch,
    })

    let stdout = ""
    let stderr = ""

    const reasoningLines: string[] = []
    let lastFlush = 0
    const flushReasoning = (force = false) => {
        const now = Date.now()
        if (!force && now - lastFlush < 1000) return
        lastFlush = now
        const payload = reasoningLines.slice(-8).join("\n")
        if (!payload) return
        try {
            recordRefactorProgress({ context, message: payload })
        } catch {
            /* ignore logging failures */
        }
    }
    const captureLine = (line: string) => {
        const trimmed = line.trim()
        if (!trimmed) return
        reasoningLines.push(trimmed)
        if (reasoningLines.length > 20) reasoningLines.splice(0, reasoningLines.length - 20)
        flushReasoning()
    }

    try {
        markJobStatus(context, "refactoring")
        recordRefactorProgress({ context, message: "Refactor started" })
    } catch {
        /* ignore logging failures */
    }

    try {
        const codexArgs = [
            "exec",
            "--full-auto",
            "--config",
            'model_reasoning_effort="medium"',
            prompt,
        ]
        const result = await execImplementation({
            program: "codex",
            args: codexArgs,
            cwd: worktreeDir,
            label: "codex-refactor",
            // @ts-ignore execImplementation default supports line hooks
            onStdoutLine: captureLine,
            onStderrLine: captureLine,
        })
        stdout = result.stdout ?? ""
        stderr = result.stderr ?? ""
        const parsed = normalizeOutput(extractLastJsonObject(stdout || stderr))
        await commitIfNeeded({ cwd: worktreeDir, exec: execImplementation, jobId: context.jobId })
        const touched = await listTouchedFiles(context.baseBranch, worktreeDir, execImplementation)
        const merged = { ...parsed, branch: branchName, worktree_path: worktreeDir, touched_files: touched }
        flushReasoning(true)
        await persistRefactor(merged, context, params.user_task)
        return merged
    } catch (error: any) {
        flushReasoning(true)
        stdout = (error?.stdout ?? stdout ?? "") as string
        stderr = (error?.stderr ?? stderr ?? error?.message ?? "") as string

        try {
            const parsed = normalizeOutput(extractLastJsonObject(`${stdout}\n${stderr}`))
            await commitIfNeeded({ cwd: worktreeDir, exec: execImplementation, jobId: context.jobId })
            const touched = await listTouchedFiles(context.baseBranch, worktreeDir, execImplementation)
            const merged = {
                ...parsed,
                branch: branchName,
                worktree_path: worktreeDir,
                touched_files: touched,
            }
            await persistRefactor(merged, context, params.user_task)
            return merged
        } catch {
            const parts = [
                "codex_refactor_project failed: could not parse refactor JSON.",
                stdout ? `stdout (truncated):\n${truncate(stdout, OUTPUT_TRUNCATE)}` : null,
                stderr ? `stderr (truncated):\n${truncate(stderr, OUTPUT_TRUNCATE)}` : null,
                error?.message ? `error: ${error.message}` : null,
            ].filter(Boolean)
            throw new Error(parts.join("\n\n"))
        }
    }
}

export const codexRefactorProjectTool = tool({
    name: "codex_refactor_project",
    description:
        "Call Codex CLI to perform a preparatory refactor that improves parallelization before planning.",
    parameters: RefactorParamsSchema,
    async execute(params, runContext?: RunContext<OrchestratorContext>) {
        return codexRefactorProject(params, runContext)
    },
})

async function persistRefactor(
    result: CodexRefactorProjectResult,
    context: OrchestratorContext,
    userTask?: string,
) {
    try {
        await appendJobLog(
            `[refactor] status=${result.status} branch=${result.branch} files=${result.touched_files.length}`,
        )
        await recordRefactorOutput({ context, result, userTask })
    } catch {
        // logging failures should not break orchestrator flow
    }
}
