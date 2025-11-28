import assert from "node:assert/strict"
import os from "node:os"
import path from "node:path"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { after, test } from "node:test"
import { runDeterministicOrchestrator } from "../src/deterministicOrchestrator.js"
import {
    setAnalyzeExecImplementation,
    type CodexAnalyzeProjectResult,
} from "../src/tools/codexAnalyzeProjectTool.js"
import {
    setPlannerExecImplementation,
    type CodexPlanTaskResult,
} from "../src/tools/codexPlanTaskTool.js"
import {
    setRefactorExecImplementation,
    type CodexRefactorProjectResult,
} from "../src/tools/codexRefactorProjectTool.js"
import {
    setSubtaskExecImplementation,
    type CodexRunSubtaskResult,
} from "../src/tools/codexRunSubtaskTool.js"
import { setMergeExecImplementation } from "../src/tools/codexMergeResultsTool.js"

after(() => {
    setAnalyzeExecImplementation(null)
    setPlannerExecImplementation(null)
    setRefactorExecImplementation(null)
    setSubtaskExecImplementation(null)
    setMergeExecImplementation(null)
})

test("deterministic orchestrator runs plan -> grouped subtasks -> merge", async () => {
    const baseDir = await mkdtemp(path.join(os.tmpdir(), "orchestrator-deterministic-"))
    const repoRoot = path.join(baseDir, "repo")
    await mkdir(repoRoot, { recursive: true })
    const jobId = "job-deterministic"
    const refactorWorktree = path.join(repoRoot, ".codex", "jobs", jobId, "worktrees", "refactor")

    const plan: CodexPlanTaskResult = {
        can_parallelize: true,
        subtasks: [
            {
                id: "alpha",
                title: "A",
                description: "do A",
                parallel_group: "g1",
                context: "Ship feature",
                notes: null,
            },
            {
                id: "beta",
                title: "B",
                description: "do B",
                parallel_group: "g1",
                context: "Ship feature",
                notes: null,
            },
            {
                id: "gamma",
                title: "C",
                description: "do C",
                parallel_group: "g2",
                context: "Ship feature",
                notes: null,
            },
        ],
    }

    const subtaskEvents: string[] = []
    const subtaskBaseBranches: string[] = []
    let completedG1 = 0

    const analysis: CodexAnalyzeProjectResult = {
        should_refactor: true,
        reasons: ["monolith"],
        focus_areas: [],
        notes: null,
    }

    setAnalyzeExecImplementation(async ({ cwd }) => {
        subtaskEvents.push(`analyze:${cwd}`)
        return { stdout: JSON.stringify(analysis), stderr: "" }
    })

    const planExecCalls: Array<{ cwd: string; prompt: string }> = []
    setPlannerExecImplementation(async ({ cwd, prompt }) => {
        planExecCalls.push({ cwd, prompt })
        return { stdout: JSON.stringify(plan), stderr: "" }
    })

    setSubtaskExecImplementation(async ({ program, args, cwd }) => {
        if (program === "git") {
            if (args[0] === "worktree") {
                subtaskEvents.push(`git:${args[3]}`)
                subtaskBaseBranches.push(args[args.length - 1])
            }
            return { stdout: "", stderr: "" }
        }

        const prompt = args[2] ?? ""
        const match = prompt.match(/"subtask_id": "([^"]+)"/)
        const id = match?.[1] ?? "unknown"
        subtaskEvents.push(`codex:${id}:${cwd}`)

        if (id === "gamma") {
            assert.ok(completedG1 >= 2, "gamma started before g1 batch completed")
        }

        const result: CodexRunSubtaskResult = {
            subtask_id: id,
            status: "ok",
            summary: `done-${id}`,
            important_files: [`${id}.txt`],
            branch: `task-${id}`,
        }

        if (id === "alpha" || id === "beta") {
            completedG1 += 1
        }

        return { stdout: JSON.stringify(result), stderr: "" }
    })

    const refactorResult: CodexRefactorProjectResult = {
        status: "ok",
        summary: "refactor ready",
        branch: `refactor-${jobId}`,
        worktree_path: refactorWorktree,
        touched_files: ["refactor.txt"],
        notes: null,
    }

    setRefactorExecImplementation(async ({ program, args, cwd }) => {
        if (program === "git") {
            if (args[0] === "rev-parse") {
                const err: any = new Error("missing branch")
                err.code = 1
                err.stderr = "missing"
                throw err
            }
            if (args[0] === "worktree" && args[1] === "add") {
                const target = args.includes("-b") ? args[args.length - 2] : args[2]
                await mkdir(target, { recursive: true })
                return { stdout: "", stderr: "" }
            }
            if (args[0] === "status") {
                return { stdout: " M refactor.txt\n", stderr: "" }
            }
            if (args[0] === "add" || args[0] === "commit") {
                return { stdout: "", stderr: "" }
            }
            if (args[0] === "diff" && args[1] === "--name-only") {
                return { stdout: "refactor.txt\n", stderr: "" }
            }
            return { stdout: "", stderr: "" }
        }
        subtaskEvents.push(`refactor-codex:${cwd}`)
        return { stdout: JSON.stringify(refactorResult), stderr: "" }
    })

    const mergeCalls: Array<{ args: string[]; cwd: string }> = []
    setMergeExecImplementation(async ({ program, args, cwd }) => {
        if (program === "git") {
            if (args[0] === "worktree") {
                await mkdir(path.join(repoRoot, ".codex", "jobs", jobId, "worktrees", "result"), {
                    recursive: true,
                })
            } else if (args[0] === "rev-parse") {
                const err: any = new Error("missing branch")
                err.code = 1
                err.stderr = "missing"
                throw err
            } else if (
                args[0] === "branch" ||
                args[0] === "merge" ||
                args[0] === "add" ||
                args[0] === "commit"
            ) {
                // no-op
            } else if (
                args[0] === "diff" &&
                args[1] === "--name-only" &&
                args[2] === "--diff-filter=U"
            ) {
                // no conflicts
                return { stdout: "", stderr: "" }
            } else if (args[0] === "diff" && args[1] === "--name-only") {
                return { stdout: "alpha.txt\nbeta.txt\ngamma.txt\n", stderr: "" }
            }
            return { stdout: "", stderr: "" }
        }
        mergeCalls.push({ args, cwd })
        return { stdout: "", stderr: "" }
    })

    try {
        const result = await runDeterministicOrchestrator({
            userTask: "Ship feature",
            repoRoot,
            jobId,
            enablePrefactor: true,
        })

        assert.equal(result.analysis.should_refactor, true)
        assert.equal(result.refactor?.status, "ok")
        assert.equal(planExecCalls[0]?.cwd, refactorWorktree)
        assert.ok(subtaskBaseBranches.every((branch) => branch === refactorResult.branch))

        // Plan captured
        assert.equal(result.plan.subtasks.length, 3)

        // Subtasks run in batches: g1 (alpha/beta) then g2 (gamma)
        assert.ok(completedG1 === 2, "both g1 subtasks should complete")

        // Merge invoked (git calls captured)
        assert.ok(result.mergeResult.status === "ok")
        assert.equal(result.subtaskResults.length, 3)
    } finally {
        await rm(baseDir, { recursive: true, force: true })
    }
})
