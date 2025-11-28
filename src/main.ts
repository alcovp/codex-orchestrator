import path from "node:path"
import { loadEnv } from "./loadEnv.js"
import { runOrchestrator, type OrchestratorRunOptions } from "./orchestratorAgent.js"
import { buildOrchestratorContext } from "./orchestratorTypes.js"

type ParsedArgs = {
    taskDescription: string
    repoRoot?: string
    baseBranch?: string
    pushResult: boolean
    verboseLog: boolean
    enablePrefactor: boolean
}

function usage(error?: string) {
    const lines = [
        error ? `Error: ${error}` : null,
        "Usage:",
        '  yarn orchestrator [--repo <path>] [--base-branch <branch>] [--push-result] "<task description>"',
        "",
        "Options:",
        "  --repo, --repo-root, --project-root <path>  Absolute path to target repo (defaults to ORCHESTRATOR_BASE_DIR or cwd)",
        "  --base-branch <branch>            Base branch for new worktrees (defaults to current branch or main)",
        "  --push-result                     Push the merged result branch to origin after merge",
        "  --verbose                         Write full Codex output to orchestrator.log (default: minimal log)",
        "  --prefactor                       Enable pre-plan analyze+refactor stages (default: off)",
        "",
        "Example:",
        '  yarn orchestrator --repo /work/my-repo --base-branch develop --push-result --verbose "Add feature X"',
    ].filter(Boolean)

    console.error(lines.join("\n"))
}

function parseArgs(argv: string[]): ParsedArgs {
    let repoRoot: string | undefined
    let baseBranch: string | undefined
    let pushResult = false
    let verboseLog = false
    let enablePrefactor = false
    const taskParts: string[] = []
    let passthrough = false

    const takeValue = (arr: string[], idx: number, label: string): [string, number] => {
        const next = arr[idx + 1]
        if (!next) {
            throw new Error(`Missing value for ${label}`)
        }
        return [next, idx + 1]
    }

    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i]

        if (passthrough) {
            taskParts.push(arg)
            continue
        }

        if (arg === "--") {
            passthrough = true
            continue
        }

        if (arg === "--repo" || arg === "--repo-root" || arg === "--project-root") {
            const [value, nextIndex] = takeValue(argv, i, arg)
            repoRoot = value
            i = nextIndex
            continue
        }

        if (
            arg.startsWith("--repo=") ||
            arg.startsWith("--repo-root=") ||
            arg.startsWith("--project-root=")
        ) {
            repoRoot = arg.split("=", 2)[1]
            continue
        }

        if (arg === "--base-branch") {
            const [value, nextIndex] = takeValue(argv, i, arg)
            baseBranch = value
            i = nextIndex
            continue
        }

        if (arg.startsWith("--base-branch=")) {
            baseBranch = arg.split("=", 2)[1]
            continue
        }

        if (arg === "--push-result" || arg === "--push") {
            pushResult = true
            continue
        }

        if (arg === "--verbose" || arg === "--verbose-log") {
            verboseLog = true
            continue
        }

        if (arg === "--prefactor" || arg === "--enable-prefactor") {
            enablePrefactor = true
            continue
        }

        taskParts.push(arg)
    }

    return {
        taskDescription: taskParts.join(" ").trim(),
        repoRoot,
        baseBranch,
        pushResult,
        verboseLog,
        enablePrefactor,
    }
}

export async function main() {
    loadEnv()

    let parsed: ParsedArgs
    try {
        parsed = parseArgs(process.argv.slice(2))
    } catch (error: any) {
        usage(error?.message)
        process.exit(1)
        return
    }

    if (!parsed.taskDescription) {
        usage("Task description is required.")
        process.exit(1)
        return
    }

    const previewContext = buildOrchestratorContext({
        repoRoot: parsed.repoRoot,
        baseDir: parsed.repoRoot,
        baseBranch: parsed.baseBranch,
        taskDescription: parsed.taskDescription,
        userTask: parsed.taskDescription,
        enablePrefactor: parsed.enablePrefactor,
    })

    const options: OrchestratorRunOptions = {
        taskDescription: parsed.taskDescription,
        repoRoot: parsed.repoRoot,
        baseBranch: parsed.baseBranch,
        pushResult: parsed.pushResult,
        verboseLog: parsed.verboseLog,
        jobId: previewContext.jobId,
        enablePrefactor: parsed.enablePrefactor,
    }

    try {
        await runOrchestrator(options)
        const logPath = path.join(previewContext.jobsRoot, "orchestrator.log")
        console.log(`[orchestrator] job ${previewContext.jobId} finished. Full log: ${logPath}`)
    } catch (error) {
        console.error("Orchestrator failed:", error)
        process.exitCode = 1
    }
}

main()

/*
Before running, set:
- OPENAI_API_KEY: your OpenAI key
- ORCHESTRATOR_BASE_DIR: absolute path to the repository root (worktrees go to .codex/jobs/<jobId>/worktrees)

Example:
export OPENAI_API_KEY="sk-..."
export ORCHESTRATOR_BASE_DIR="/path/to/your/repo"
yarn orchestrator "Refactor billing module and add tests"
*/
