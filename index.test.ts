import { describe, it, expect, vi } from "vitest"
import path from "path"
import { detectBom, detectEnding, decodeText, encodeText, convertEnding, applyFormat, readFileFormat, isBinary } from "./index.ts"
import type { FileFormat } from "./index.ts"
import fs from "fs"

// ─── detectBom ───────────────────────────────────────────────────────────────

describe("detectBom", () => {
    it("returns null bom and utf8 when no BOM", () => {
        const buf = Buffer.from("hello world", "utf8")
        const result = detectBom(buf)
        expect(result.bom).toBeNull()
        expect(result.encoding).toBe("utf8")
    })

    it("detects UTF-8 BOM (EF BB BF)", () => {
        const buf = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("hello", "utf8")])
        const result = detectBom(buf)
        expect(result.bom).toEqual(Buffer.from([0xef, 0xbb, 0xbf]))
        expect(result.encoding).toBe("utf8")
    })

    it("detects UTF-16 LE BOM (FF FE)", () => {
        const buf = Buffer.from([0xff, 0xfe, 0x68, 0x00])
        const result = detectBom(buf)
        expect(result.bom).toEqual(Buffer.from([0xff, 0xfe]))
        expect(result.encoding).toBe("utf16le")
    })

    it("detects UTF-16 BE BOM (FE FF)", () => {
        const buf = Buffer.from([0xfe, 0xff, 0x00, 0x68])
        const result = detectBom(buf)
        expect(result.bom).toEqual(Buffer.from([0xfe, 0xff]))
        expect(result.encoding).toBe("utf16be")
    })
})

// ─── detectEnding ─────────────────────────────────────────────────────────────

describe("detectEnding", () => {
    it("returns crlf when all newlines are CRLF", () => {
        expect(detectEnding("a\r\nb\r\nc")).toBe("crlf")
    })

    it("returns lf when all newlines are LF", () => {
        expect(detectEnding("a\nb\nc")).toBe("lf")
    })

    it("returns crlf when CRLF is dominant", () => {
        // 3 CRLF, 1 LF
        expect(detectEnding("a\r\nb\r\nc\r\nd\ne")).toBe("crlf")
    })

    it("returns lf when LF is dominant", () => {
        // 1 CRLF, 3 LF
        expect(detectEnding("a\r\nb\nc\nd\ne")).toBe("lf")
    })

    it("returns crlf on equal count (tie-break)", () => {
        // 2 CRLF, 2 LF
        expect(detectEnding("a\r\nb\r\nc\nd\ne")).toBe("crlf")
    })

    it("returns lf when no newlines present", () => {
        expect(detectEnding("no newlines here")).toBe("lf")
    })
})

// ─── convertEnding ────────────────────────────────────────────────────────────

describe("convertEnding", () => {
    it("converts LF to CRLF without double-converting existing CRLF", () => {
        const result = convertEnding("a\r\nb\nc", "crlf")
        expect(result).toBe("a\r\nb\r\nc")
    })

    it("converts CRLF to LF", () => {
        const result = convertEnding("a\r\nb\r\nc", "lf")
        expect(result).toBe("a\nb\nc")
    })

    it("is a no-op when ending already matches (LF)", () => {
        const input = "a\nb\nc"
        expect(convertEnding(input, "lf")).toBe(input)
    })

    it("is a no-op when ending already matches (CRLF)", () => {
        const input = "a\r\nb\r\nc"
        expect(convertEnding(input, "crlf")).toBe(input)
    })
})

// ─── decodeText / encodeText ──────────────────────────────────────────────────

describe("decodeText and encodeText round-trip", () => {
    it("round-trips UTF-8 text", () => {
        const original = "hello\nworld"
        const buf = encodeText(original, "utf8")
        expect(decodeText(buf, "utf8")).toBe(original)
    })

    it("round-trips UTF-16 LE text", () => {
        const original = "hello\r\nworld"
        const buf = encodeText(original, "utf16le")
        expect(decodeText(buf, "utf16le")).toBe(original)
    })

    it("round-trips UTF-16 BE text", () => {
        const original = "hello\r\nworld"
        const buf = encodeText(original, "utf16be")
        expect(decodeText(buf, "utf16be")).toBe(original)
    })
})

