import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { access, mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { runOrchestrator } from "../src/orchestratorAgent.js";

async function assertExists(p: string) {
  await access(p);
}

function loadEnvFromDotenv() {
  const envPath = path.resolve(process.cwd(), ".env");
  if (!existsSync(envPath)) return;

  const lines = readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim().replace(/^['"]|['"]$/g, "");
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}

test("orchestrator (live) creates multiple worktrees in a fresh repo", async () => {
  const originalBaseDir = process.env.ORCHESTRATOR_BASE_DIR;
  const baseDir = await mkdtemp(path.join(os.tmpdir(), "orchestrator-live-"));
  const mainDir = path.join(baseDir, "main");

  await mkdir(mainDir, { recursive: true });

  try {
    loadEnvFromDotenv();
    execSync("git init -b main", { cwd: mainDir });
    execSync('git config user.email "test@example.com"', { cwd: mainDir });
    execSync('git config user.name "Test User"', { cwd: mainDir });
    await writeFile(path.join(mainDir, "README.md"), "# temp repo\n");
    execSync("git add README.md", { cwd: mainDir });
    execSync('git commit -m "init"', { cwd: mainDir });

    process.env.ORCHESTRATOR_BASE_DIR = baseDir;

    const task =
      [
        "Create two worktrees from main named task-auth and task-telemetry using run_repo_command.",
        'DO: run_repo_command with worktree="main" and command="git worktree add ../task-auth -b task-auth main".',
        'DO: run_repo_command with worktree="main" and command="git worktree add ../task-telemetry -b task-telemetry main".',
        "Do not push. Summarize steps.",
      ].join(" ");

    const result = await runOrchestrator({ taskDescription: task });

    const worktrees = ["task-auth", "task-telemetry"];
    for (const wt of worktrees) {
      await assertExists(path.join(baseDir, wt));
      assert.match(result, new RegExp(wt));
    }
  } finally {
    process.env.ORCHESTRATOR_BASE_DIR = originalBaseDir;
    await rm(baseDir, { recursive: true, force: true });
  }
});

test(
  "orchestrator (live) runs codex in two worktrees and merges to main",
  async () => {
    const originalBaseDir = process.env.ORCHESTRATOR_BASE_DIR;
    const baseDir = await mkdtemp(path.join(os.tmpdir(), "orchestrator-live-merge-"));
    const mainDir = path.join(baseDir, "main");

    await mkdir(mainDir, { recursive: true });

    try {
      loadEnvFromDotenv();
      execSync("git init -b main", { cwd: mainDir });
      execSync('git config user.email "test@example.com"', { cwd: mainDir });
      execSync('git config user.name "Test User"', { cwd: mainDir });
      await writeFile(path.join(mainDir, "README.md"), "# temp repo\n");
      execSync("git add README.md", { cwd: mainDir });
      execSync('git commit -m "init"', { cwd: mainDir });

      process.env.ORCHESTRATOR_BASE_DIR = baseDir;

      const task = [
        "This is a controlled test in a throwaway repo. Follow these explicit steps:",
        '1) Create two worktrees from main named "task-alpha" and "task-beta" using run_repo_command with HEAD as base (e.g., `git worktree add ../task-alpha -b task-alpha HEAD`).',
        '2) In worktree "task-alpha": first try Codex CLI to create alpha.txt at repo root with content "alpha file"; if Codex fails, use run_repo_command with a cat-heredoc to create the file. Then git add/commit the change.',
        '3) In worktree "task-beta": first try Codex CLI to create beta.txt at repo root with content "beta file"; if Codex fails, use run_repo_command with a cat-heredoc to create the file. Then git add/commit the change.',
        "4) In main, merge both branches (task-alpha then task-beta) locally (no pushing).",
        "5) Summarize commands and worktrees used.",
      ].join(" ");

      const result = await runOrchestrator({ taskDescription: task });
      console.log("orchestrator output (merge test):\n", result);

      const files = ["alpha.txt", "beta.txt"];
      for (const file of files) {
        await assertExists(path.join(baseDir, "main", file));
        assert.match(result, new RegExp(file));
      }
    } finally {
      process.env.ORCHESTRATOR_BASE_DIR = originalBaseDir;
      await rm(baseDir, { recursive: true, force: true });
    }
  },
  { timeout: 180_000 },
);

test(
  "orchestrator (live) can create a file using codex (with fallback)",
  async () => {
    const originalBaseDir = process.env.ORCHESTRATOR_BASE_DIR;
    const baseDir = await mkdtemp(path.join(os.tmpdir(), "orchestrator-codex-"));
    const mainDir = path.join(baseDir, "main");

    await mkdir(mainDir, { recursive: true });

    try {
      loadEnvFromDotenv();
      execSync("git init -b main", { cwd: mainDir });
      execSync('git config user.email "test@example.com"', { cwd: mainDir });
      execSync('git config user.name "Test User"', { cwd: mainDir });
      await writeFile(path.join(mainDir, "README.md"), "# temp repo\n");
      execSync("git add README.md", { cwd: mainDir });
      execSync('git commit -m "init"', { cwd: mainDir });

      process.env.ORCHESTRATOR_BASE_DIR = baseDir;

      const task = [
        "This is a controlled codex smoke test in a throwaway repo. Steps:",
        '1) In worktree "main", first attempt: run Codex CLI a single time to create codex-smoke.txt at repo root with content "codex smoke test".',
        "2) If Codex CLI fails for any reason, fall back immediately to run_repo_command with a cat-heredoc to create the same file/content.",
        "3) Stage and commit the file in main (no pushing).",
        "4) Summarize commands run.",
      ].join(" ");

      const result = await runOrchestrator({ taskDescription: task });
      const smokePath = path.join(baseDir, "main", "codex-smoke.txt");
      await assertExists(smokePath);
      const content = await readFile(smokePath, "utf8");
      assert.match(content, /codex smoke test/);
      assert.match(result, /codex-smoke\.txt/);
    } finally {
      process.env.ORCHESTRATOR_BASE_DIR = originalBaseDir;
      await rm(baseDir, { recursive: true, force: true });
    }
  },
  { timeout: 120_000 },
);
