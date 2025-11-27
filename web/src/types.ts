export type JobStatus =
    | "planning"
    | "running"
    | "merging"
    | "done"
    | "failed"
    | "needs_manual_review"
export type SubtaskStatus = "pending" | "running" | "completed" | "failed"

export interface ArtifactRecord {
    id: string
    type: "plan" | "subtask_result" | "merge_result" | "merge_input"
    label?: string
    createdAt: string
    subtaskId?: string
    data: unknown
}

export interface SubtaskRecord {
    id: string
    title: string
    description?: string
    parallel_group?: string
    status: SubtaskStatus
    worktree?: string
    branch?: string
    summary?: string
    important_files?: string[]
    error?: string
    startedAt?: string
    finishedAt?: string
    updatedAt: string
}

export interface PlanSubtask {
    id: string
    title: string
    description: string
    parallel_group: string
    context: string | null
    notes: string | null
}

export interface Plan {
    can_parallelize: boolean
    subtasks: PlanSubtask[]
}

export interface JobRecord {
    jobId: string
    repoRoot: string
    baseBranch: string
    taskDescription: string
    userTask: string
    pushResult: boolean
    status: JobStatus
    startedAt: string
    updatedAt: string
    plan?: Plan
    mergeResult?: {
        status: string
        notes: string
        touched_files: string[]
    }
    subtasks: SubtaskRecord[]
    artifacts: ArtifactRecord[]
}

export interface DbShape {
    jobs: JobRecord[]
}
