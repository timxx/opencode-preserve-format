import type { Plugin } from "@opencode-ai/plugin"
import fs from "fs"
import path from "path"

// ─── Types ───────────────────────────────────────────────────────────────────

export type LineEnding = "lf" | "crlf"
export type Encoding = "utf8" | "utf16le" | "utf16be"
export type BomInfo = { bom: Buffer | null; encoding: Encoding }
export type FileFormat = { bom: Buffer | null; ending: LineEnding; encoding: Encoding }

// ─── Binary extension guard ───────────────────────────────────────────────────

const BINARY = new Set([
    ".exe", ".dll", ".bin", ".so", ".dylib", ".o", ".a", ".lib",
    ".zip", ".tar", ".gz", ".bz2", ".7z", ".rar", ".xz",
    ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp", ".ico",
    ".tif", ".tiff", ".avif", ".heic", ".svg",
    ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
    ".woff", ".woff2", ".ttf", ".otf", ".eot",
    ".mp3", ".mp4", ".wav", ".avi", ".mov", ".mkv", ".webm",
    ".flac", ".ogg", ".aac",
    ".sqlite", ".db", ".wasm",
])

export function isBinary(file: string): boolean {
    return BINARY.has(path.extname(file).toLowerCase())
}

// ─── BOM detection ────────────────────────────────────────────────────────────

export function detectBom(buf: Buffer): BomInfo {
    if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
        return { bom: buf.subarray(0, 3), encoding: "utf8" }
    }
    if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
        return { bom: buf.subarray(0, 2), encoding: "utf16le" }
    }
    if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
        return { bom: buf.subarray(0, 2), encoding: "utf16be" }
    }
    return { bom: null, encoding: "utf8" }
}

// ─── Line ending detection ────────────────────────────────────────────────────

export function detectEnding(text: string): LineEnding {
    let crlf = 0
    let lf = 0
    for (let i = 0; i < text.length; i++) {
        if (text[i] === "\r" && text[i + 1] === "\n") {
            crlf++
            i++ // skip the \n
        } else if (text[i] === "\n") {
            lf++
        }
        if (crlf + lf >= 1000) break
    }
    if (crlf === 0 && lf === 0) return "lf"
    return crlf >= lf ? "crlf" : "lf"
}

// ─── Encoding / decoding ──────────────────────────────────────────────────────

export function decodeText(buf: Buffer, encoding: Encoding): string {
    if (encoding === "utf16le") return buf.toString("utf16le")
    if (encoding === "utf16be") {
        // Node has no native utf16be; swap bytes then decode as utf16le
        const swapped = Buffer.allocUnsafe(buf.length)
        for (let i = 0; i < buf.length - 1; i += 2) {
            swapped[i] = buf[i + 1]
            swapped[i + 1] = buf[i]
        }
        return swapped.toString("utf16le")
    }
    return buf.toString("utf8")
}

export function encodeText(text: string, encoding: Encoding): Buffer {
    if (encoding === "utf16le") return Buffer.from(text, "utf16le")
    if (encoding === "utf16be") {
        const le = Buffer.from(text, "utf16le")
        const swapped = Buffer.allocUnsafe(le.length)
        for (let i = 0; i < le.length - 1; i += 2) {
            swapped[i] = le[i + 1]
            swapped[i + 1] = le[i]
        }
        return swapped
    }
    return Buffer.from(text, "utf8")
}

// ─── Line ending conversion ───────────────────────────────────────────────────

export function convertEnding(text: string, ending: LineEnding): string {
    // Normalize all CRLF → LF first, then re-add CRLF if needed
    const lf = text.replaceAll("\r\n", "\n")
    if (ending === "crlf") return lf.replaceAll("\n", "\r\n")
    return lf
}

// ─── Full format pipeline ─────────────────────────────────────────────────────

export function applyFormat(buf: Buffer, format: FileFormat): Buffer {
    const { bom, ending, encoding } = format
    const bomLen = bom ? bom.length : 0
    const body = buf.subarray(bomLen)
    const text = decodeText(body, encoding)
    const converted = convertEnding(text, ending)
    const newBody = encodeText(converted, encoding)

    // Check if anything actually changed
    const newBuf = bom ? Buffer.concat([bom, newBody]) : newBody
    if (newBuf.equals(buf)) return buf
    return newBuf
}

// ─── File format reader ───────────────────────────────────────────────────────

