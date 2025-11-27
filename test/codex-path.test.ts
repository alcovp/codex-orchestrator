import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { test } from "node:test"

test("codex binary is available in PATH", () => {
    const result = spawnSync("codex", ["--version"], { encoding: "utf8" })
    const pathEnv = process.env.PATH || ""

    const hasCodexInPath = result.status === 0 && result.stdout.trim().length > 0

    assert.ok(
        hasCodexInPath,
        [
            "Codex CLI is not available in PATH.",
            `PATH: ${pathEnv}`,
            `stdout: ${result.stdout || "(empty)"}`,
            `stderr: ${result.stderr || "(empty)"}`,
            `status: ${result.status}`,
        ].join("\n"),
    )
})
