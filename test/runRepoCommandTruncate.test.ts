import assert from "node:assert/strict"
import { mkdtemp, mkdir, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { runRepoCommand } from "../src/tools/runRepoCommandTool.js"

test("runRepoCommand truncates long stdout to avoid huge prompts", async () => {
    const prevLimit = process.env.RUN_REPO_OUTPUT_LIMIT
    process.env.RUN_REPO_OUTPUT_LIMIT = "50"

    const baseDir = await mkdtemp(path.join(os.tmpdir(), "rrc-trunc-"))
    const worktreePath = path.join(baseDir, "main")
    await mkdir(worktreePath, { recursive: true })

    try {
        const result = await runRepoCommand(
            { worktree: "main", command: "node -e \"console.log('x'.repeat(200))\"" },
            { context: { baseDir } } as any,
        )

        assert.match(result, /\[truncated /i)
        assert.match(result, /STDOUT/)
    } finally {
        if (prevLimit === undefined) {
            delete process.env.RUN_REPO_OUTPUT_LIMIT
        } else {
            process.env.RUN_REPO_OUTPUT_LIMIT = prevLimit
        }
        await rm(baseDir, { recursive: true, force: true })
    }
})
