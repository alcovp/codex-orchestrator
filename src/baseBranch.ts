import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { DEFAULT_BASE_BRANCH } from "./orchestratorTypes.js";

const execFileAsync = promisify(execFile);

export async function resolveBaseBranch({
  repoRoot,
  explicitBranch,
}: {
  repoRoot: string;
  explicitBranch?: string | null;
}): Promise<string> {
  if (explicitBranch?.trim()) {
    return explicitBranch.trim();
  }

  const envBranch = process.env.ORCHESTRATOR_BASE_BRANCH?.trim();
  if (envBranch) return envBranch;

  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: repoRoot,
    });
    const branch = stdout.trim().split("\n")[0] ?? "";
    if (branch && branch !== "HEAD") {
      return branch;
    }
  } catch {
    // fall back to default
  }

  return DEFAULT_BASE_BRANCH;
}
