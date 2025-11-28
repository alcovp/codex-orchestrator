import { tool, type RunContext } from "@openai/agents"
import { z } from "zod"
import { access, mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import type { OrchestratorContext } from "../orchestratorTypes.js"
import { DEFAULT_CODEX_CAPTURE_LIMIT, runWithCodexTee } from "./codexExecLogger.js"
import { appendJobLog } from "../jobLogger.js"
import { recordAnalysisOutput } from "../db/sqliteDb.js"

const OUTPUT_TRUNCATE = 2000

const AnalyzeParamsSchema = z.object({
    project_root: z.string().describe("Absolute or baseDir-relative path to the repository root."),
    user_task: z.string().describe("Full original user task (used as context for the analysis)."),
})

const AnalyzeTargetSchema = z.object({
    path: z.string(),
    why: z.string(),
    suggested_split: z.string().optional().nullable(),
})

const AnalyzeOutputSchema = z.object({
    should_refactor: z.boolean(),
    reasons: z.array(z.string()).default([]),
    focus_areas: z.array(AnalyzeTargetSchema).default([]),
    notes: z.string().optional().nullable(),
})

export type CodexAnalyzeProjectInput = z.infer<typeof AnalyzeParamsSchema>
export type CodexAnalyzeProjectResult = z.infer<typeof AnalyzeOutputSchema>

type AnalyzeExec = (args: { cwd: string; prompt: string; label?: string }) => Promise<{
    stdout: string
    stderr: string
}>

const defaultExec: AnalyzeExec = async ({ cwd, prompt, label }) => {
    return runWithCodexTee({
        command: "codex",
        args: ["exec", "--full-auto", "--config", 'model_reasoning_effort="medium"', prompt],
        cwd,
        label: label ?? "codex-analyze",
        captureLimit: DEFAULT_CODEX_CAPTURE_LIMIT,
    })
}

let execImplementation: AnalyzeExec = defaultExec

export function setAnalyzeExecImplementation(fn: AnalyzeExec | null) {
    execImplementation = fn ?? defaultExec
}

function resolveProjectRoot(
    projectRoot: string,
    runContext?: RunContext<OrchestratorContext>,
): string {
    const explicit = projectRoot?.trim()

    if (runContext?.context?.repoRoot) {
        const repoRoot = path.resolve(runContext.context.repoRoot)

        if (explicit) {
            const candidate = path.isAbsolute(explicit)
                ? path.resolve(explicit)
                : path.resolve(repoRoot, explicit)

            // allow overriding to a worktree under the same repo root
            if (candidate === repoRoot || candidate.startsWith(repoRoot)) {
                return candidate
            }
        }

        return repoRoot
    }

    if (path.isAbsolute(projectRoot)) {
        return projectRoot
    }

    const baseDir =
        runContext?.context?.baseDir ??
        process.env.ORCHESTRATOR_BASE_DIR ??
        // fallback: current working directory if nothing else is set
        process.cwd()

    return path.resolve(baseDir, projectRoot)
}

async function ensureDirectoryExists(directory: string) {
    try {
        await access(directory)
    } catch {
        throw new Error(`project_root does not exist or is not accessible: ${directory}`)
    }
}

function buildAnalyzePrompt(userTask: string): string {
    const schema = JSON.stringify(
        {
            should_refactor: "boolean",
            reasons: ["string"],
            focus_areas: [
                {
                    path: "string",
                    why: "string",
                    suggested_split: "string | null",
                },
            ],
            notes: "string | null",
        },
        null,
        2,
    )

    return [
        "Ты работаешь в этом репозитории. Ничего не изменяй, только анализируй базу кода.",
        "",
        "Единственная цель: понять, мешает ли структура кода параллельному выполнению будущей задачи Codex и нужен ли минимальный подготовительный распил ради параллелизации.",
        "Смотри на признаки монолита (огромные файлы, смешанные ответственности, отсутствующие границы модулей), сильные связности и трудности распила.",
        "",
        "Исходный запрос пользователя:",
        userTask,
        "",
        "Определи, нужен ли минимально достаточный подготовительный рефакторинг исключительно для улучшения распараллеливания (распил на модули, разделение ответственностей).",
        "Если нет явных блокеров для параллели, честно верни should_refactor=false и кратко почему. Не предлагай функциональные улучшения или лишние изменения.",
        "",
        "Формат ответа — ВАЛИДНЫЙ JSON:",
        schema,
        "",
        "Без текста вне JSON.",
    ].join("\n")
}

function tryParseJson(text: string): unknown | null {
    try {
        return JSON.parse(text)
    } catch {
        return null
    }
}

function extractJsonObject(text: string): unknown {
    const trimmed = text.trim()
    if (!trimmed) {
        throw new Error("Analyze output is empty")
    }

    const direct = tryParseJson(trimmed)
    if (direct !== null) {
        return direct
    }

    const first = trimmed.indexOf("{")
    const last = trimmed.lastIndexOf("}")
    if (first === -1 || last === -1 || last <= first) {
        throw new Error("No JSON object boundaries found in analyze output")
    }

    const candidate = trimmed.slice(first, last + 1)
    const parsed = tryParseJson(candidate)
    if (parsed !== null) {
        return parsed
    }

    throw new Error("Unable to parse JSON object from analyze output")
}

function normalizeOutput(raw: unknown): CodexAnalyzeProjectResult {
    const parsed = AnalyzeOutputSchema.parse(raw)
    return {
        should_refactor: parsed.should_refactor,
        reasons: parsed.reasons ?? [],
        focus_areas: parsed.focus_areas ?? [],
        notes: parsed.notes ?? null,
    }
}

function truncate(text: string, limit: number): string {
    if (text.length <= limit) return text
    return `${text.slice(0, limit)} ... [truncated ${text.length - limit} chars]`
}

export async function codexAnalyzeProject(
    params: CodexAnalyzeProjectInput,
    runContext?: RunContext<OrchestratorContext>,
): Promise<CodexAnalyzeProjectResult> {
    const projectRoot = resolveProjectRoot(params.project_root, runContext)
    await ensureDirectoryExists(projectRoot)

    const prompt = buildAnalyzePrompt(params.user_task)
    let stdout = ""
    let stderr = ""

    try {
        const result = await execImplementation({
            cwd: projectRoot,
            prompt,
            label: "codex-analyze",
        })
        stdout = result.stdout ?? ""
        stderr = result.stderr ?? ""
        const analysis = normalizeOutput(extractJsonObject(stdout || stderr))
        await persistAnalysis(analysis, runContext?.context, params.user_task)
        return analysis
    } catch (error: any) {
        stdout = (error?.stdout ?? stdout ?? "") as string
        stderr = (error?.stderr ?? stderr ?? error?.message ?? "") as string

        try {
            const analysis = normalizeOutput(extractJsonObject(`${stdout}\n${stderr}`))
            await persistAnalysis(analysis, runContext?.context, params.user_task)
            return analysis
        } catch {
            const parts = [
                "codex_analyze_project failed: could not parse analysis JSON.",
                stdout ? `stdout (truncated):\n${truncate(stdout, OUTPUT_TRUNCATE)}` : null,
                stderr ? `stderr (truncated):\n${truncate(stderr, OUTPUT_TRUNCATE)}` : null,
                error?.message ? `error: ${error.message}` : null,
            ].filter(Boolean)

            throw new Error(parts.join("\n\n"))
        }
    }
}

export const codexAnalyzeProjectTool = tool({
    name: "codex_analyze_project",
    description:
        "Call Codex CLI to assess whether a pre-refactor is needed to improve parallelization for the user_task.",
    parameters: AnalyzeParamsSchema,
    async execute(params, runContext?: RunContext<OrchestratorContext>) {
        return codexAnalyzeProject(params, runContext)
    },
})

async function persistAnalysis(
    analysis: CodexAnalyzeProjectResult,
    context?: OrchestratorContext,
    userTask?: string,
) {
    if (!context?.jobsRoot) return
    const analysisPath = path.join(context.jobsRoot, "analysis-output.json")
    try {
        await mkdir(path.dirname(analysisPath), { recursive: true })
        await writeFile(analysisPath, JSON.stringify(analysis, null, 2), "utf8")
        await appendJobLog(`[analyze] saved analysis to ${analysisPath}`)
        await recordAnalysisOutput({ context, analysis, userTask: userTask ?? context.userTask })
    } catch {
        // logging failures should not break orchestrator flow
    }
}