// ─── applyFormat ─────────────────────────────────────────────────────────────

describe("applyFormat", () => {
    it("preserves UTF-8 BOM and normalizes to CRLF", () => {
        const bom = Buffer.from([0xef, 0xbb, 0xbf])
        const body = Buffer.from("a\nb\nc", "utf8")
        const input = Buffer.concat([bom, body])
        const format: FileFormat = { bom, ending: "crlf", encoding: "utf8" }
        const result = applyFormat(input, format)
        // First 3 bytes are BOM
        expect(result.subarray(0, 3)).toEqual(bom)
        // Rest decodes to CRLF text
        expect(result.subarray(3).toString("utf8")).toBe("a\r\nb\r\nc")
    })

    it("preserves UTF-16 LE BOM and encoding", () => {
        const bom = Buffer.from([0xff, 0xfe])
        const body = encodeText("a\nb", "utf16le")
        const input = Buffer.concat([bom, body])
        const format: FileFormat = { bom, ending: "crlf", encoding: "utf16le" }
        const result = applyFormat(input, format)
        expect(result.subarray(0, 2)).toEqual(bom)
        expect(decodeText(result.subarray(2), "utf16le")).toBe("a\r\nb")
    })

    it("returns the same buffer reference when content is already correct", () => {
        const bom = Buffer.from([0xef, 0xbb, 0xbf])
        const body = Buffer.from("a\r\nb\r\nc", "utf8")
        const input = Buffer.concat([bom, body])
        const format: FileFormat = { bom, ending: "crlf", encoding: "utf8" }
        const result = applyFormat(input, format)
        expect(result).toBe(input)
    })
})

// ─── isBinary ─────────────────────────────────────────────────────────────────

describe("isBinary", () => {
    it("returns true for known binary extensions", () => {
        expect(isBinary("image.png")).toBe(true)
        expect(isBinary("archive.zip")).toBe(true)
        expect(isBinary("program.exe")).toBe(true)
    })

    it("returns false for text files", () => {
        expect(isBinary("script.ts")).toBe(false)
        expect(isBinary("README.md")).toBe(false)
        expect(isBinary("data.json")).toBe(false)
    })
})

// ─── readFileFormat ───────────────────────────────────────────────────────────

describe("readFileFormat", () => {
    it("detects UTF-8 file with CRLF endings and no BOM", async () => {
        const content = Buffer.from("a\r\nb\r\nc", "utf8")
        vi.spyOn(fs.promises, "readFile").mockResolvedValueOnce(content as any)
        const result = await readFileFormat("/some/file.txt")
        expect(result.bom).toBeNull()
        expect(result.encoding).toBe("utf8")
        expect(result.ending).toBe("crlf")
        vi.restoreAllMocks()
    })

    it("detects UTF-8 BOM and LF endings", async () => {
        const bom = Buffer.from([0xef, 0xbb, 0xbf])
        const content = Buffer.concat([bom, Buffer.from("a\nb\nc", "utf8")])
        vi.spyOn(fs.promises, "readFile").mockResolvedValueOnce(content as any)
        const result = await readFileFormat("/some/file.txt")
        expect(result.bom).toEqual(bom)
        expect(result.encoding).toBe("utf8")
        expect(result.ending).toBe("lf")
        vi.restoreAllMocks()
    })

    it("detects UTF-16 LE BOM and CRLF endings", async () => {
        const bom = Buffer.from([0xff, 0xfe])
        const body = encodeText("a\r\nb", "utf16le")
        const content = Buffer.concat([bom, body])
        vi.spyOn(fs.promises, "readFile").mockResolvedValueOnce(content as any)
        const result = await readFileFormat("/some/file.txt")
        expect(result.bom).toEqual(bom)
        expect(result.encoding).toBe("utf16le")
        expect(result.ending).toBe("crlf")
        vi.restoreAllMocks()
    })
})

// ─── Integration: tool.execute.before ────────────────────────────────────────

