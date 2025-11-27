import express from "express"
import path from "node:path"
import { existsSync } from "node:fs"
import { WebSocketServer } from "ws"
import { readActiveJob, readDashboardData, resolveDbPath } from "./db/sqliteDb.js"

const PORT = Number(process.env.DASHBOARD_PORT || 4179)
const repoRoot = process.cwd()
const distDir = path.resolve(repoRoot, "web", "dist")
const dbPath = resolveDbPath()

const app = express()

app.use((req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*")
    res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS")
    res.setHeader("Access-Control-Allow-Headers", "Content-Type")
    if (req.method === "OPTIONS") {
        res.sendStatus(200)
        return
    }
    next()
})

app.get("/api/db", async (_req, res) => {
    try {
        if (!existsSync(dbPath)) {
            res.json({ jobs: [] })
            return
        }
        const data = readDashboardData()
        res.json(data)
    } catch (error: any) {
        res.status(500).json({ error: error?.message ?? "Failed to read DB" })
    }
})

if (existsSync(distDir)) {
    app.use(express.static(distDir, { maxAge: "1h", fallthrough: true }))
    app.get("*", async (_req, res) => {
        try {
            res.sendFile(path.join(distDir, "index.html"))
        } catch {
            res.status(404).send("Not found")
        }
    })
} else {
    app.get("*", (_req, res) => {
        res.status(200).send("Build assets not found. Run `yarn web:build`.")
    })
}

const server = app.listen(PORT, () => {
    console.log(`[dashboard] Listening on http://localhost:${PORT}`)
    console.log(`[dashboard] Serving static files from ${distDir}`)
    console.log(`[dashboard] DB path ${dbPath}`)
})

const wss = new WebSocketServer({ server, path: "/ws" })

function buildActiveJobPayload() {
    const job = readActiveJob()
    return JSON.stringify({ type: "active_job", job })
}

let lastPayload = ""
const broadcast = (data: string) => {
    wss.clients.forEach((client) => {
        if (client.readyState === client.OPEN) {
            client.send(data)
        }
    })
}

wss.on("connection", (socket) => {
    try {
        const initial = buildActiveJobPayload()
        socket.send(initial)
    } catch {
        // ignore send errors
    }
})

setInterval(() => {
    try {
        const payload = buildActiveJobPayload()
        if (payload !== lastPayload) {
            lastPayload = payload
            broadcast(payload)
        }
    } catch {
        // swallow polling errors
    }
}, 1000)
