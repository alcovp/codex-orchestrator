import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { mkdir, rm } from "node:fs/promises";
import { test } from "node:test";
import { runDeterministicOrchestrator } from "../src/deterministicOrchestrator.js";

function isNoLiveTests(): boolean {
  const value = process.env.NO_LIVE_TESTS;
  if (!value) return false;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

const SKIP_LIVE = isNoLiveTests();

test(
  "live deterministic pipeline smoke (planner -> subtasks -> merge)",
  { timeout: 300_000 },
  async (t) => {
    if (SKIP_LIVE) {
      t.diagnostic("NO_LIVE_TESTS set; skipping live deterministic pipeline smoke.");
      return;
    }

    const baseDir = "/tmp/orch";
    const mainDir = path.join(baseDir, "main");

    // Clean and prep /tmp/orch/main
    await rm(baseDir, { recursive: true, force: true });
    await mkdir(mainDir, { recursive: true });

    execSync("git init -b main", { cwd: mainDir, stdio: "inherit" });
    execSync('git config user.email "smoke@example.com"', { cwd: mainDir, stdio: "inherit" });
    execSync('git config user.name "Smoke Test"', { cwd: mainDir, stdio: "inherit" });
    execSync('bash -lc \'echo "# smoke" > README.md\'', { cwd: mainDir, stdio: "inherit" });
    execSync("git add README.md", { cwd: mainDir, stdio: "inherit" });
    execSync('git commit -m "init"', { cwd: mainDir, stdio: "inherit" });

    // Point orchestrator to /tmp/orch
    process.env.ORCHESTRATOR_BASE_DIR = baseDir;

    const userTask = [
      "Создай файл live-smoke.txt в корне, заполни строкой \"live smoke ok\",",
      "и подготовь минимальные проверки/коммит, если нужно.",
    ].join(" ");

    const result = await runDeterministicOrchestrator({
      userTask,
      baseDir,
    });

    // Basic sanity: planner returned tasks, merge produced status
    assert.ok(result.plan.subtasks.length >= 1, "planner should return >=1 subtask");
    assert.ok(result.mergeResult.status === "ok" || result.mergeResult.status === "needs_manual_review");

    // Emit diagnostics for inspection
    console.log("[live smoke] plan subtasks:", result.plan.subtasks.map((s) => s.id).join(", "));
    console.log("[live smoke] merge status:", result.mergeResult.status);
    console.log("[live smoke] touched files:", result.mergeResult.touched_files?.join(", "));
  },
);
