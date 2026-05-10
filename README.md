# opencode-preserve-format

[![npm](https://img.shields.io/npm/v/opencode-preserve-format)](https://www.npmjs.com/package/opencode-preserve-format)

An [OpenCode](https://opencode.ai) plugin that preserves a file's original BOM and line endings whenever OpenCode modifies it. Every file keeps exactly what it had before — no configuration needed.

## Installation

Add to your `opencode.json`:

```json
{
  "plugin": ["opencode-preserve-format"]
}
```

OpenCode installs the package automatically at startup.

## How detection works

**Line endings:** The plugin counts `\r\n` (CRLF) and lone `\n` (LF) occurrences in the file. Whichever is more frequent is used as the target. Equal counts → CRLF. No newlines → LF.

**BOM:** The first bytes of the file are inspected for:

| Bytes | Encoding |
|---|---|
| `EF BB BF` | UTF-8 BOM |
| `FF FE` | UTF-16 LE |
| `FE FF` | UTF-16 BE |

If found, the BOM is re-prepended after every edit.

**New files:** When the `write` tool creates a file that doesn't exist yet, the target line ending is detected from the AI-generated content using the same majority algorithm. No BOM is added to new files.

**Mixed endings:** Dominant wins. A file with 70 CRLF and 30 LF is treated as a CRLF file.

## How it works

The plugin hooks into OpenCode's tool execution pipeline at two points:

- **Before tool execution** (`tool.execute.before`): Reads the original file, detects its format, and converts `content`/`oldString`/`newString` in the tool args before they reach disk. Normalizing `oldString` ensures the edit tool's string-matching succeeds even when the LLM generates it with incorrect line endings.

- **After file edits** (`file.edited` event): Re-reads the file as raw bytes, applies the full format pipeline (strip BOM → decode → normalize endings → encode → prepend BOM), and writes back only if something changed. This is the safety net for partial edits that produce mixed line endings.

## Installing as a local file

Copy `index.ts` into your `.opencode/plugins/` directory. No additional dependencies are needed (only Node.js built-ins are used).

**Project-level:**

```sh
cp index.ts <project>/.opencode/plugins/preserve-format.ts
```

**Global:**

```sh
cp index.ts ~/.config/opencode/plugins/preserve-format.ts
```

## Debugging

The plugin logs through `ctx.client.app.log()` with the service name `preserve-format`.

For the fastest debug loop:

1. Install the plugin as a local file from `index.ts`.
2. Start OpenCode with the plugin enabled for the project.
3. Edit a file with known line endings or BOM.
4. Check the OpenCode logs for entries from `service=preserve-format`.

Useful log messages include:

- `plugin loaded`
- `tool: write` / `tool: edit` / `tool: multiedit` / `tool: apply_patch`
- `write -> crlf` or `write -> lf`
- `normalized file`
- `could not read format`
- `could not normalize file`

To exercise the full pipeline manually, test with an existing CRLF or BOM-marked file, make an edit through OpenCode, then confirm the file still has the same BOM and dominant line ending after the write completes.

## Running tests

Install dependencies, then run:

```sh
npm test
```

Other useful checks:

```sh
npm run typecheck
npm run build
```

## Manual test matrix

| Scenario | Expected behaviour |
|---|---|
| UTF-8, CRLF, no BOM | All line endings remain CRLF |
| UTF-8, LF, no BOM | All line endings remain LF |
| UTF-8, CRLF, with BOM | BOM preserved, all CRLF |
| UTF-8, LF, with BOM | BOM preserved, all LF |
| UTF-16 LE with BOM | BOM preserved, correct encoding, endings preserved |
| UTF-16 BE with BOM | BOM preserved, correct encoding, endings preserved |
| New file (write) | Ending detected from AI content; no BOM added |
| Binary file (.png, .zip, etc.) | No-op |
| Mixed endings (70 CRLF / 30 LF) | Normalized to CRLF |
| Unreadable file | Warning logged; file passes through unmodified |
