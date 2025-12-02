import { tool, RunContext } from "@openai/agents"
import { z } from "zod"
import { access, mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import type { OrchestratorContext } from "../orchestratorTypes.js"
import { DEFAULT_CODEX_CAPTURE_LIMIT, runWithCodexTee } from "./codexExecLogger.js"
import { appendJobLog } from "../jobLogger.js"
import { markJobStatus, recordPlanProgress, recordPlannerOutput } from "../db/sqliteDb.js"

const OUTPUT_TRUNCATE = 2000

const PlannerParamsSchema = z.object({
    project_root: z.string().describe("Absolute or baseDir-relative path to the repository root."),
    user_task: z.string().describe("High-level user request to plan."),
})

const PlannerSubtaskSchema = z.object({
    id: z.string(),
    title: z.string(),
    description: z.string(),
    parallel_group: z.string(),
    context: z.string().nullable().optional(),
    notes: z.string().nullable().optional(),
})

const PlannerOutputSchema = z.object({
    can_parallelize: z.boolean(),
    subtasks: z.array(PlannerSubtaskSchema),
})

export type CodexPlanTaskInput = z.infer<typeof PlannerParamsSchema>
export type CodexPlanTaskResult = {
    can_parallelize: boolean
    subtasks: Array<
        z.infer<typeof PlannerSubtaskSchema> & {
            context: string | null
            notes: string | null
        }
    >
}

type PlannerExec = (args: {
    cwd: string
    prompt: string
    label?: string
    onStdoutLine?: (line: string) => void
    onStderrLine?: (line: string) => void
}) => Promise<{ stdout: string; stderr: string }>

const defaultExec: PlannerExec = async ({ cwd, prompt, label, onStdoutLine, onStderrLine }) => {
    return runWithCodexTee({
        command: "codex",
        args: ["exec", "--full-auto", prompt],
        cwd,
        label: label ?? "codex-plan",
        captureLimit: DEFAULT_CODEX_CAPTURE_LIMIT,
        onStdoutLine,
        onStderrLine,
    })
}

let execImplementation: PlannerExec = defaultExec

export function setPlannerExecImplementation(fn: PlannerExec | null) {
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
        runContext?.context?.repoRoot ??
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

function buildPlannerPrompt(userTask: string): string {
    return [
        "Ты работаешь в этом репозитории. Ничего не изменяй в коде, только анализируй.",
        "",
        "Запрос пользователя:",
        `"${userTask}"`,
        "",
        "Твоя задача:",
        "1. Понять, что нужно сделать в рамках этого проекта.",
        "2. Разбить работу на подзадачи только там, где это действительно помогает (разные файлы/подсистемы/навыки или явная возможность параллелить). Не дроби мелкие шаги.",
        "3. Определить, какие подзадачи можно выполнять параллельно.",
        "",
        "Правила для плана:",
        "- Не добавляй отдельные подзадачи для анализа/исследования/QA/ручного прогона тестов, если пользователь явно не просит и задача не огромная. По умолчанию такие этапы пропусти.",
        '- Поле parallel_group используй осознанно: если can_parallelize=true и нет зависимостей, ставь ОДИНАКОВОЕ значение parallel_group для всех независимых подзадач (например, "default"). Разные parallel_group нужны только если части требуют последовательных волн выполнения (жёсткие зависимости или ресурсы).',
        "- Разбивай только когда есть явное разделение по технологиям/подсистемам (разные библиотеки/стэки) или объём реально велик для одного Codex-прогона. Если задача маленькая/средняя — держи 1-2 подзадачи максимум.",
        "- Каждая подзадача должна напрямую приближать к выполнению запроса пользователя, без дублирования общей формулировки.",
        "- Описание подзадачи делай самодостаточным: 2-4 предложения с конкретными действиями, целевыми файлами/модулями (если понятны) и критериями готовности. Не ограничивайся короткими намеками.",
        '- Первое предложение описания явно должно ссылаться на исходный запрос (например, "В контексте запроса <цитата пользователя> сделать ...").',
        "- В описании сохраняй связь с исходным запросом, но чётко указывай, что поручено именно этой подзадаче.",
        "- В каждую подзадачу добавь поле context с исходным запросом пользователя (для понимания), даже если описание уже его упоминает.",
        "- Поле context должно содержать полный текст user_task без сокращений, многоточий и обрезки.",
        "",
        "Формат ответа — ВАЛИДНЫЙ JSON по схеме:",
        "",
        "{",
        '  "can_parallelize": boolean,',
        '  "subtasks": [',
        "    {",
        '      "id": "string",',
        '      "title": "string",',
        '      "description": "string",',
        '      "parallel_group": "string",',
        '      "context": "string | null",',
        '      "notes": "string | null"',
        "    }",
        "  ]",
        "}",
        "",
        "Не пиши ничего, кроме JSON.",
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
        throw new Error("Planner output is empty")
    }

    const direct = tryParseJson(trimmed)
    if (direct !== null) {
        return direct
    }

    const first = trimmed.indexOf("{")
    const last = trimmed.lastIndexOf("}")

    if (first === -1 || last === -1 || last <= first) {
        throw new Error("No JSON object boundaries found in planner output")
    }

    const candidate = trimmed.slice(first, last + 1)
    const parsed = tryParseJson(candidate)
    if (parsed !== null) {
        return parsed
    }

    throw new Error("Unable to parse JSON object from planner output")
}

function normalizeOutput(raw: unknown): CodexPlanTaskResult {
    const parsed = PlannerOutputSchema.parse(raw)
    return {
        can_parallelize: parsed.can_parallelize,
        subtasks: parsed.subtasks.map((subtask) => ({
            ...subtask,
            context: subtask.context ?? null,
            notes: subtask.notes ?? null,
        })),
    }
}

function truncate(text: string, limit: number): string {
    if (text.length <= limit) return text
    return `${text.slice(0, limit)} ... [truncated ${text.length - limit} chars]`
}

export async function codexPlanTask(
    params: CodexPlanTaskInput,
    runContext?: RunContext<OrchestratorContext>,
): Promise<CodexPlanTaskResult> {
    const projectRoot = resolveProjectRoot(params.project_root, runContext)
    await ensureDirectoryExists(projectRoot)

    const prompt = buildPlannerPrompt(params.user_task)
    let stdout = ""
    let stderr = ""

    const reasoningLines: string[] = []
    let lastFlush = 0
    const flushReasoning = (force = false) => {
        if (!runContext?.context) return
        const now = Date.now()
        if (!force && now - lastFlush < 1000) return
        lastFlush = now
        const payload = reasoningLines.slice(-8).join("\n")
        if (!payload) return
        try {
            recordPlanProgress({ context: runContext.context, message: payload })
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

    if (runContext?.context) {
        try {
            markJobStatus(runContext.context, "planning")
            recordPlanProgress({ context: runContext.context, message: "Planning started" })
        } catch {
            /* ignore logging failures */
        }
    }

    try {
        const result = await execImplementation({
            cwd: projectRoot,
            prompt,
            label: "codex-plan",
            onStdoutLine: captureLine,
            onStderrLine: captureLine,
        })
        stdout = result.stdout ?? ""
        stderr = result.stderr ?? ""
        const plan = normalizeOutput(extractJsonObject(stdout || stderr))
        flushReasoning(true)
        await persistPlan(plan, runContext?.context, params.user_task)
        return plan
    } catch (error: any) {
        flushReasoning(true)
        stdout = (error?.stdout ?? stdout ?? "") as string
        stderr = (error?.stderr ?? stderr ?? error?.message ?? "") as string

        try {
            const plan = normalizeOutput(extractJsonObject(`${stdout}\n${stderr}`))
            await persistPlan(plan, runContext?.context, params.user_task)
            return plan
        } catch {
            const parts = [
                "codex_plan_task failed: could not parse planner JSON.",
                stdout ? `stdout (truncated):\n${truncate(stdout, OUTPUT_TRUNCATE)}` : null,
                stderr ? `stderr (truncated):\n${truncate(stderr, OUTPUT_TRUNCATE)}` : null,
                error?.message ? `error: ${error.message}` : null,
            ].filter(Boolean)

            throw new Error(parts.join("\n\n"))
        }
    }
}

export const codexPlanTaskTool = tool({
    name: "codex_plan_task",
    description:
        "Call Codex CLI to produce a JSON plan for the user_task without modifying the repository.",
    parameters: PlannerParamsSchema,
    async execute(params, runContext?: RunContext<OrchestratorContext>) {
        return codexPlanTask(params, runContext)
    },
})

async function persistPlan(
    plan: CodexPlanTaskResult,
    context?: OrchestratorContext,
    userTask?: string,
) {
    if (!context?.jobsRoot) return
    const planPath = path.join(context.jobsRoot, "planner-output.json")
    try {
        await mkdir(path.dirname(planPath), { recursive: true })
        await writeFile(planPath, JSON.stringify(plan, null, 2), "utf8")
        await appendJobLog(`[planner] saved plan to ${planPath}`)
        if (userTask) {
            await recordPlannerOutput({ context, plan, userTask })
        }
    } catch {
        // Logging should not break orchestrator flow.
    }
}
