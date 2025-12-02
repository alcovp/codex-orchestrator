import { useEffect, useMemo, useRef, useState } from "react"
import type { DbShape, JobRecord, SubtaskRecord } from "./types"

type LoadState = "idle" | "loading" | "error" | "ready"
type StageStatus = "pending" | "running" | "completed" | "failed"

type StageNode = {
    id: string
    title: string
    status: StageStatus
    reasoning: string
    timestamp?: string
    colorKey?: string
    startedAt?: string
    finishedAt?: string
    elapsed?: string
}

const statusColors: Record<string, string> = {
    analyzing: "#0ea5e9", // cyan
    refactoring: "#8b5cf6", // violet
    planning: "#1f7ae0", // blue
    running: "#f59e0b", // amber
    merging: "#7c3aed", // purple
    done: "#10b981", // green
    failed: "#ef4444", // red
    needs_manual_review: "#f97316", // orange
    pending: "#6b7280", // gray
    completed: "#10b981", // green
}

function truncate(text: string, limit = 800) {
    if (!text) return ""
    return text.length > limit ? `${text.slice(0, limit)} …` : text
}

function statusOrder(status: JobRecord["status"]): number {
    switch (status) {
        case "analyzing":
            return 0
        case "refactoring":
            return 1
        case "planning":
            return 2
        case "running":
            return 3
        case "merging":
            return 4
        case "done":
        case "needs_manual_review":
        case "failed":
            return 5
        default:
            return 0
    }
}

function formatTime(ts?: string) {
    if (!ts) return null
    try {
        return new Date(ts).toLocaleTimeString()
    } catch {
        return null
    }
}