import plugin from "./index.ts"
const PreserveFormatPlugin = plugin.server

// Helper: build a minimal mock ctx
function makeCtx(dir = "/project") {
    const logs: unknown[] = []
    return {
        ctx: {
            directory: dir,
            client: {
                app: {
                    log: (args: unknown) => { logs.push(args); return Promise.resolve() },
                },
            },
        } as any,
        logs,
    }
}

describe("tool.execute.before — write", () => {
    it("converts LF content to CRLF for existing CRLF file", async () => {
        const fileContent = Buffer.from("existing\r\nlines\r\n", "utf8")
        vi.spyOn(fs.promises, "readFile").mockResolvedValueOnce(fileContent as any)
        vi.spyOn(fs.promises, "access").mockResolvedValueOnce(undefined)

        const { ctx } = makeCtx()
        const hooks = await PreserveFormatPlugin(ctx)
        const output = { args: { filePath: "file.txt", content: "new\nlines\n" } }
        await hooks["tool.execute.before"]!({ tool: "write" } as any, output as any)

        expect(output.args.content).toBe("new\r\nlines\r\n")
        vi.restoreAllMocks()
    })

    it("detects ending from content for new file (LF content stays LF)", async () => {
        vi.spyOn(fs.promises, "access").mockRejectedValueOnce(new Error("ENOENT"))

        const { ctx } = makeCtx()
        const hooks = await PreserveFormatPlugin(ctx)
        const output = { args: { filePath: "newfile.txt", content: "line1\nline2\n" } }
        await hooks["tool.execute.before"]!({ tool: "write" } as any, output as any)

        // Content already LF, detected as LF, no change
        expect(output.args.content).toBe("line1\nline2\n")
        vi.restoreAllMocks()
    })

    it("does nothing for binary files", async () => {
        const { ctx } = makeCtx()
        const hooks = await PreserveFormatPlugin(ctx)
        const output = { args: { filePath: "image.png", content: "binary" } }
        await hooks["tool.execute.before"]!({ tool: "write" } as any, output as any)
        expect(output.args.content).toBe("binary")
    })
})

describe("tool.execute.before — edit", () => {
    it("converts oldString and newString to CRLF for CRLF file", async () => {
        const fileContent = Buffer.from("a\r\nb\r\nc\r\n", "utf8")
        vi.spyOn(fs.promises, "readFile").mockResolvedValueOnce(fileContent as any)

        const { ctx } = makeCtx()
        const hooks = await PreserveFormatPlugin(ctx)
        const output = {
            args: {
                filePath: "file.txt",
                oldString: "a\nb",
                newString: "x\ny",
            },
        }
        await hooks["tool.execute.before"]!({ tool: "edit" } as any, output as any)

        expect(output.args.oldString).toBe("a\r\nb")
        expect(output.args.newString).toBe("x\r\ny")
        vi.restoreAllMocks()
    })
})

describe("tool.execute.before — multiedit", () => {
    it("converts all edits in array to CRLF", async () => {
        const fileContent = Buffer.from("a\r\nb\r\nc\r\n", "utf8")
        vi.spyOn(fs.promises, "readFile").mockResolvedValueOnce(fileContent as any)

        const { ctx } = makeCtx()
        const hooks = await PreserveFormatPlugin(ctx)
        const output = {
            args: {
                filePath: "file.txt",
                edits: [
                    { oldString: "a\nb", newString: "x\ny" },
                    { oldString: "c\nd", newString: "z\nw" },
                ],
            },
        }
        await hooks["tool.execute.before"]!({ tool: "multiedit" } as any, output as any)

        expect(output.args.edits[0].oldString).toBe("a\r\nb")
        expect(output.args.edits[0].newString).toBe("x\r\ny")
        expect(output.args.edits[1].oldString).toBe("c\r\nd")
        expect(output.args.edits[1].newString).toBe("z\r\nw")
        vi.restoreAllMocks()
    })
})

// ─── Integration: file.edited event ──────────────────────────────────────────

