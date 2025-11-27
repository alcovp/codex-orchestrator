import { useEffect, useMemo, useRef, useState } from "react"
import type { DbShape, JobRecord, SubtaskRecord } from "./types"

type LoadState = "idle" | "loading" | "error" | "ready"

const statusColors: Record<string, string> = {
    planning: "#1f7ae0",
    running: "#f1a208",
    merging: "#7c3aed",
    done: "#0ea85a",
    failed: "#e11d48",
    needs_manual_review: "#f97316",
    pending: "#6b7280",
    completed: "#0ea85a",
}

function useDashboardData() {
    const [state, setState] = useState<LoadState>("idle")
    const [data, setData] = useState<DbShape>({ jobs: [] })
    const [error, setError] = useState<string | null>(null)
    const wsRef = useRef<WebSocket | null>(null)
    const retryRef = useRef<ReturnType<typeof setTimeout> | null>(null)
    const [reloadKey, setReloadKey] = useState(0)
    const [attempt, setAttempt] = useState(0)

    // Initial/full fetch
    useEffect(() => {
        const fetchData = async () => {
            setState("loading")
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
        fetchData()
    }, [reloadKey])

    // Live updates via WS (active job only)
    useEffect(() => {
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
                    setState((prev) => (prev === "idle" ? "ready" : prev))
                    setError(null)
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
        }

        return () => {
            if (retryRef.current) clearTimeout(retryRef.current)
            wsRef.current?.close()
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [attempt])

    const reload = () => setReloadKey((v) => v + 1)

    return { state, data, error, reload }
}

function StatusPill({ label }: { label: string }) {
    const color = statusColors[label] ?? "#4b5563"
    return (
        <span className="pill" style={{ background: color }}>
            {label}
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
    return (
        <div className="job-header">
            <div className="job-title">
                <div className="job-title-main">
                    <span className="job-id">#{job.jobId}</span>
                    <StatusPill label={job.status} />
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
                        <pre className="job-task-body">{taskText}</pre>
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
    return (
        <div className="node">
            <div className="node-status" style={{ background: color }} />
            <div className="node-body">
                <div className="node-title">
                    {subtask.id} <span className="node-label">{subtask.title}</span>
                </div>
                <div className="node-meta">
                    {subtask.branch && <span>Branch: {subtask.branch}</span>}
                    {subtask.worktree && <span>Worktree: {subtask.worktree}</span>}
                    {subtask.status === "completed" && subtask.finishedAt && (
                        <span>Finished: {new Date(subtask.finishedAt).toLocaleTimeString()}</span>
                    )}
                    {subtask.status === "failed" && subtask.error && (
                        <span className="danger">{subtask.error}</span>
                    )}
                </div>
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
    const [showGraph, setShowGraph] = useState(false)
    const [showArtifacts, setShowArtifacts] = useState(false)
    return (
        <div className="card">
            <JobHeader
                job={job}
                toggles={{
                    showGraph,
                    toggleGraph: () => setShowGraph((v) => !v),
                    showArtifacts,
                    toggleArtifacts: () => setShowArtifacts((v) => !v),
                }}
            />
            {showGraph && <Graph job={job} />}
            {showArtifacts && <Artifacts job={job} />}
        </div>
    )
}

function App() {
    const { data, error, state, reload } = useDashboardData()
    const jobs = data.jobs.slice().sort((a, b) => b.startedAt.localeCompare(a.startedAt))

    return (
        <div className="page">
            <header className="topbar">
                <div>
                    <div className="brand">Codex Orchestrator</div>
                    <div className="tagline">Live jobs, subtasks, and artifacts</div>
                </div>
                <div className="controls">
                    <button onClick={reload} className="ghost">
                        Refresh
                    </button>
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
