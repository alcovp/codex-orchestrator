import express from "express"
import path from "node:path"
import { existsSync } from "node:fs"
import { readDashboardData, resolveDbPath } from "./db/sqliteDb.js"

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

app.listen(PORT, () => {
    console.log(`[dashboard] Listening on http://localhost:${PORT}`)
    console.log(`[dashboard] Serving static files from ${distDir}`)
    console.log(`[dashboard] DB path ${dbPath}`)
})