describe("file.edited event", () => {
    it("preserves UTF-8 BOM and normalizes to CRLF", async () => {
        const bom = Buffer.from([0xef, 0xbb, 0xbf])
        const { ctx } = makeCtx()
        const hooks = await PreserveFormatPlugin(ctx)

        // Prime the cache by running a write hook first
        const originalBuf = Buffer.concat([bom, Buffer.from("a\r\nb\r\n", "utf8")])
        vi.spyOn(fs.promises, "readFile").mockResolvedValueOnce(originalBuf as any)
        vi.spyOn(fs.promises, "access").mockResolvedValueOnce(undefined)
        await hooks["tool.execute.before"]!({ tool: "write" } as any, {
            args: { filePath: "/project/file.txt", content: "a\nb\n" },
        } as any)

        // file.edited: the file on disk has mixed endings (BOM present, LF from write)
        const onDiskBuf = Buffer.concat([bom, Buffer.from("a\nb\n", "utf8")])
        vi.spyOn(fs.promises, "readFile").mockResolvedValueOnce(onDiskBuf as any)
        const writeSpy = vi.spyOn(fs.promises, "writeFile").mockResolvedValueOnce(undefined)

        await hooks["event"]!({ event: { type: "file.edited", properties: { file: "/project/file.txt" } } } as any)

        expect(writeSpy).toHaveBeenCalledOnce()
        const writtenBuf = writeSpy.mock.calls[0][1] as Buffer
        expect(writtenBuf.subarray(0, 3)).toEqual(bom)
        expect(writtenBuf.subarray(3).toString("utf8")).toBe("a\r\nb\r\n")
        vi.restoreAllMocks()
    })

    it("skips write when file is already correct", async () => {
        const { ctx } = makeCtx()
        const hooks = await PreserveFormatPlugin(ctx)

        // Prime cache: existing CRLF file
        const original = Buffer.from("a\r\nb\r\n", "utf8")
        vi.spyOn(fs.promises, "readFile").mockResolvedValueOnce(original as any)
        vi.spyOn(fs.promises, "access").mockResolvedValueOnce(undefined)
        await hooks["tool.execute.before"]!({ tool: "write" } as any, {
            args: { filePath: "/project/file.txt", content: "a\r\nb\r\n" },
        } as any)

        // file.edited: file is already correct
        vi.spyOn(fs.promises, "readFile").mockResolvedValueOnce(original as any)
        const writeSpy = vi.spyOn(fs.promises, "writeFile").mockResolvedValueOnce(undefined)

        await hooks["event"]!({ event: { type: "file.edited", properties: { file: "/project/file.txt" } } } as any)

        expect(writeSpy).not.toHaveBeenCalled()
        vi.restoreAllMocks()
    })

    it("does nothing for binary files", async () => {
        const { ctx } = makeCtx()
        const hooks = await PreserveFormatPlugin(ctx)
        const readSpy = vi.spyOn(fs.promises, "readFile")

        await hooks["event"]!({ event: { type: "file.edited", properties: { file: "/project/image.png" } } } as any)

        expect(readSpy).not.toHaveBeenCalled()
        vi.restoreAllMocks()
    })

    it("skips non-file.edited events", async () => {
        const { ctx } = makeCtx()
        const hooks = await PreserveFormatPlugin(ctx)
        const readSpy = vi.spyOn(fs.promises, "readFile")

        await hooks["event"]!({ event: { type: "session.started", properties: {} } } as any)

        expect(readSpy).not.toHaveBeenCalled()
        vi.restoreAllMocks()
    })

    it("logs a warning and does not throw on unreadable file", async () => {
        const { ctx, logs } = makeCtx()
        const hooks = await PreserveFormatPlugin(ctx)

        // Prime cache
        const original = Buffer.from("a\r\nb", "utf8")
        vi.spyOn(fs.promises, "readFile").mockResolvedValueOnce(original as any)
        vi.spyOn(fs.promises, "access").mockResolvedValueOnce(undefined)
        await hooks["tool.execute.before"]!({ tool: "write" } as any, {
            args: { filePath: "/project/file.txt", content: "a\nb" },
        } as any)

        vi.spyOn(fs.promises, "readFile").mockRejectedValueOnce(new Error("EACCES"))

        await expect(
            hooks["event"]!({ event: { type: "file.edited", properties: { file: "/project/file.txt" } } } as any)
        ).resolves.toBeUndefined()

        const warnLogs = logs.filter((l: any) => l.body?.level === "warn")
        expect(warnLogs.length).toBeGreaterThan(0)
        vi.restoreAllMocks()
    })
})