function elapsedMs(start?: string, end?: string) {
    if (!start) return null
    const s = new Date(start).getTime()
    const e = end ? new Date(end).getTime() : Date.now()
    const delta = e - s
    if (Number.isNaN(delta) || delta < 0) return null
    const minutes = Math.floor(delta / 60000)
    const seconds = Math.floor((delta % 60000) / 1000)
    return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`
}

function buildStageNodes(job: JobRecord): StageNode[] {
    const artifacts = job.artifacts ?? []
    const progress = statusOrder(job.status)

    const getLatestArtifact = (type: string) => {
        const filtered = artifacts.filter((a) => a.type === type)
        if (filtered.length === 0) return undefined
        return filtered.reduce((latest, current) =>
            new Date(current.createdAt).getTime() > new Date(latest.createdAt).getTime()
                ? current
                : latest,
        )
    }
    const getStageArtifacts = (types: string[]) =>
        artifacts
            .filter((a) => types.includes(a.type))
            .sort((a, b) => a.createdAt.localeCompare(b.createdAt))

    const calcTiming = (types: string[], finalTypes: string[]) => {
        const list = getStageArtifacts(types)
        const startedAt = list[0]?.createdAt
        const final = list
            .filter((a) => finalTypes.includes(a.type))
            .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        const finishedAt = final[final.length - 1]?.createdAt
        const elapsed = elapsedMs(startedAt, finishedAt) ?? undefined
        return { startedAt, finishedAt, elapsed }
    }

    const analysisArtifact = getLatestArtifact("analysis")
    const analysisProgress = getLatestArtifact("analysis_progress")
    const refactorArtifact = getLatestArtifact("refactor")
    const refactorProgress = getLatestArtifact("refactor_progress")
    const timingAnalysis = calcTiming(["analysis_progress", "analysis"], ["analysis"])
    const timingRefactor = calcTiming(["refactor_progress", "refactor"], ["refactor"])
    const mergeResultArt = getLatestArtifact("merge_result")
    const mergeInputArt = getLatestArtifact("merge_input")
    const mergeProgressArt = getLatestArtifact("merge_progress")
    const timingMerge = calcTiming(
        ["merge_progress", "merge_input", "merge_result"],
        ["merge_result"],
    )
    const planProgress = getLatestArtifact("plan_progress")
    const planArtifact = getLatestArtifact("plan")
    const timingPlan = calcTiming(["plan_progress", "plan"], ["plan"])

    const stages: Array<{
        id: string
        title: string
        idx: number
        finalArtifact?: { data: any; createdAt?: string }
        progressArtifact?: { data: any; createdAt?: string }
        reasoningBuilder: (data: any) => string | null
        fallback: string
        timing?: { startedAt?: string; finishedAt?: string; elapsed?: string }
    }> = [
        {
            id: "analysis",
            title: "Analysis",
            idx: 0,
            finalArtifact: analysisArtifact
                ? { data: analysisArtifact.data, createdAt: analysisArtifact.createdAt }
                : undefined,
            progressArtifact: analysisProgress
                ? { data: analysisProgress.data, createdAt: analysisProgress.createdAt }
                : undefined,
            reasoningBuilder: (data: any) => {
                if (!data) return null
                if (typeof data.message === "string" && data.message.trim()) {
                    return data.message
                }
                if (typeof data === "string") return data
                const parts: string[] = []
                if (Array.isArray(data?.reasons) && data.reasons.length) {
                    parts.push(`Reasons: ${data.reasons.join(" | ")}`)
                }
                if (Array.isArray(data?.focus_areas) && data.focus_areas.length) {
                    const focus = data.focus_areas
                        .slice(0, 2)
                        .map((f: any) => `${f.path}: ${f.suggested_split || f.why}`)
                        .join(" | ")
                    if (focus) parts.push(`Focus: ${focus}${data.focus_areas.length > 2 ? " …" : ""}`)
                }
                if (data?.notes) parts.push(`Notes: ${data.notes}`)
                return parts.join("\n") || truncate(JSON.stringify(data, null, 2))
            },
            fallback: "Waiting for analysis output",
            timing: timingAnalysis,
        },
        {
            id: "refactor",
            title: "Refactor",
            idx: 1,
            finalArtifact: refactorArtifact
                ? { data: refactorArtifact.data, createdAt: refactorArtifact.createdAt }
                : undefined,
            progressArtifact: refactorProgress
                ? { data: refactorProgress.data, createdAt: refactorProgress.createdAt }
                : undefined,
            reasoningBuilder: (data: any) => {
                if (!data) return null
                if (typeof data.message === "string" && data.message.trim()) {
                    return data.message
                }
                const parts: string[] = []
                if (data.status) parts.push(`Status: ${data.status}`)
                if (data.branch) parts.push(`Branch: ${data.branch}`)
                if (data.notes) parts.push(`Notes: ${data.notes}`)
                if (Array.isArray(data.touched_files) && data.touched_files.length) {
                    parts.push(`Touched: ${data.touched_files.slice(0, 5).join(", ")}`)
                }
                return parts.join("\n") || truncate(JSON.stringify(data, null, 2))
            },
            fallback: "Refactor stage pending or skipped",
            timing: timingRefactor,
        },
        {
            id: "plan",
            title: "Plan",
            idx: 2,
            finalArtifact: planArtifact
                ? { data: planArtifact.data, createdAt: planArtifact.createdAt }
                : undefined,
            progressArtifact: planProgress
                ? { data: planProgress.data, createdAt: planProgress.createdAt }
                : undefined,
            reasoningBuilder: (data: any) => {
                if (!data) return null
                if (typeof data.message === "string" && data.message.trim()) {
                    return data.message
                }
                const total = Array.isArray(data?.subtasks) ? data.subtasks.length : 0
                const titles =
                    total > 0
                        ? data.subtasks
                              .slice(0, 4)
                              .map((s: any) => s.title || s.id)
                              .join(" | ")
                        : null
                const parts = [
                    `Subtasks: ${total}`,
                    `Parallel: ${data?.can_parallelize ? "yes" : "no"}`,
                ]
                if (titles) parts.push(`Items: ${titles}${total > 4 ? " …" : ""}`)
                return parts.join("\n")
            },
            fallback: "Waiting for planner",
            timing: timingPlan,
        },
        {
            id: "merge",
            title: "Merge",
            idx: 4,
            finalArtifact: mergeResultArt
                ? { data: mergeResultArt.data, createdAt: mergeResultArt.createdAt }
                : undefined,
            progressArtifact: mergeProgressArt
                ? { data: mergeProgressArt.data, createdAt: mergeProgressArt.createdAt }
                : mergeInputArt
                  ? { data: mergeInputArt.data, createdAt: mergeInputArt.createdAt }
                  : undefined,
            reasoningBuilder: (data: any) => {
                if (!data) return null
                if (data.subtasks_results && Array.isArray(data.subtasks_results)) {
                    const total = data.subtasks_results.length
                    const branches = data.subtasks_results
                        .map((r: any) => r.branch || r.subtask_id || "")
                        .filter(Boolean)
                        .slice(0, 5)
                        .join(", ")
                    return `Merge input: ${total} branches${branches ? ` (${branches}${total > 5 ? " …" : ""})` : ""}`
                }
                if (typeof data.last_reasoning === "string" && data.last_reasoning.trim()) {
                    return data.last_reasoning
                }
                if (typeof data.message === "string" && data.message.trim()) {
                    return data.message
                }
                const parts: string[] = []
                if (data.status) parts.push(`Status: ${data.status}`)
                if (data.notes) parts.push(data.notes)
                if (Array.isArray(data.touched_files) && data.touched_files.length) {
                    parts.push(`Files: ${data.touched_files.slice(0, 5).join(", ")}`)
                }
                return parts.join("\n") || truncate(JSON.stringify(data, null, 2))
            },
            fallback: job.status === "merging" ? "Merging in progress…" : "Waiting for merge",
            timing: timingMerge,
        },
    ]

    return stages.map((stage) => {
        const hasFinal = Boolean(stage.finalArtifact)
        const hasProgressArtifact = Boolean(stage.progressArtifact)
        const isCurrentStage = progress === stage.idx
        const status: StageStatus = hasFinal
            ? "completed"
            : hasProgressArtifact
              ? "running"
              : progress < stage.idx
                ? "pending"
                : isCurrentStage
                  ? "running"
                  : "completed"
        let colorKey: string | undefined
        if (stage.id === "merge" && status === "running") colorKey = "merging"
        if (stage.id === "plan" && status === "running") colorKey = "planning"
        if (stage.id === "refactor" && status === "running")
            colorKey = "refactoring"
        if (stage.id === "analysis" && status === "running")
            colorKey = "analyzing"
        const reasoning =
            stage.reasoningBuilder(stage.progressArtifact?.data ?? stage.finalArtifact?.data) ??
            stage.fallback ??
            (status === "pending" ? "Waiting…" : stage.id === "merge" ? "Merging in progress…" : "Working…")
        return {
            id: stage.id,
            title: stage.title,
            status,
            colorKey,
            reasoning: truncate(reasoning || stage.fallback, 900),
            timestamp: stage.progressArtifact?.createdAt ?? stage.finalArtifact?.createdAt,
            startedAt: stage.timing?.startedAt,
            finishedAt: stage.timing?.finishedAt,
            elapsed: stage.timing?.elapsed,
        }
    })
}

function useDashboardData() {
    const [state, setState] = useState<LoadState>("idle")
    const [data, setData] = useState<DbShape>({ jobs: [] })
    const [error, setError] = useState<string | null>(null)
    const wsRef = useRef<WebSocket | null>(null)
    const retryRef = useRef<ReturnType<typeof setTimeout> | null>(null)
    const [reloadKey, setReloadKey] = useState(0)
    const [attempt, setAttempt] = useState(0)

    const fetchData = async () => {
        setState((prev) => (prev === "ready" ? prev : "loading"))
        setError(null)
        try {
            const res = await fetch("/api/db")
            if (!res.ok) throw new Error(`HTTP ${res.status}`)
            const json = (await res.json()) as DbShape
            setData(json)
            setState("ready")
        } catch (err: any) {
            setError(err?.message ?? "Failed to load data")
            setState("error")
        }
    }

    // Initial/full fetch
    useEffect(() => {
        fetchData()
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [reloadKey])

    // Live updates via WS (active job only)
    useEffect(() => {
        const safeClose = () => {
            const ws = wsRef.current
            if (!ws) return
            ws.onclose = null
            ws.onerror = null
            ws.onmessage = null
            if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
                try {
                    ws.close()
                } catch {
                    /* ignore */
                }
            }
            wsRef.current = null
        }

        const url =
            (location.protocol === "https:" ? "wss://" : "ws://") +
            location.host +
            "/ws"

        const ws = new WebSocket(url)
        wsRef.current = ws

        ws.onmessage = (event) => {
            try {
                const payload = JSON.parse(event.data)
                if (payload.type === "active_job") {
                    const job = payload.job as JobRecord | null
                    setData((prev) => {
                        const others = prev.jobs.filter((j) => j.jobId !== job?.jobId)
                        return job ? { jobs: [...others, job] } : { jobs: others }
                    })
                    const isTerminal =
                        !job ||
                        job.status === "done" ||
                        job.status === "failed" ||
                        job.status === "needs_manual_review"
                    if (isTerminal) {
                        // refresh full list to get final status/artifacts
                        fetchData()
                    } else {
                        setState((prev) => (prev === "idle" ? "ready" : prev))
                        setError(null)
                    }
                }
            } catch (err: any) {
                setError(err?.message ?? "Failed to parse WS message")
            }
        }

        ws.onerror = () => {
            setError("WebSocket error")
        }

        ws.onclose = () => {
            if (retryRef.current) clearTimeout(retryRef.current)
            retryRef.current = setTimeout(() => {
                setAttempt((v) => v + 1)
            }, 1500)
            wsRef.current = null
        }

        return () => {
            if (retryRef.current) clearTimeout(retryRef.current)
            safeClose()
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [attempt])

    const reload = () => setReloadKey((v) => v + 1)

    return { state, data, error, reload }
}

function StatusPill({ label, detail }: { label: string; detail?: string }) {
    const color = statusColors[label] ?? "#4b5563"
    const text = detail ? `${label} ${detail}` : label
    return (
        <span className="pill" style={{ background: color }}>
            {text}
        </span>
    )
}

function JobHeader({
    job,
    toggles,
}: {
    job: JobRecord
    toggles: {
        showGraph: boolean
        toggleGraph: () => void
        showArtifacts: boolean
        toggleArtifacts: () => void
    }
}) {
    const taskText = job.taskDescription || job.userTask || "(no task description)"
    const [taskExpanded, setTaskExpanded] = useState(false)
    const totalSubtasks = job.plan?.subtasks?.length || job.subtasks.length
    const completedSubtasks = job.subtasks.filter((s) => s.status === "completed").length
    const progress =
        job.status === "running" && totalSubtasks > 0
            ? `${completedSubtasks}/${totalSubtasks}`
            : undefined
    return (
        <div className="job-header">
            <div className="job-title">
                <div className="job-title-main">
                    <span className="job-id">#{job.jobId}</span>
                    <StatusPill label={job.status} detail={progress} />
                </div>
                <div className="job-controls">
                    <button className="ghost small" onClick={toggles.toggleGraph}>
                        {toggles.showGraph ? "Hide graph" : "Show graph"}
                    </button>
                    <button className="ghost small" onClick={toggles.toggleArtifacts}>
                        {toggles.showArtifacts ? "Hide artifacts" : "Show artifacts"}
                    </button>
                </div>
            </div>
            <div className="job-meta">
                <div className="job-row">
                    <div className="job-task">
                        <pre
                            className={`job-task-body ${taskExpanded ? "expanded" : "collapsed"}`}
                            onClick={() => setTaskExpanded((v) => !v)}
                            role="button"
                            tabIndex={0}
                        >
                            {taskText}
                        </pre>
                    </div>
                </div>
                <div className="meta-grid">
                    <span>Repo: {job.repoRoot}</span>
                    <span>Base: {job.baseBranch}</span>
                    <span>Push result: {job.pushResult ? "yes" : "no"}</span>
                    <span>Started: {new Date(job.startedAt).toLocaleString()}</span>
                    <span>Updated: {new Date(job.updatedAt).toLocaleString()}</span>
                </div>
            </div>
        </div>
    )
}

function SubtaskNode({ subtask }: { subtask: SubtaskRecord }) {
    const color = statusColors[subtask.status] ?? "#4b5563"
    const [showMeta, setShowMeta] = useState(false)
    const started = formatTime(subtask.startedAt)
    const finished = formatTime(subtask.finishedAt)
    const duration =
        subtask.status === "running" || subtask.status === "pending"
            ? elapsedMs(subtask.startedAt)
            : null

    return (
        <div className="node">
            <div className="node-status" style={{ background: color }} />
            <div className="node-body">
                <div className="node-title">
                    {subtask.id} <span className="node-label">{subtask.title}</span>
                </div>
                <div className="node-meta">
                    {started && <span>Started: {started}</span>}
                    {duration && <span>Elapsed: {duration}</span>}
                    {subtask.status === "failed" && subtask.error && (
                        <span className="danger">{subtask.error}</span>
                    )}
                    {finished && <span>Finished: {finished}</span>}
                    <button className="ghost tiny" onClick={() => setShowMeta((v) => !v)}>
                        {showMeta ? "Hide meta" : "Show meta"}
                    </button>
                </div>
                {showMeta && (
                    <div className="node-meta-detail">
                        {subtask.branch && <span>Branch: {subtask.branch}</span>}
                        {subtask.worktree && <span>Worktree: {subtask.worktree}</span>}
                    </div>
                )}
                {subtask.summary && <div className="node-summary">{subtask.summary}</div>}
                {!subtask.summary && subtask.last_reasoning && (
                    <div className="node-reasoning">
                        <div className="node-reasoning-label">Thoughts</div>
                        <pre className="node-reasoning-body" key={subtask.last_reasoning}>
                            {subtask.last_reasoning}
                        </pre>
                    </div>
                )}
            </div>
        </div>
    )
}

function StageNodeView({ stage }: { stage: StageNode }) {
    const color = statusColors[stage.colorKey || stage.status] ?? "#4b5563"
    const showReasoning = stage.status !== "completed" && Boolean(stage.reasoning)
    const started = formatTime(stage.startedAt)
    const finished = formatTime(stage.finishedAt)
    const elapsed = stage.elapsed
    return (
        <div className="node">
            <div className="node-status" style={{ background: color }} />
            <div className="node-body">
                <div className="node-title">
                    {stage.title} <span className="node-label">{stage.status}</span>
                </div>
                <div className="node-meta">
                    {started && <span>Started: {started}</span>}
                    {elapsed && <span>Elapsed: {elapsed}</span>}
                    {finished && <span>Finished: {finished}</span>}
                </div>
                {showReasoning && (
                    <div className="node-reasoning">
                        <div className="node-reasoning-label">last_reasoning</div>
                        <pre className="node-reasoning-body" key={stage.reasoning}>
                            {stage.reasoning}
                        </pre>
                    </div>
                )}
            </div>
        </div>
    )
}

function Graph({ job }: { job: JobRecord }) {
    const lanes = useMemo(() => {
        const planSubtasks = job.plan?.subtasks ?? []
        if (planSubtasks.length === 0) return []

        const order = planSubtasks.map((p, idx) => ({
            ...p,
            order: idx,
        }))

        const grouped: Record<string, { label: string; items: SubtaskRecord[] }> = {}
        order.forEach((item, idx) => {
            const key = job.plan?.can_parallelize
                ? item.parallel_group || `seq-${idx}`
                : `seq-${idx}`
            if (!grouped[key]) {
                const isParallel = job.plan?.can_parallelize && !!item.parallel_group
                grouped[key] = {
                    label: isParallel ? `Parallel ${item.parallel_group}` : `Step ${idx + 1}`,
                    items: [],
                }
            }
            const subtask = job.subtasks.find((s) => s.id === item.id) ?? {
                id: item.id,
                title: item.title,
                status: "pending",
                updatedAt: new Date().toISOString(),
            }
            grouped[key].items.push(subtask as SubtaskRecord)
        })

        return Object.entries(grouped).map(([key, value]) => ({ key, ...value }))
    }, [job])

    if (lanes.length === 0) return null

    return (
        <div className="graph">
            {lanes.map((lane, idx) => (
                <div className="lane" key={lane.key}>
                    <div className="lane-header">
                        <span>{lane.label}</span>
                        {idx < lanes.length - 1 && <div className="lane-connector" />}
                    </div>
                    <div className="lane-nodes">
                        {lane.items.map((s) => (
                            <SubtaskNode key={s.id} subtask={s} />
                        ))}
                    </div>
                </div>
            ))}
        </div>
    )
}

function Artifacts({ job }: { job: JobRecord }) {
    if (!job.artifacts?.length) return null
    return (
        <div className="artifacts">
            <div className="section-title">Artifacts</div>
            <div className="artifact-grid">
                {job.artifacts
                    .slice()
                    .reverse()
                    .map((art) => (
                        <ArtifactCard key={art.id} art={art} />
                    ))}
            </div>
        </div>
    )
}

function ArtifactCard({ art }: { art: JobRecord["artifacts"][number] }) {
    const [open, setOpen] = useState(false)
    return (
        <div className="artifact-card">
            <div className="artifact-meta">
                <span>{art.type}</span>
                {art.label && <span className="muted">{art.label}</span>}
            </div>
            <div className="artifact-time">{new Date(art.createdAt).toLocaleString()}</div>
            <button className="ghost small" onClick={() => setOpen((v) => !v)}>
                {open ? "Hide data" : "Show data"}
            </button>
            {open && <pre className="artifact-body">{JSON.stringify(art.data, null, 2)}</pre>}
        </div>
    )
}

function JobCard({ job }: { job: JobRecord }) {
    const stageNodes = useMemo(() => buildStageNodes(job), [job])
    const preMergeStages = stageNodes.filter((s) => s.id !== "merge")
    const mergeStage = stageNodes.find((s) => s.id === "merge")
    const [showGraph, setShowGraph] = useState(job.status === "running")
    const [showArtifacts, setShowArtifacts] = useState(false)
    const [manualGraphToggle, setManualGraphToggle] = useState(false)

    useEffect(() => {
        if (job.status === "running" && !showGraph && !manualGraphToggle) {
            setShowGraph(true)
        }
    }, [job.status, showGraph, manualGraphToggle])

    const handleToggleGraph = () => {
        setManualGraphToggle(true)
        setShowGraph((v) => !v)
    }
    return (
        <div className="card">
            <JobHeader
                job={job}
                toggles={{
                    showGraph,
                    toggleGraph: handleToggleGraph,
                    showArtifacts,
                    toggleArtifacts: () => setShowArtifacts((v) => !v),
                }}
            />
            {showGraph && (
                <>
                    {preMergeStages.length > 0 && (
                        <div className="stages">
                            {preMergeStages.map((stage) => (
                                <StageNodeView key={stage.id} stage={stage} />
                            ))}
                        </div>
                    )}
                    <Graph job={job} />
                    {mergeStage && (
                        <div className="stages">
                            <StageNodeView key={mergeStage.id} stage={mergeStage} />
                        </div>
                    )}
                </>
            )}
            {showArtifacts && <Artifacts job={job} />}
        </div>
    )
}

function App() {
    const { data, error, state } = useDashboardData()
    const jobs = data.jobs.slice().sort((a, b) => b.startedAt.localeCompare(a.startedAt))

    return (
        <div className="page">
            <header className="topbar">
                <div>
                    <div className="brand">Codex Orchestrator</div>
                </div>
                <div className="controls">
                    <span className={`state ${state}`}>{state}</span>
                </div>
            </header>

            {error && <div className="error">Ошибка: {error}</div>}
            {!error && jobs.length === 0 && (
                <div className="empty">Нет данных. Запустите оркестратор.</div>
            )}

            <div className="jobs">
                {jobs.map((job) => (
                    <JobCard key={job.jobId} job={job} />
                ))}
            </div>
        </div>
    )
}

export default App
