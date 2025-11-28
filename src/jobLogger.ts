import path from "node:path"
import { mkdir, appendFile } from "node:fs/promises"

let jobLogPath: string | null = null
let jobLogReady = false
let jobLogVerbose = false

export function setJobLogPath(filePath: string | null, options?: { verbose?: boolean }) {
    jobLogPath = filePath ? path.resolve(filePath) : null
    jobLogReady = false
    jobLogVerbose = Boolean(options?.verbose)
}

export function getJobLogPath(): string | null {
    return jobLogPath
}

export function isJobLogVerbose(): boolean {
    return jobLogVerbose
}

async function ensureReady() {
    if (!jobLogPath) return
    if (jobLogReady) return
    const dir = path.dirname(jobLogPath)
    await mkdir(dir, { recursive: true })
    jobLogReady = true
}

export async function appendJobLog(line: string) {
    if (!jobLogPath) return
    await ensureReady()
    await appendFile(jobLogPath, line.endsWith("\n") ? line : `${line}\n`)
}
