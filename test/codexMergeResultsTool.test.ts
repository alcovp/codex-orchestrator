import assert from "node:assert/strict"
import os from "node:os"
import path from "node:path"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { after, test } from "node:test"
import {
    codexMergeResults,
    setMergeExecImplementation,
} from "../src/tools/codexMergeResultsTool.js"
import { buildOrchestratorContext } from "../src/orchestratorTypes.js"

after(() => {
    setMergeExecImplementation(null)
})

test("codexMergeResults adds merge worktree, merges branches, and returns summary", async () => {
    const baseDir = await mkdtemp(path.join(os.tmpdir(), "codex-merge-"))
    const projectRoot = path.join(baseDir, "repo")
    await mkdir(projectRoot, { recursive: true })

    const jobId = "job-merge"
    const mergeWorktree = path.join(projectRoot, ".codex", "jobs", jobId, "worktrees", "result")
    const resultBranch = `result-${jobId}`

    const calls: Array<{ program: string; args: string[]; cwd: string }> = []

    setMergeExecImplementation(async ({ program, args, cwd }) => {
        calls.push({ program, args, cwd })
        if (program !== "git") {
            throw new Error("codex should not be called in clean merge")
        }

        const key = args.join(" ")
        if (args[0] === "worktree") {
            await mkdir(mergeWorktree, { recursive: true })
            return { stdout: "", stderr: "" }
        }
        if (args[0] === "rev-parse" && args[1] === "--verify") {
            const err: any = new Error("missing branch")
            err.code = 1
            err.stderr = "not found"
            throw err
        }
        if (args[0] === "branch") {
            return { stdout: "", stderr: "" }
        }
        if (args[0] === "merge") {
            return { stdout: "Merged", stderr: "" }
        }
        if (args[0] === "diff" && args[1] === "--name-only" && args[2] === "--diff-filter=U") {
            return { stdout: "", stderr: "" }
        }
        if (args[0] === "add" || args[0] === "commit") {
            return { stdout: "", stderr: "" }
        }
        if (args[0] === "diff" && args[1] === "--name-only") {
            return { stdout: "a.txt\nb.txt\n", stderr: "" }
        }

        return { stdout: "", stderr: "" }
    })

    try {
        const result = await codexMergeResults(
            {
                project_root: "repo",
                base_branch: "main",
                job_id: jobId,
                result_branch: resultBranch,
                subtasks_results: [
                    {
                        subtask_id: "s1",
                        worktree_path: "../task-1",
                        branch: "task-1",
                        summary: "done",
                    },
                    {
                        subtask_id: "s2",
                        worktree_path: path.join(baseDir, "task-2"),
                        branch: "task-2",
                        summary: "done",
                    },
                ],
            },
            { context: { baseDir } } as any,
        )

        assert.equal(result.status, "ok")
        assert.deepEqual(result.touched_files, ["a.txt", "b.txt"])
        const worktreeAdd = calls.find((c) => c.program === "git" && c.args[0] === "worktree")
        assert.ok(worktreeAdd)
        assert.deepEqual(worktreeAdd?.args, ["worktree", "add", mergeWorktree, resultBranch])
        assert.equal(worktreeAdd?.cwd, projectRoot)
        const mergeCalls = calls.filter((c) => c.program === "git" && c.args[0] === "merge")
        assert.equal(mergeCalls.length, 2)
    } finally {
        await rm(baseDir, { recursive: true, force: true })
    }
})

