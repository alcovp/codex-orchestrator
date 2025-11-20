export interface OrchestratorContext {
  /**
   * Absolute path to the directory containing all worktrees
   * (for example, a folder that has "main", "task-1", "task-2", ... inside).
   */
  baseDir: string;
}