export async function readFileFormat(file: string): Promise<FileFormat> {
    const buf = (await fs.promises.readFile(file)) as Buffer
    const { bom, encoding } = detectBom(buf)
    const bomLen = bom ? bom.length : 0
    const text = decodeText(buf.subarray(bomLen), encoding)
    const ending = detectEnding(text)
    return { bom, ending, encoding }
}

// ─── Plugin ───────────────────────────────────────────────────────────────────

const SERVICE = "preserve-format"

const PreserveFormatPlugin: Plugin = async (ctx) => {
    const cache = new Map<string, FileFormat>()

    const log = (level: "debug" | "info" | "warn" | "error", message: string, extra?: Record<string, unknown>) =>
        ctx.client.app.log({ body: { service: SERVICE, level, message, extra } })

    function abs(file: string): string {
        return path.resolve(ctx.directory, file)
    }

    async function getFormat(file: string): Promise<FileFormat | null> {
        const cached = cache.get(file)
        if (cached) return cached
        try {
            const fmt = await readFileFormat(file)
            cache.set(file, fmt)
            return fmt
        } catch (err) {
            await log("warn", `could not read format`, { file, err: String(err) })
            return null
        }
    }

    async function fileExists(file: string): Promise<boolean> {
        try {
            await fs.promises.access(file)
            return true
        } catch {
            return false
        }
    }

    await log("info", "plugin loaded")

    return {
        "tool.execute.before": async (input, output) => {
            await log("info", `tool: ${input.tool}`, { filePath: output.args?.filePath })

            if (input.tool === "apply_patch") {
                // patchText contains file paths as "*** Update File: <path>" / "*** Add File: <path>"
                const patchText: string = output.args?.patchText ?? ""
                const filePathRe = /^\*{3} (?:Update|Add) File: (.+)$/gm
                let m: RegExpExecArray | null
                while ((m = filePathRe.exec(patchText)) !== null) {
                    const file = abs(m[1].trim())
                    await getFormat(file) // reads and caches; file.edited will apply it
                }
                return
            }

            if (input.tool === "write") {
                if (!output.args.filePath || typeof output.args.content !== "string") return
                const file = abs(output.args.filePath)
                if (isBinary(file)) return

                let fmt: FileFormat
                if (await fileExists(file)) {
                    const detected = await getFormat(file)
                    if (!detected) return
                    fmt = detected
                } else {
                    // New file: detect from the AI-generated content
                    const ending = detectEnding(output.args.content)
                    fmt = { bom: null, ending, encoding: "utf8" }
                    cache.set(file, fmt)
                }

                output.args.content = convertEnding(output.args.content, fmt.ending)
                await log("debug", `write -> ${fmt.ending}`, { file: output.args.filePath })
            }

            if (input.tool === "edit") {
                if (!output.args.filePath) return
                const file = abs(output.args.filePath)
                if (isBinary(file)) return
                const fmt = await getFormat(file)
                if (!fmt) return
                if (typeof output.args.oldString === "string")
                    output.args.oldString = convertEnding(output.args.oldString, fmt.ending)
                if (typeof output.args.newString === "string")
                    output.args.newString = convertEnding(output.args.newString, fmt.ending)
                await log("debug", `edit -> ${fmt.ending}`, { file: output.args.filePath })
            }

            if (input.tool === "multiedit") {
                if (!output.args.filePath || !Array.isArray(output.args.edits)) return
                const file = abs(output.args.filePath)
                if (isBinary(file)) return
                const fmt = await getFormat(file)
                if (!fmt) return
                for (const edit of output.args.edits) {
                    if (typeof edit.oldString === "string")
                        edit.oldString = convertEnding(edit.oldString, fmt.ending)
                    if (typeof edit.newString === "string")
                        edit.newString = convertEnding(edit.newString, fmt.ending)
                }
                await log("debug", `multiedit -> ${fmt.ending}`, { file: output.args.filePath, count: output.args.edits.length })
            }
        },

        event: async ({ event }) => {
            if (event.type !== "file.edited") return
            const file = abs(event.properties.file)
            if (!file || isBinary(file)) return

            await log("info", `file.edited: ${file}`)
            const fmt = cache.get(file)
            cache.delete(file)
            if (!fmt) return

            try {
                const buf = (await fs.promises.readFile(file)) as Buffer
                const result = applyFormat(buf, fmt)
                if (result !== buf) {
                    await fs.promises.writeFile(file, result)
                    await log("debug", `normalized file`, { file })
                }
            } catch (err) {
                await log("warn", `could not normalize file`, { file, err: String(err) })
            }
        },
    }
}

export default { id: "preserve-format", server: PreserveFormatPlugin }