test("codexMergeResults prefers runContext job/result but allows base_branch override", async () => {
    const baseDir = await mkdtemp(path.join(os.tmpdir(), "codex-merge-context-"))
    const projectRoot = path.join(baseDir, "repo")
    await mkdir(projectRoot, { recursive: true })

    const jobIdCtx = "job-ctx"
    const baseBranchCtx = "ctx-main"
    const context = buildOrchestratorContext({
        repoRoot: projectRoot,
        jobId: jobIdCtx,
        baseBranch: baseBranchCtx,
    })
    const mergeWorktree = context.resultWorktree
    const expectedResultBranch = context.resultBranch

    const calls: Array<{ program: string; args?: string[]; cwd?: string; label?: string }> = []

    setMergeExecImplementation(async ({ program, args, cwd, label }) => {
        calls.push({ program, args, cwd, label })

        if (program === "git") {
            if (args?.[0] === "rev-parse") {
                throw new Error("missing branch")
            }
            if (args?.[0] === "branch") {
                return { stdout: "", stderr: "" }
            }
            if (args?.[0] === "worktree") {
                await mkdir(mergeWorktree, { recursive: true })
                return { stdout: "", stderr: "" }
            }
            if (args?.[0] === "merge") return { stdout: "", stderr: "" }
            if (
                args?.[0] === "diff" &&
                args[1] === "--name-only" &&
                args[2] === "--diff-filter=U"
            ) {
                return { stdout: "", stderr: "" }
            }
            if (args?.[0] === "add" || args?.[0] === "commit") return { stdout: "", stderr: "" }
            if (args?.[0] === "diff" && args[1] === "--name-only") {
                return { stdout: "x.txt\n", stderr: "" }
            }
            return { stdout: "", stderr: "" }
        }

        return { stdout: "", stderr: "" }
    })

    try {
        const result = await codexMergeResults(
            {
                project_root: projectRoot,
                job_id: "param-job",
                base_branch: "param-main",
                result_branch: "param-result",
                subtasks_results: [
                    { subtask_id: "s1", worktree_path: projectRoot, branch: "b", summary: "done" },
                ],
            },
            { context } as any,
        )

        assert.equal(result.status, "ok")
        assert.ok(Array.isArray(result.touched_files))
        const worktreeAdd = calls.find((c) => c.program === "git" && c.args?.[0] === "worktree")
        assert.ok(worktreeAdd)
        assert.equal(worktreeAdd?.args?.[2], mergeWorktree)
        assert.equal(worktreeAdd?.args?.[3], expectedResultBranch)

        const branchCreate = calls.find((c) => c.program === "git" && c.args?.[0] === "branch")
        assert.ok(branchCreate)
        assert.equal(branchCreate?.args?.[1], expectedResultBranch)
        assert.equal(branchCreate?.args?.[2], "param-main")

        assert.ok(
            !calls.some((c) => c.program === "codex"),
            "codex should not run for clean merges",
        )
    } finally {
        await rm(baseDir, { recursive: true, force: true })
    }
})

test("codexMergeResults pushes result branch when enabled", async () => {
    const baseDir = await mkdtemp(path.join(os.tmpdir(), "codex-merge-push-"))
    const projectRoot = path.join(baseDir, "repo")
    await mkdir(projectRoot, { recursive: true })

    const jobId = "job-push"
    const context = buildOrchestratorContext({
        repoRoot: projectRoot,
        jobId,
        baseBranch: "main",
        pushResult: true,
    })
    const mergeWorktree = context.resultWorktree
    const resultBranch = context.resultBranch

    let pushCalled = false

    setMergeExecImplementation(async ({ program, args }) => {
        if (program !== "git") {
            throw new Error("codex should not run in push test")
        }

        if (args[0] === "rev-parse") {
            throw Object.assign(new Error("missing branch"), { code: 1, stderr: "missing" })
        }
        if (args[0] === "branch") return { stdout: "", stderr: "" }
        if (args[0] === "worktree") {
            await mkdir(mergeWorktree, { recursive: true })
            return { stdout: "", stderr: "" }
        }
        if (args[0] === "merge") return { stdout: "", stderr: "" }
        if (args[0] === "status") return { stdout: "", stderr: "" }
        if (args[0] === "add" || args[0] === "commit") return { stdout: "", stderr: "" }
        if (args[0] === "diff" && args[1] === "--name-only" && args[2] === "--diff-filter=U") {
            return { stdout: "", stderr: "" }
        }
        if (args[0] === "diff" && args[1] === "--name-only" && args[2]?.includes("...")) {
            return { stdout: "merged.txt\n", stderr: "" }
        }
        if (args[0] === "push") {
            pushCalled = true
            return { stdout: "pushed", stderr: "" }
        }
        return { stdout: "", stderr: "" }
    })

    try {
        const result = await codexMergeResults(
            {
                project_root: projectRoot,
                job_id: jobId,
                base_branch: "main",
                result_branch: resultBranch,
                push_result: true,
                subtasks_results: [
                    {
                        subtask_id: "s1",
                        worktree_path: projectRoot,
                        branch: "feature",
                        summary: "done",
                    },
                ],
            },
            { context } as any,
        )

        assert.equal(result.status, "ok")
        assert.ok(pushCalled, "git push should be called when push_result is enabled")
        assert.match(result.notes, /pushed/i)
    } finally {
        await rm(baseDir, { recursive: true, force: true })
    }
})