// ─── apply_patch support ──────────────────────────────────────────────────────

describe("tool.execute.before — apply_patch", () => {
    it("caches format from patchText file paths so file.edited can normalize", async () => {
        const { ctx, logs } = makeCtx()
        const hooks = await PreserveFormatPlugin(ctx)

        // Use an absolute path so abs() resolves identically from both sides
        const dir: string = (ctx as any).directory  // "/project"
        const absFilePath = path.resolve(dir, "file.txt") // e.g. "D:\project\file.txt"

        // Simulate a CRLF file being updated via apply_patch
        const original = Buffer.from("line1\r\nline2\r\n", "utf8")
        vi.spyOn(fs.promises, "readFile")
            .mockResolvedValueOnce(original as any)  // getFormat inside apply_patch handler
            .mockResolvedValueOnce(Buffer.from("line1\r\nnew line2\n", "utf8") as any) // file.edited reads updated file

        const patchText = [
            "*** Begin Patch",
            "*** Update File: file.txt",
            "@@",
            "-line2",
            "+new line2",
            "*** End Patch",
        ].join("\n")

        await hooks["tool.execute.before"]!(
            { tool: "apply_patch" } as any,
            { args: { patchText } } as any,
        )

        const writeFileSpy = vi.spyOn(fs.promises, "writeFile").mockResolvedValueOnce(undefined)

        await hooks["event"]!({
            event: { type: "file.edited", properties: { file: absFilePath } },
        } as any)

        // Should have written CRLF-normalized content
        expect(writeFileSpy).toHaveBeenCalledOnce()
        const written = writeFileSpy.mock.calls[0][1] as Buffer
        expect(written.toString("utf8")).toBe("line1\r\nnew line2\r\n")

        vi.restoreAllMocks()
    })

    it("matches cache when patchText uses forward-slash absolute path but file.edited uses backslash", async () => {
        const { ctx } = makeCtx()
        const hooks = await PreserveFormatPlugin(ctx)

        // patchText may carry an absolute path with forward slashes (e.g. D:/Projects/file.txt)
        // while file.edited fires with the OS-native backslash path (D:\Projects\file.txt)
        const dir: string = (ctx as any).directory
        const backslashPath = path.resolve(dir, "sub", "file.csproj") // e.g. D:\project\sub\file.csproj
        const forwardSlashPath = backslashPath.replaceAll("\\", "/")   // D:/project/sub/file.csproj

        const original = Buffer.from("<Project>\r\n</Project>\r\n", "utf8")
        vi.spyOn(fs.promises, "readFile")
            .mockResolvedValueOnce(original as any)  // getFormat during apply_patch
            .mockResolvedValueOnce(Buffer.from("<Project>\r\n<NewElement />\n</Project>\n", "utf8") as any) // after patch

        const patchText = `*** Begin Patch\n*** Update File: ${forwardSlashPath}\n@@\n+<NewElement />\n*** End Patch`

        await hooks["tool.execute.before"]!(
            { tool: "apply_patch" } as any,
            { args: { patchText } } as any,
        )

        const writeFileSpy = vi.spyOn(fs.promises, "writeFile").mockResolvedValueOnce(undefined)

        // file.edited fires with the backslash path
        await hooks["event"]!({
            event: { type: "file.edited", properties: { file: backslashPath } },
        } as any)

        expect(writeFileSpy).toHaveBeenCalledOnce()
        const written = writeFileSpy.mock.calls[0][1] as Buffer
        expect(written.toString("utf8")).toBe("<Project>\r\n<NewElement />\r\n</Project>\r\n")

        vi.restoreAllMocks()
    })
})
