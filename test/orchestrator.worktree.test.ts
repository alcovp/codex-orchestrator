import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { access, mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { runOrchestrator } from "../src/orchestratorAgent.js";

function isNoLiveTests(): boolean {
  const value = process.env.SKIP_LIVE_TESTS;
  if (!value) return false;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

const SKIP_LIVE = isNoLiveTests();

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

test("orchestrator (live) creates multiple worktrees in a fresh repo", async (t) => {
  if (SKIP_LIVE) {
    t.diagnostic("SKIP_LIVE_TESTS set; skipping live orchestrator test.");
    return;
  }
  const originalBaseDir = process.env.ORCHESTRATOR_BASE_DIR;
  const originalJobId = process.env.ORCHESTRATOR_JOB_ID;
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "orchestrator-live-"));
  const jobId = "job-live-worktrees";

  try {
    loadEnvFromDotenv();
    execSync("git init -b main", { cwd: repoRoot });
    execSync('git config user.email "test@example.com"', { cwd: repoRoot });
    execSync('git config user.name "Test User"', { cwd: repoRoot });
    await writeFile(path.join(repoRoot, "README.md"), "# temp repo\n");
    execSync("git add README.md", { cwd: repoRoot });
    execSync('git commit -m "init"', { cwd: repoRoot });

    process.env.ORCHESTRATOR_BASE_DIR = repoRoot;
    process.env.ORCHESTRATOR_JOB_ID = jobId;

    const task =
      [
        "Create two worktrees from main named task-auth and task-telemetry inside .codex/jobs/job-live-worktrees/worktrees (branches with the same names).",
        "Do not push anywhere; local commits only are fine.",
        "Summarize steps.",
      ].join(" ");

    const result = await runOrchestrator({ taskDescription: task, jobId });

    const worktrees = ["task-auth", "task-telemetry"];
    for (const wt of worktrees) {
      await assertExists(path.join(repoRoot, ".codex", "jobs", jobId, "worktrees", wt));
      assert.match(result, new RegExp(wt));
    }
  } finally {
    process.env.ORCHESTRATOR_BASE_DIR = originalBaseDir;
    process.env.ORCHESTRATOR_JOB_ID = originalJobId;
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test(
  "orchestrator (live) runs codex in two worktrees and merges to main",
  { timeout: 180_000 },
  async (t) => {
    if (SKIP_LIVE) {
      t.diagnostic("SKIP_LIVE_TESTS set; skipping live orchestrator test.");
      return;
    }
    const originalBaseDir = process.env.ORCHESTRATOR_BASE_DIR;
    const originalJobId = process.env.ORCHESTRATOR_JOB_ID;
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "orchestrator-live-merge-"));
    const jobId = "job-live-merge";

    try {
      loadEnvFromDotenv();
      execSync("git init -b main", { cwd: repoRoot });
      execSync('git config user.email "test@example.com"', { cwd: repoRoot });
      execSync('git config user.name "Test User"', { cwd: repoRoot });
      await writeFile(path.join(repoRoot, "README.md"), "# temp repo\n");
      execSync("git add README.md", { cwd: repoRoot });
      execSync('git commit -m "init"', { cwd: repoRoot });

      process.env.ORCHESTRATOR_BASE_DIR = repoRoot;
      process.env.ORCHESTRATOR_JOB_ID = jobId;

      const task = [
        "This is a controlled test in a throwaway repo. Follow these explicit steps:",
        `1) Prepare two worktrees from main named "task-alpha" and "task-beta" under .codex/jobs/${jobId}/worktrees using local branches with the same names.`,
        '2) In worktree "task-alpha": create alpha.txt at repo root with content "alpha file" (Codex first, fallback to shell). Commit locally.',
        '3) In worktree "task-beta": create beta.txt at repo root with content "beta file" (Codex first, fallback to shell). Commit locally.',
        `4) Merge both branches into the shared result branch (result-${jobId}) without pushing.`,
        "5) Summarize commands and worktrees used.",
      ].join(" ");

      const result = await runOrchestrator({ taskDescription: task, jobId });
      console.log("orchestrator output (merge test):\n", result);

      const files = ["alpha.txt", "beta.txt"];
      const resultWorktree = path.join(repoRoot, ".codex", "jobs", jobId, "worktrees", "result");
      for (const file of files) {
        await assertExists(path.join(resultWorktree, file));
        assert.match(result, new RegExp(file));
      }
    } finally {
      process.env.ORCHESTRATOR_BASE_DIR = originalBaseDir;
      process.env.ORCHESTRATOR_JOB_ID = originalJobId;
      await rm(repoRoot, { recursive: true, force: true });
    }
  },
);

test(
  "orchestrator (live) can create a file using codex (with fallback)",
  { timeout: 120_000 },
  async (t) => {
    if (SKIP_LIVE) {
      t.diagnostic("SKIP_LIVE_TESTS set; skipping live orchestrator test.");
      return;
    }
    const originalBaseDir = process.env.ORCHESTRATOR_BASE_DIR;
    const originalJobId = process.env.ORCHESTRATOR_JOB_ID;
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "orchestrator-codex-"));
    const jobId = "job-codex";

    try {
      loadEnvFromDotenv();
      execSync("git init -b main", { cwd: repoRoot });
      execSync('git config user.email "test@example.com"', { cwd: repoRoot });
      execSync('git config user.name "Test User"', { cwd: repoRoot });
      await writeFile(path.join(repoRoot, "README.md"), "# temp repo\n");
      execSync("git add README.md", { cwd: repoRoot });
      execSync('git commit -m "init"', { cwd: repoRoot });

      process.env.ORCHESTRATOR_BASE_DIR = repoRoot;
      process.env.ORCHESTRATOR_JOB_ID = jobId;

      const task = [
        "This is a controlled codex smoke test in a throwaway repo. Steps:",
        '1) Create a worktree for the task (e.g., task-codex) from main under .codex/jobs/job-codex/worktrees.',
        '2) In that worktree, first attempt: run Codex CLI a single time to create codex-smoke.txt at repo root with content "codex smoke test".',
        "3) If Codex CLI fails for any reason, fall back immediately to run_repo_command with a cat-heredoc to create the same file/content.",
        "4) Stage and commit the file locally, then ensure it is merged into the result branch.",
        "4) Summarize commands run.",
      ].join(" ");

      const result = await runOrchestrator({ taskDescription: task, jobId });
      const smokePath = path.join(repoRoot, ".codex", "jobs", jobId, "worktrees", "result", "codex-smoke.txt");
      await assertExists(smokePath);
      const content = await readFile(smokePath, "utf8");
      assert.match(content, /codex smoke test/);
      assert.match(result, /codex-smoke\.txt/);
    } finally {
      process.env.ORCHESTRATOR_BASE_DIR = originalBaseDir;
      process.env.ORCHESTRATOR_JOB_ID = originalJobId;
      await rm(repoRoot, { recursive: true, force: true });
    }
  },
);