test("codexMergeResults invokes Codex for conflicts but keeps git pointer intact", async () => {
    const baseDir = await mkdtemp(path.join(os.tmpdir(), "codex-merge-conflicts-"))
    const projectRoot = path.join(baseDir, "repo")
    await mkdir(projectRoot, { recursive: true })

    const context = buildOrchestratorContext({
        repoRoot: projectRoot,
        jobId: "job-c",
        baseBranch: "main",
    })
    const mergeWorktree = context.resultWorktree
    const gitPointer = "gitdir: /tmp/main/.git/worktrees/result\n"

    await mkdir(mergeWorktree, { recursive: true })
    await (await import("node:fs/promises")).writeFile(path.join(mergeWorktree, ".git"), gitPointer)

    const calls: Array<{ program: string; args?: string[]; cwd?: string; label?: string }> = []
    let codexCalled = false
    let resolved = false
    let stagedConflicts = false

    setMergeExecImplementation(async ({ program, args, cwd, label }) => {
        calls.push({ program, args, cwd, label })
        if (program === "git") {
            if (args?.[0] === "rev-parse") {
                throw Object.assign(new Error("missing branch"), { code: 1, stderr: "missing" })
            }
            if (args?.[0] === "branch") return { stdout: "", stderr: "" }
            if (args?.[0] === "worktree") return { stdout: "", stderr: "" }
            if (args?.[0] === "merge") return { stdout: "", stderr: "" }
            if (args?.[0] === "status") {
                const hasConflict = !(resolved && stagedConflicts)
                return { stdout: hasConflict ? "UU conflict.txt\n" : "", stderr: "" }
            }
            if (args?.[0] === "diff" && args[1] === "--name-only" && args[2]?.includes("...")) {
                return { stdout: "conflict.txt\n", stderr: "" }
            }
            if (args?.[0] === "add") {
                if (args?.[1] === "conflict.txt") stagedConflicts = true
                return { stdout: "", stderr: "" }
            }
            if (args?.[0] === "commit") return { stdout: "", stderr: "" }
            return { stdout: "", stderr: "" }
        }
        if (program === "codex") {
            // Simulate Codex edit; do not touch .git
            resolved = true
            codexCalled = true
            return { stdout: "done", stderr: "" }
        }
        throw new Error("unexpected program")
    })

    try {
        const result = await codexMergeResults(
            {
                project_root: projectRoot,
                job_id: "job-c",
                base_branch: "main",
                result_branch: context.resultBranch,
                subtasks_results: [
                    {
                        subtask_id: "s1",
                        worktree_path: projectRoot,
                        branch: "feature",
                        summary: "ok",
                    },
                ],
            },
            { context } as any,
        )

        assert.equal(result.status, "ok")
        assert.ok(codexCalled, "codex should be called for conflicts")
        const gitFile = await (
            await import("node:fs/promises")
        ).readFile(path.join(mergeWorktree, ".git"), "utf8")
        assert.equal(gitFile, gitPointer)
    } finally {
        await rm(baseDir, { recursive: true, force: true })
    }
})
