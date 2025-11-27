import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

let loaded = false

/**
 * Load environment variables from the repo's .env once.
 * Existing process.env values are left intact.
 */
export function loadEnv(envFilePath?: string) {
    if (loaded) return

    const resolvedPath =
        envFilePath ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".env")

    loaded = true

    if (!fs.existsSync(resolvedPath)) {
        return
    }

    try {
        const content = fs.readFileSync(resolvedPath, "utf8")
        for (const line of content.split(/\r?\n/)) {
            const parsed = parseLine(line)
            if (!parsed) continue

            const { key, value } = parsed
            if (process.env[key] === undefined) {
                process.env[key] = value
            }
        }
    } catch (error) {
        console.warn(`[env] Failed to load ${resolvedPath}:`, error)
    }
}

function parseLine(line: string): { key: string; value: string } | null {
    const trimmed = line.trim()
    if (trimmed === "" || trimmed.startsWith("#")) {
        return null
    }

    const cleaned = trimmed.startsWith("export ") ? trimmed.slice(7).trim() : trimmed
    const eqIndex = cleaned.indexOf("=")
    if (eqIndex === -1) {
        return null
    }

    const key = cleaned.slice(0, eqIndex).trim()
    if (!key) {
        return null
    }

    const rawValue = cleaned.slice(eqIndex + 1).trim()
    const value = unwrap(stripInlineComment(rawValue))

    return { key, value }
}

function stripInlineComment(raw: string): string {
    if (raw.startsWith('"') || raw.startsWith("'")) {
        return raw
    }

    const hashIndex = raw.indexOf("#")
    return hashIndex === -1 ? raw : raw.slice(0, hashIndex).trimEnd()
}

function unwrap(raw: string): string {
    if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
        const withoutQuotes = raw.slice(1, -1)
        if (raw.startsWith('"')) {
            return withoutQuotes.replace(/\\n/g, "\n").replace(/\\r/g, "\r").replace(/\\t/g, "\t")
        }
        return withoutQuotes
    }

    return raw
}
