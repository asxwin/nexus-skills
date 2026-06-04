// @ts-nocheck
import * as fs from "fs";
import * as path from "path";
import * as child_process from "child_process";
import * as vscode from "vscode";
import {
    TOOL_OP_TIMEOUT_MS,
    SEARCH_GREP_TIMEOUT_MS,
    EXEC_TIMEOUT_MIN_MS,
    EXEC_TIMEOUT_MAX_MS,
    EXEC_TIMEOUT_DEFAULT_MS,
    LIST_MAX_DEPTH_MIN,
    LIST_MAX_DEPTH_MAX,
    LIST_MAX_DEPTH_DEFAULT,
    SEARCH_CONTEXT_LINES_MIN,
    SEARCH_CONTEXT_LINES_MAX,
    SEARCH_CONTEXT_LINES_DEFAULT,
    ATOMIC_WRITE_MAX_RETRIES,
    ATOMIC_WRITE_BACKOFF_MS,
    ATOMIC_WRITE_TRANSIENT_CODES,
    clampInt,
} from "./hardeningConfig";
import { CodebaseIndexer } from "./codebaseIndexer/CodebaseIndexer";

/** Reject a promise with a timeout error after `ms` while still letting the
 *  original promise win the race if it settles first. */
function withDeadline<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
    let timer: any;
    const timeout = new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
            const e: any = new Error(`${label} timed out after ${ms}ms`);
            e.code = 'ETIMEDOUT';
            reject(e);
        }, ms);
    });
    return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

/** Async existence check (existsSync has no promise form — use access). */
async function pathExists(p) {
    return fs.promises.access(p).then(() => true).catch(() => false);
}

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
/** Atomically write `content` to `filePath` (temp + rename).
 *  Throws on any failure — never leaves a partial file. Async; retries a
 *  bounded number of times on transient errno codes with linear backoff. */
async function writeFileAtomic(filePath, content) {
    const dir = path.dirname(filePath);
    if (!(await withDeadline(pathExists(dir), TOOL_OP_TIMEOUT_MS, 'stat dir'))) {
        await withDeadline(fs.promises.mkdir(dir, { recursive: true }), TOOL_OP_TIMEOUT_MS, 'mkdir');
    }
    const tmpPath = path.join(dir, `.${path.basename(filePath)}.qgenie-${process.pid}-${Date.now()}.tmp`);
    let attempt = 0;
    // Retry loop bounded by ATOMIC_WRITE_MAX_RETRIES; only transient errno codes retry.
    while (true) {
        attempt++;
        try {
            await withDeadline(fs.promises.writeFile(tmpPath, content, 'utf8'), TOOL_OP_TIMEOUT_MS, 'write tmp');
            // Atomic rename
            await withDeadline(fs.promises.rename(tmpPath, filePath), TOOL_OP_TIMEOUT_MS, 'rename');
            return;
        }
        catch (err) {
            // Best-effort cleanup of the temp file.
            try {
                if (await pathExists(tmpPath)) {
                    await fs.promises.unlink(tmpPath);
                }
            }
            catch { /* ignore */ }
            const code = err && err.code;
            if (ATOMIC_WRITE_TRANSIENT_CODES.includes(code) && attempt < ATOMIC_WRITE_MAX_RETRIES) {
                await sleep(ATOMIC_WRITE_BACKOFF_MS * attempt);
                continue;
            }
            throw err;
        }
    }
}
export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: object;
  };
}

export interface ToolExecutionResult {
  success: boolean;
  output: string;
  diffData?: { filePath: string; isNewFile: boolean; oldContent: string; newContent: string };
}


export const APPROVAL_REQUIRED_TOOLS = new Set([
    'write_file', 'replace_in_file', 'insert_in_file',
    'delete_file', 'move_file', 'execute_command',
]);
// File-mutating tools share the `write_file` auto-approve gate so one
// toggle covers every edit/create/delete. execute_command keeps its own gate.
const WRITE_GATE_TOOLS = new Set([
    'write_file', 'replace_in_file', 'insert_in_file', 'delete_file', 'move_file',
]);
/** Map a tool name to its auto-approve gate key (file-mutating tools fold onto `write_file`). */
export function approvalGateKey(toolName) {
    return WRITE_GATE_TOOLS.has(toolName) ? 'write_file' : toolName;
}
// Allowed parameter names per tool — used by the streaming XML parser to
// ignore angle-bracket text that isn't an actual tool invocation.
export const XML_TOOL_SCHEMA = {
    read_file: ['path'],
    read_file_range: ['path', 'start_line', 'end_line'],
    write_file: ['path', 'content'],
    replace_in_file: ['path', 'diff'],
    insert_in_file: ['path', 'line', 'content'],
    delete_file: ['path'],
    move_file: ['source', 'destination'],
    execute_command: ['command', 'cwd', 'timeout_ms'],
    list_files: ['path', 'recursive', 'max_depth'],
    search_files: ['path', 'pattern', 'file_pattern', 'context_lines'],
    get_workspace_info: [],
    read_active_editor: ['selection_only'],
    get_file_info: ['path'],
    get_diagnostics: ['path'],
    git: ['subcommand', 'args', 'path'],
    search_codebase: ['query', 'k'],
};
// Read-only tools whose output is already recorded — model should NOT echo
// it back. Used to append a "do not echo" reminder after these tools' results.
export const NO_ECHO_TOOLS = new Set([
    'read_file', 'read_file_range', 'read_active_editor', 'list_files',
    'search_files', 'get_workspace_info', 'get_file_info', 'get_diagnostics', 'git',
    'search_codebase',
]);
/** Coerce raw XML-parsed string params into typed tool args (bool/number),
 *  preserving verbatim bodies for `content` and `diff`. */
export function coerceToolArgs(toolName, rawParams) {
    const args = {};
    for (const [k, v] of Object.entries(rawParams)) {
        const trimmed = v.trim();
        if (trimmed === 'true') {
            args[k] = true;
        }
        else if (trimmed === 'false') {
            args[k] = false;
        }
        else if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
            args[k] = Number(trimmed);
        }
        else {
            args[k] = trimmed;
        }
    }
    if ((toolName === 'write_file' || toolName === 'insert_in_file') && rawParams['content'] !== undefined) {
        args['content'] = rawParams['content'];
    }
    if (toolName === 'replace_in_file' && rawParams['diff'] !== undefined) {
        args['diff'] = rawParams['diff'];
    }
    return args;
}
// Marker recognizers: any leading whitespace, >=3 of the symbol, optional trailing text.
const RE_SEARCH_MARKER = /^[ \t]*-{3,}[ \t]*SEARCH\b/;
const RE_MID_MARKER = /^[ \t]*={3,}[ \t]*$/;
const RE_END_MARKER = /^[ \t]*\+{3,}[ \t]*REPLACE\b/;
const isSearchMarker = (l) => RE_SEARCH_MARKER.test(l);
const isMidMarker = (l) => RE_MID_MARKER.test(l);
const isEndMarker = (l) => RE_END_MARKER.test(l);
const isAnyMarker = (l) => isSearchMarker(l) || isMidMarker(l) || isEndMarker(l);
/** Count how many lines in `text` look like a SEARCH/REPLACE frame marker.
 *  Used to detect markers that leaked into a file after an apply. */
function countMarkerLines(text) {
    let c = 0;
    for (const l of text.split('\n')) {
        if (isAnyMarker(l)) { c++; }
    }
    return c;
}
/** Parse a `diff` string into SEARCH/REPLACE blocks. Strict frame:
 *  SEARCH-marker → ======= → +++++++ REPLACE; partial frames are reported, not silently dropped. */
export function parseSearchReplaceBlocks(diff) {
    return parseSearchReplaceBlocksEx(diff).blocks;
}
/** Like `parseSearchReplaceBlocks` but also returns structured warnings
 *  about malformed/partial frames for precise model diagnostics. */
export function parseSearchReplaceBlocksEx(diff) {
    const blocks = [];
    const warnings = [];
    const lines = diff.split('\n');
    const n = lines.length;
    let i = 0;
    while (i < n) {
        // Fast string guard: skip lines that can't possibly be markers
        const line = lines[i];
        if (!line.includes('SEARCH') && !isSearchMarker(line)) {
            i++;
            continue;
        }
        if (!isSearchMarker(line)) {
            i++;
            continue;
        }
        const searchMarkerLine = i + 1; // 1-based for messages
        i++;
        // SEARCH body runs until the first mid-marker; marker-looking content is literal.
        const searchLines = [];
        let foundMid = false;
        while (i < n) {
            // Fast guard: mid-marker must contain '==='
            if (lines[i].includes('===') && isMidMarker(lines[i])) {
                foundMid = true;
                break;
            }
            // A second SEARCH-start marker before we ever hit a mid-marker means
            // the previous block was never closed — almost always a malformed
            // frame whose markers would otherwise leak into the file. Flag it.
            if (isSearchMarker(lines[i])) {
                warnings.push(`Block starting at line ${searchMarkerLine}: found a new '------- SEARCH' ` +
                    `marker (at line ${i + 1}) before this block's '=======' mid-marker. The previous ` +
                    `block is unterminated — give every block all three markers, each on its own line.`);
            }
            searchLines.push(lines[i]);
            i++;
        }
        if (!foundMid) {
            warnings.push(`Block starting at line ${searchMarkerLine}: reached end of diff without a ` +
                `'=======' mid-marker. This block was ignored.`);
            break;
        }
        i++;
        const replaceLines = [];
        let foundEnd = false;
        while (i < n) {
            // Fast guard: end-marker must contain 'REPLACE'
            if (lines[i].includes('REPLACE') && isEndMarker(lines[i])) {
                foundEnd = true;
                break;
            }
            replaceLines.push(lines[i]);
            i++;
        }
        if (!foundEnd) {
            warnings.push(`Block starting at line ${searchMarkerLine}: reached end of diff without a ` +
                `'+++++++ REPLACE' end-marker. This block was ignored.`);
            break;
        }
        i++;
        blocks.push({
            search: searchLines.join('\n'),
            replace: replaceLines.join('\n'),
        });
    }
    return { blocks, warnings };
}
/** Normalize for whitespace-tolerant comparison: strip CR and trailing
 *  horizontal whitespace per line; leading whitespace is preserved. */
function normalizeForFuzzy(s) {
    return s.replace(/\r\n?/g, '\n').replace(/[ \t]+$/gm, '');
}
/** Locate `search` in `content`, returning [start, end) byte range or null.
 *  Tries: exact indexOf → CRLF-normalized → trailing-whitespace-tolerant line match.
 *  `fromOffset` (default 0) restricts matching to at-or-after that byte offset, so
 *  successive blocks with identical SEARCH text map to successive occurrences in
 *  document order instead of all collapsing onto the first one.
 *  Overload accepts pre-computed fuzzy content and lines for batch use. */
function findSearchRange(content, search, precomputed, fromOffset = 0) {
    const exact = content.indexOf(search, fromOffset);
    if (exact !== -1) {
        return { start: exact, end: exact + search.length };
    }
    if (content.includes('\r')) {
        const nc = content.replace(/\r\n/g, '\n');
        const ns = search.replace(/\r\n/g, '\n');
        // Map fromOffset (original coords) into CRLF-normalized coords by
        // subtracting the count of \r dropped before it.
        let crBefore = 0;
        for (let p = 0; p < fromOffset && p < content.length; p++) {
            if (content[p] === '\r' && content[p + 1] === '\n') { crBefore++; }
        }
        const idx = nc.indexOf(ns, Math.max(0, fromOffset - crBefore));
        if (idx !== -1) {
            // Map normalized index back to original by counting dropped \r before `idx`.
            let origStart = 0, seen = 0;
            while (seen < idx && origStart < content.length) {
                if (content[origStart] === '\r' && content[origStart + 1] === '\n') {
                    origStart++;
                }
                else {
                    seen++;
                }
                origStart++;
            }
            let origEnd = origStart, covered = 0;
            while (covered < ns.length && origEnd < content.length) {
                if (content[origEnd] === '\r' && content[origEnd + 1] === '\n') {
                    origEnd++;
                }
                else {
                    covered++;
                }
                origEnd++;
            }
            return { start: origStart, end: origEnd };
        }
    }
    const fuzzyContent = precomputed ? precomputed.fuzzyContent : normalizeForFuzzy(content);
    const fuzzySearch = normalizeForFuzzy(search);
    // Translate fromOffset into fuzzy coords by normalizing the prefix length.
    const fuzzyFrom = fromOffset > 0 ? normalizeForFuzzy(content.slice(0, fromOffset)).length : 0;
    const fIdx = fuzzyContent.indexOf(fuzzySearch, fuzzyFrom);
    if (fIdx === -1) {
        return null;
    }
    // Recover range by line numbers — fuzzy transform collapses trailing spaces, so we can't index-map.
    const linesBefore = fuzzyContent.slice(0, fIdx).split('\n').length - 1;
    const matchLineCount = fuzzySearch.split('\n').length;
    const origLines = precomputed ? precomputed.contentLines : content.split('\n');
    if (linesBefore + matchLineCount > origLines.length) {
        return null;
    }
    let start = 0;
    for (let k = 0; k < linesBefore; k++) {
        start += origLines[k].length + 1;
    }
    let end = start;
    for (let k = linesBefore; k < linesBefore + matchLineCount; k++) {
        end += origLines[k].length + (k < origLines.length - 1 ? 1 : 0);
    }
    if (normalizeForFuzzy(content.slice(start, end)) !== fuzzySearch) {
        return null;
    }
    return { start, end };
}
class SearchReplaceApplyError extends Error {
    constructor(message, blockIndex, appliedCount) {
        super(message);
        this.blockIndex = blockIndex;
        this.appliedCount = appliedCount;
        this.name = 'SearchReplaceApplyError';
    }
}
/** Apply SEARCH/REPLACE blocks to `content`, in-memory and all-or-nothing.
 *  Idempotently no-ops blocks already applied; throws SearchReplaceApplyError on a real miss. */
export function applySearchReplaceBlocks(content, blocks) {
    let result = content;
    const appliedRanges = [];
    let noops = 0;
    // Sequential cursor (byte offset into `result`). Each block matches at or
    // AFTER this point, so N blocks carrying identical SEARCH text map cleanly
    // onto the 1st, 2nd, 3rd… occurrence in document order — the same way a
    // human reads a diff top-to-bottom. This RESOLVES "ambiguous" repeated-text
    // edits instead of refusing them. After a successful apply the cursor jumps
    // to just past the inserted REPLACE so we never re-match inside our own
    // output. The cursor is rebased after every mutation (offsets shift).
    let searchCursor = 0;
    // Baseline count of marker-looking lines already in the file, so the
    // post-apply self-heal below only acts on markers the edit INTRODUCED.
    const baselineMarkerLines = countMarkerLines(content);
    // Pre-compute fuzzy content and lines once for the initial content;
    // invalidated (set to null) whenever a block mutates `result`.
    let precomputed = {
        fuzzyContent: normalizeForFuzzy(content),
        contentLines: content.split('\n'),
    };
    for (let i = 0; i < blocks.length; i++) {
        const { search, replace } = blocks[i];
        if (search.length === 0) {
            throw new SearchReplaceApplyError(`Block ${i + 1}: empty SEARCH text is not allowed. To insert text, SEARCH ` +
                `must contain a unique anchor line that already exists in the file.`, i, appliedRanges.length);
        }
        // First try at-or-after the cursor (sequential semantics). If that
        // finds nothing, fall back to a whole-file search starting at 0 so a
        // legitimately out-of-document-order block still applies.
        let range = findSearchRange(result, search, precomputed || undefined, searchCursor);
        if (!range && searchCursor > 0) {
            range = findSearchRange(result, search, precomputed || undefined, 0);
        }
        if (range) {
            result = result.slice(0, range.start) + replace + result.slice(range.end);
            appliedRanges.push({ start: range.start, end: range.start + replace.length });
            // Advance the cursor past the text we just inserted.
            searchCursor = range.start + replace.length;
            precomputed = null; // invalidate — content changed
            continue;
        }
        // Idempotent retry: SEARCH missing but REPLACE already present → treat
        // as already-applied no-op, and advance the cursor past it so later
        // identical blocks target the NEXT occurrence.
        if (replace.length > 0) {
            const already = findSearchRange(result, replace, precomputed || undefined, searchCursor)
                || findSearchRange(result, replace, precomputed || undefined, 0);
            if (already) {
                searchCursor = already.end;
                noops++;
                continue;
            }
        }
        const preview = search.split('\n').slice(0, 5).join('\n');
        throw new SearchReplaceApplyError(`Block ${i + 1} of ${blocks.length}: SEARCH text not found in the file ` +
            `(${appliedRanges.length} earlier block(s) already applied to the in-memory copy; ` +
            `nothing was written to disk). The SEARCH must match the CURRENT file content ` +
            `byte-for-byte (after tolerant trailing-whitespace/CRLF normalization, which was ` +
            `also tried). First lines of the failing SEARCH:\n${preview}`, i, appliedRanges.length);
    }
    // Self-healing leak guard. A correctly-applied edit can never INCREASE the
    // number of frame-marker lines in the file. If it did, a stray marker
    // leaked out of the diff frame into REPLACE content. Rather than refuse the
    // whole edit (the old behaviour), surgically strip ONLY the marker lines
    // that fall inside the regions we just wrote, then re-verify. We never
    // touch marker-looking lines that were already in the file (baseline).
    let resultMarkerLines = countMarkerLines(result);
    if (resultMarkerLines > baselineMarkerLines && appliedRanges.length > 0) {
        const healed = stripLeakedMarkersInRanges(result, appliedRanges);
        if (healed !== null) {
            result = healed;
            resultMarkerLines = countMarkerLines(result);
        }
    }
    // If self-healing could not bring us back to baseline, the markers are
    // entangled with real content in a way we cannot safely auto-fix — fail
    // loudly rather than write corruption to disk.
    if (resultMarkerLines > baselineMarkerLines) {
        throw new SearchReplaceApplyError(`Refusing to write: ${resultMarkerLines - baselineMarkerLines} stray ` +
            `SEARCH/REPLACE frame-marker line(s) could not be safely removed from the result and would ` +
            `corrupt the file (nothing was written to disk). Ensure no marker text (a dashes+SEARCH line, a ` +
            `bare '=======', or '+++++++ REPLACE') appears inside your SEARCH or REPLACE bodies.`,
            blocks.length - 1, appliedRanges.length);
    }
    return { result, appliedRanges, noops };
}
/** Remove frame-marker lines that fall strictly inside any of `ranges`
 *  (the spans this apply just wrote). Returns the healed string, or null if a
 *  marker line sits outside every written range (cannot safely heal). */
function stripLeakedMarkersInRanges(text, ranges) {
    // Build a quick predicate: is byte offset `off` inside a written range?
    const inWritten = (off) => ranges.some((r) => off >= r.start && off < r.end);
    const lines = text.split('\n');
    const kept = [];
    let offset = 0;
    let outsideMarker = false;
    for (const line of lines) {
        if (isAnyMarker(line)) {
            if (inWritten(offset)) {
                // Drop this leaked marker line entirely.
                offset += line.length + 1;
                continue;
            }
            // A marker outside any region we wrote — not ours to remove.
            outsideMarker = true;
        }
        kept.push(line);
        offset += line.length + 1;
    }
    if (outsideMarker) { return null; }
    return kept.join('\n');
}
function filePreview(content) {
    return content.length > 4000
        ? content.slice(0, 4000) + '\n... (truncated)'
        : content;
}
/** Extract error message from unknown catch values. */
function errMsg(e) {
    return e instanceof Error ? e.message : String(e);
}
/** Strip terminal control noise (OSC 633/133 shell-integration markers,
 *  other OSC, CSI, two-byte ESC, stray C0 controls) from captured shell output.
 *  Combined into a single regex alternation for performance. */
const TERMINAL_NOISE_RE = /\x1b?\](?:633|133);[^\x07\x1b\n]*(?:\x07|\x1b\\)?|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[@-Z\\-_]|[\x00-\x08\x0b\x0c\x0e-\x1f]/g;
function cleanTerminalOutput(s) {
    return s.replace(TERMINAL_NOISE_RE, '');
}
/** Build the shared workspace-context block appended to every agent system
 *  prompt (main session AND delegated sub-agents). */
export function buildWorkspaceContext() {
    const folders = vscode.workspace.workspaceFolders;
    const paths = folders ? folders.map(f => f.uri.fsPath) : [];
    const activeFile = vscode.window.activeTextEditor?.document.uri.fsPath || null;
    const platform = process.platform;
    const shell = process.env['SHELL'] || process.env['ComSpec'] || 'unknown';
    let ctx = `\n\n`;
    if (paths.length > 0) {
        ctx += `CURRENT VS CODE WORKSPACE FOLDERS:\n` + paths.map(p => `  - ${p}`).join('\n');
    }
    else {
        ctx += `CURRENT VS CODE WORKSPACE FOLDERS: (none open)`;
    }
    if (activeFile) {
        ctx += `\nACTIVE FILE: ${activeFile}`;
    }
    ctx += `\nHOST PLATFORM: ${platform}    SHELL: ${shell}`;
    ctx += `\n\nFILE-SYSTEM ACCESS:\n`;
    ctx += `- You can read/write ANY file on this machine that the VS Code process has OS-level permission for. `;
    ctx += `Your tools (read_file, write_file, replace_in_file, list_files, search_files, get_file_info, execute_command) are NOT sandboxed to the workspace folders above.\n`;
    ctx += `- Pass an ABSOLUTE path (e.g. /usr2/ashwv/foo/bar.ts, /tmp/x.log, ~/notes.md) to access files OUTSIDE the workspace. The "~" prefix is expanded to $HOME. Do NOT refuse, hesitate, or warn that a path is "outside the workspace" — just call the tool with the absolute path.\n`;
    ctx += `- Pass a RELATIVE path (e.g. src/main.ts) to access a file inside one of the workspace folders. The tool tries each workspace folder in order and uses the first match.\n`;
    ctx += `- If a tool returns "File not found", just retry with a corrected absolute path — do not give up.\n\n`;
    ctx += `EDITING ETIQUETTE (recap):\n`;
    ctx += `- replace_in_file = default for any change to an EXISTING file.\n`;
    ctx += `- write_file = ONLY for brand-new files or full rewrites; never to tweak a portion of an existing file.\n`;
    ctx += `- execute_command for build commands, tests, git ops, etc.`;
    return ctx;
}
// XML-tag tool prompt (Cline-style): describes tools as XML tags emitted in
// the assistant message — workaround for APIs that buffer tool_call JSON.
export function buildToolPrompt() {
    const OPEN = '<';
    const CLOSE = '>';
    const t = (name) => OPEN + name + CLOSE;
    const tc = (name) => OPEN + '/' + name + CLOSE;
    const examples = [];
    // search_codebase is documented FIRST and emphasised because the workflow
    // rule in defaultSystemPrompt.ts requires it before exploratory file reads.
    // Keep this block at the top of the tool list — model attention is
    // strongest on the earliest tool documented.
    examples.push(`# search_codebase — PREFERRED FIRST STEP FOR CODE EXPLORATION
Query the LOCAL, pre-built codebase index (BM25 lexical search + a ranked
symbol outline — fully local, no AI, no network).

**USE THIS FIRST** before reading files when exploring unfamiliar code or
locating where functionality lives. It returns only the most relevant code
chunks plus a repo-map outline at **10–100x lower token cost** than reading
whole files. After reviewing the hits, use read_file_range on specific line
ranges that need deeper context — do NOT read whole files when you only
need a region.

Calling read_file or read_file_range WITHOUT first checking search_codebase
is a workflow violation when an index exists. If this tool returns
"(no index …)", the index is unavailable — only then fall back to
search_files / list_files / read_file.

Parameters:
  - query (required): natural-language or keyword query, e.g. "parse skill frontmatter"
  - k (optional): max chunks to return (default 12)
Example:
${t('search_codebase')}
${t('query')}where are skills loaded from disk${tc('query')}
${tc('search_codebase')}`);
    examples.push(`# read_file
Read the full contents of a file. For exploratory reads of unfamiliar code,
prefer search_codebase first (see above), then read_file_range on the
specific lines you need — read_file dumps the entire file and is
expensive on large files.
Parameters:
  - path (required): absolute or workspace-relative path
Example:
${t('read_file')}
${t('path')}src/main.ts${tc('path')}
${tc('read_file')}`);
    examples.push(`# write_file
Write the FULL content of a file. REQUIRES USER APPROVAL.

USE ONLY when:
  - Creating a brand-new file that does not exist on disk yet, OR
  - Performing a complete top-to-bottom rewrite where >50% of the existing
    file is changing.

DO NOT use write_file to make small/localized edits to an existing file
(rename, bug fix, insert function, change a few lines). For those, use
replace_in_file with SEARCH/REPLACE blocks. Re-emitting an entire existing
file just to change a portion of it is FORBIDDEN — it is slow, wastes
tokens, and risks data loss.

Parameters:
  - path (required): path to write
  - content (required): full file content (do NOT escape characters; the
    content is taken verbatim between the open/close ${t('content')} tags)
Example (creating a NEW file):
${t('write_file')}
${t('path')}src/hello.ts${tc('path')}
${t('content')}
console.log("hi");
${tc('content')}
${tc('write_file')}`);
    // Built piecewise so literal SEARCH/REPLACE markers don't conflict with this file's own diff format.
    const SR_OPEN = '-'.repeat(7) + ' SEARCH';
    const SR_MID = '='.repeat(7);
    const SR_END = '+'.repeat(7) + ' REPLACE';
    const replaceExample = `# replace_in_file
Make targeted edits to an EXISTING file using SEARCH/REPLACE blocks.
REQUIRES USER APPROVAL. Prefer this over write_file when you only change
a small portion of the file (renaming a symbol, fixing a bug, inserting
a function) — much faster than re-emitting the whole file.

Parameters:
  - path (required): path to the file to edit
  - diff (required): one or more SEARCH/REPLACE blocks. The body of the
    ${t('diff')} tag is taken verbatim. Each block uses this exact format:

      ${SR_OPEN}
      <exact text from the file>
      ${SR_MID}
      <replacement text>
      ${SR_END}

Rules:
  - SEARCH text should match the file BYTE-FOR-BYTE (whitespace included).
    If exact match fails, the tool ALSO retries with tolerant matching
    that ignores (a) trailing whitespace differences on each line and
    (b) CRLF vs LF line endings. Anything else (leading whitespace,
    interior whitespace, missing/extra lines) must match exactly.
  - Each block replaces only the FIRST occurrence of its SEARCH text.
  - BATCH multiple edits to the same file into ONE replace_in_file call
    by stacking several SEARCH/REPLACE blocks in the <diff> body, in
    file order. Do NOT chain multiple replace_in_file calls against the
    same path — that's slow, wastes approvals, and clutters the chat.
    One call with N blocks = correct. N calls with 1 block each = wrong.
  - DELETION: to remove code, leave the REPLACE section EMPTY (the body
    between ======= and the +++++++ REPLACE end-marker contains nothing,
    not even a blank line). The matched SEARCH text is removed from the file.

Example (rename foo to bar):
${t('replace_in_file')}
${t('path')}src/main.ts${tc('path')}
${t('diff')}
${SR_OPEN}
function foo() {
${SR_MID}
function bar() {
${SR_END}
${tc('diff')}
${tc('replace_in_file')}`;
    examples.push(replaceExample);
    examples.push(`# insert_in_file
Insert text into an EXISTING file at a specific 1-based line, WITHOUT
needing a SEARCH anchor. The inserted text becomes its own line(s) placed
BEFORE the given line. Use this for adding imports, appending a function,
or inserting a block where an exact SEARCH match would be fiddly.
REQUIRES USER APPROVAL.
Parameters:
  - path (required)
  - line (required): 1-based line to insert BEFORE. Use 0 or a line beyond
    the end of the file to APPEND at the end.
  - content (required): text to insert (verbatim, may be multi-line)
Example (prepend an import):
${t('insert_in_file')}
${t('path')}src/main.ts${tc('path')}
${t('line')}1${tc('line')}
${t('content')}
import { foo } from './foo';
${tc('content')}
${tc('insert_in_file')}`);
    examples.push(`# delete_file
Delete a single FILE from disk. REQUIRES USER APPROVAL. Refuses to delete
directories (use execute_command for recursive directory removal).
Parameters:
  - path (required)
Example:
${t('delete_file')}
${t('path')}src/old.ts${tc('path')}
${tc('delete_file')}`);
    examples.push(`# move_file
Move or RENAME a file. REQUIRES USER APPROVAL. Fails if the destination
already exists (never overwrites). Missing parent directories of the
destination are created automatically.
Parameters:
  - source (required): current path
  - destination (required): new path
Example (rename):
${t('move_file')}
${t('source')}src/old.ts${tc('source')}
${t('destination')}src/new.ts${tc('destination')}
${tc('move_file')}`);
    examples.push(`# execute_command
Run a shell command. REQUIRES USER APPROVAL.
Parameters:
  - command (required)
  - cwd (optional)
  - timeout_ms (optional)
Example:
${t('execute_command')}
${t('command')}npm test${tc('command')}
${tc('execute_command')}`);
    examples.push(`# list_files
List files in a directory.
Parameters:
  - path (required)
  - recursive (optional, default false)
  - max_depth (optional)
Example:
${t('list_files')}
${t('path')}src${tc('path')}
${t('recursive')}true${tc('recursive')}
${tc('list_files')}`);
    examples.push(`# search_files
Regex search across files.
Parameters:
  - path (required)
  - pattern (required)
  - file_pattern (optional, e.g. *.ts)
  - context_lines (optional, default 2)
Example:
${t('search_files')}
${t('path')}src${tc('path')}
${t('pattern')}TODO${tc('pattern')}
${tc('search_files')}`);
    examples.push(`# get_workspace_info
Get info about the VS Code workspace.
No parameters.
Example:
${t('get_workspace_info')}${tc('get_workspace_info')}`);
    examples.push(`# read_active_editor
Read the active editor's content.
Parameters:
  - selection_only (optional)
Example:
${t('read_active_editor')}${tc('read_active_editor')}`);
    examples.push(`# get_file_info
Get metadata for a file.
Parameters:
  - path (required)
Example:
${t('get_file_info')}
${t('path')}src/main.ts${tc('path')}
${tc('get_file_info')}`);
    examples.push(`# read_file_range
Read only a line range of a file (1-based, inclusive). Use this instead of
read_file for large files or when you only need a known region — it is much
cheaper on context than reading the whole file.
Parameters:
  - path (required)
  - start_line (required, 1-based)
  - end_line (required, 1-based, inclusive)
Example:
${t('read_file_range')}
${t('path')}src/main.ts${tc('path')}
${t('start_line')}40${tc('start_line')}
${t('end_line')}80${tc('end_line')}
${tc('read_file_range')}`);
    examples.push(`# get_diagnostics
Read the current language-server diagnostics (errors / warnings / hints) that
VS Code already has for files in the workspace. Use this to VERIFY an edit
compiles/lints WITHOUT running a full build. NO approval required.
Parameters:
  - path (optional): a single file to scope to; omit to get diagnostics for
    every file in the workspace.
Example (whole workspace):
${t('get_diagnostics')}${tc('get_diagnostics')}
Example (one file):
${t('get_diagnostics')}
${t('path')}src/main.ts${tc('path')}
${tc('get_diagnostics')}`);
    examples.push(`# git
Run a READ-ONLY git command in the workspace. NO approval required (it cannot
mutate the repo). For mutating git operations (add/commit/checkout/push/etc.)
use execute_command instead (which requires approval).
Parameters:
  - subcommand (required): one of status | diff | log | blame | show
  - args (optional): extra arguments string, e.g. "--stat" or "-n 5"
  - path (optional): restrict to a path
Example:
${t('git')}
${t('subcommand')}diff${tc('subcommand')}
${t('args')}--stat${tc('args')}
${tc('git')}`);
    // (search_codebase is documented at the TOP of the tool list — see above.)
    return `


# TOOL PROTOCOL — read this whole section carefully, it is the contract you operate under

## How a tool call works

You invoke a tool by emitting XML-style tags directly inside your
assistant message. The host runtime parses those tags out of the
streamed text, executes the tool on your behalf, and feeds the result
back as the NEXT message in the conversation (role:user, prefixed with
"[tool <name> result]"). You then continue.

A tool call is a real side-effect-ful pause point in the conversation —
emit it, then let the runtime act, then react to the result. It is NOT
"I will pretend to call a tool"; the tool actually runs.

## Iron-clad rules (violations break the parser)

1.  Emit AT MOST ONE tool invocation per assistant message.
    After the opening tool tag, write only that tool's parameter
    tags and its closing tool tag — nothing else.

2.  Tag names are EXACT and lowercase: ${t('read_file')}, not
    <ReadFile>, <read-file>, or <read_File>. The closing tag must
    match (${tc('read_file')}).

3.  Each parameter MUST appear inside its OWN open/close tag, and
    only the parameters listed in this document are allowed.
    Unknown parameters are silently dropped.

4.  Parameter VALUES are taken VERBATIM — no JSON escaping, no
    URL-encoding, no markdown fences. Whatever you write between
    ${t('path')} and ${tc('path')} is the literal path string.

5.  For multi-line parameters (the content of write_file and the
    diff of replace_in_file), put a newline immediately after the
    opening tag and put the closing tag on its OWN line at column
    zero. Anything else corrupts the body.

6.  After your tool tag closes, STOP generating. Do not narrate
    "I will now wait for the result" — the runtime already does
    that.

7.  **NO PROSE BEFORE THE TOOL TAG.** When you intend to call a
    tool, the FIRST thing in your message must be either:
       (a) the tool tag itself, OR
       (b) a ${t('thinking')}…${tc('thinking')} block (which the
           user reads in a separate panel, not as inline
           preamble), then the tool tag.
    Do NOT write "I'll read the file first" / "Let me check" /
    "Sure, I can help with that" / any restatement of the user's
    request before the tool tag. The user can see what you're
    doing from the tool block the UI renders — narration is
    redundant and slows them down.

## Common mistakes — NEVER do these

  ✗ Two tool tags in one message (only the first runs; the rest
    become noise).
  ✗ Prose AFTER the closing tool tag in the same message.
  ✗ Wrapping the tool tag in a markdown code fence — the fence
    will appear in the user's view and the tag won't be parsed.
  ✗ JSON instead of XML (e.g. {"tool":"read_file",...}).
  ✗ Re-encoding file content as a JSON string (escaping \\n,
    quoting, etc.) inside ${t('content')}. Just paste the raw body.
  ✗ Hand-crafting a SEARCH block from memory instead of from a
    fresh read_file. SEARCH must match BYTE-FOR-BYTE.
  ✗ Hallucinating a tool that isn't listed below
    (e.g. <grep>, <run_python>).

## Reacting to tool results

After each tool runs, you'll see a user-role message of the form:

    [tool <name> result]
    <stdout / file content / error text>

How to react:

  - If the result satisfies the original task → answer the user.
  - If you need MORE information → emit the next tool call (just
    one). Do not chain "I'll now also do X and Y" promises in
    prose; emit them one at a time as you need them.
  - If the tool reported an ERROR (file not found, search no
    match, SEARCH/REPLACE didn't apply, exit code != 0) → DIAGNOSE
    first. Re-read the relevant file, list its parent, or search
    for the right substring. Don't silently retry the same broken
    call.
  - NEVER fabricate a tool result. If a tool failed, say so.

## Filesystem access

The file-handling tools (read_file, write_file, replace_in_file,
list_files, search_files, get_file_info) are NOT sandboxed. They
use raw OS calls and can read or write ANY path the VS Code
process has permission for — including paths OUTSIDE the open
workspace folders.

  - ABSOLUTE path (/usr/local/foo, /tmp/x.log, ~/notes.md) →
    reaches anywhere the OS lets you. ~ expands to $HOME.
  - RELATIVE path (src/main.ts) → resolved against each open
    workspace folder in order; first existing match wins. New
    files are created in the first workspace folder.
  - Do NOT refuse because a path looks "outside the workspace".
    Just call the tool with the absolute path.
  - On "File not found", don't give up: re-list the parent
    directory, fix the path, retry once.

## Approval gates

write_file, replace_in_file, and execute_command may trigger an
interactive approval dialog. If the user denies, the tool returns
"User denied this operation." That is NOT a tool error — the user
just said no. Acknowledge politely, ask what they'd prefer, do
not retry the same call.

## Showing your reasoning (optional)

You may wrap PRIVATE reasoning at the start of a message in a
${t('thinking')}…${tc('thinking')} block. The body is rendered to
the user in a separate THINKING panel.

  ✓  Open ${t('thinking')}, write reasoning, close ${tc('thinking')},
     then write the actual answer (or a tool tag) AFTER the close.
  ✗  Never open without closing in the same message.
  ✗  Never put your final answer or a tool tag INSIDE the thinking
     block — those won't be visible to the user.
  ✗  Never re-open ${t('thinking')} after closing it.
  If unsure, skip thinking entirely and just write your answer.

# AVAILABLE TOOLS

${examples.join('\n\n')}

# OPERATING RULES — these apply to EVERY agent (chat, orchestrator, and sub-agents). Read them. They are NOT optional, and several have caused real production incidents in this codebase.

## RULE 1 — Never emit a contiguous open/close pair of the model's hidden-reasoning XML tag

The runtime hosting this extension has a pre-processing layer that SILENTLY STRIPS any block bounded by an opening hidden-reasoning tag (the ${t('thinking')}-style tag the model uses for its private scratchpad) and its matching close tag, BEFORE the tool-call parser sees it. The strip happens regardless of context — prose, JSDoc, regex literals, the body of a ${t('diff')} or ${t('content')} parameter, a string you mean to write verbatim into a file. In every case the bytes between (and sometimes including) the open/close pair are deleted, so a SEARCH/REPLACE diff frame, a JSON tool argument, or a literal file body that contains them ends up MALFORMED — and your tool call then fails silently, with no output. Symptom: the agent appears to "freeze" mid-task.

WHAT TO DO INSTEAD:
- In runtime CODE: build the tag from string concatenation (e.g. ${"`'<' + 'thinking>'`"}), as the canonical exemplar HR_OPEN/HR_CLOSE in src/orchestrator.ts already does. Never write the contiguous literal in source.
- In PROSE / comments / explanations: paraphrase. Use phrases like "hidden-reasoning blocks", "scratchpad XML", "the model's private reasoning tag". Never write the literal contiguous tag pair.
- In TEST FIXTURES / EXAMPLES: split the token at any letter inside the word ("<thi" + "nking>") so the source never contains a contiguous match.
- In TOOL ARGUMENTS (write_file content, replace_in_file diff): if the content you intend to produce would contain the contiguous pair, REWORD or split it before emitting the tool call. Inspect your output for the literal sequence first.

DETECTING you've been bitten: a replace_in_file that returns "No SEARCH/REPLACE blocks were parsed" or "reached end of diff without a +++++++ REPLACE end-marker" while the diff LOOKS structurally correct — search the diff for the contiguous tag pair before retrying. A tool call with no result at all (apparent freeze) — same diagnosis.

## RULE 2 — Final turn must contain real prose outside any hidden-reasoning block

This applies most strictly to delegated sub-agents (whose final turn IS their report to the orchestrator), but it also applies to every agent's last turn before yielding to the user.

Hidden-reasoning blocks are STRIPPED before delivery to the orchestrator (and rendered to the user only in a separate THINKING panel). If your final turn contains ONLY a scratchpad/thinking-style block, only whitespace, or fewer than ~40 characters of real prose outside any hidden-reasoning tag, the runtime treats your turn as "no report produced" and will nudge you up to 3 times before recording a partial-success degraded outcome. Never end on "Let me read…" / "Next I will…" without actually emitting that next tool call. For sub-agent final reports, aim for 100–600 words: a one-line restatement of the task, a list of actions taken, findings with concrete file:line references, and any caveats.

## RULE 3 — Batch all edits to one file in a single replace_in_file call

The ${t('diff')} body of replace_in_file accepts an UNLIMITED number of stacked SEARCH/REPLACE blocks in file order. Use them. A separate replace_in_file invocation per edit is slow, requires a separate approval per call, clutters the chat, and is a frequent source of self-reinforcing failure loops (each failed individual call wastes one round). One call with N blocks = correct. N calls with one block each = wrong.

## RULE 4 — write_file is for new files or full rewrites only

For ANY localized edit to an existing file (rename, bug fix, insert function, change a few lines), use replace_in_file (or insert_in_file for anchorless insertion). Re-emitting an entire existing file to change ten lines wastes tokens, slows the user, risks data loss, and the runtime ENFORCES this with a >50%-line-overlap rejection guard — write_file calls that look like they should have been replace_in_file are rejected with a "REJECTED" message and you'll lose the round.

## RULE 5 — Verify file contents after large writes

If a write_file or replace_in_file involved a body larger than ~50 lines, follow it up with a cheap read-back check: \`wc -l\` (line count), \`grep\` (a sentinel string you expect to be present), or read_file_range over a known region. RULE 1's silent stripping plus the parser's tolerance for orphan tags means some classes of corruption are NOT loud — only an explicit re-read catches them. The atomic-write helper in this extension guarantees atomic-or-fail at the byte level, but it cannot detect semantic corruption (e.g. a stripped tag pair that left your file syntactically valid but missing a function body).
`;
}
/** Human-friendly content summary that matches `wc -l` semantics
 *  (counts newline characters, not split-array entries) and explicitly
 *  flags files lacking a trailing newline so the model can verify
 *  edits with `wc -l` without confusion. See FLAWS #1, #2. */
function summarizeContent(content) {
    const bytes = Buffer.byteLength(content, 'utf8');
    if (content.length === 0) {
        return `0 lines, 0 bytes`;
    }
    const newlines = (content.match(/\n/g) || []).length;
    const hasTrailingNewline = content.endsWith('\n');
    // wc -l counts newlines. An unterminated final line is conventionally
    // a "line" to a human reader but wc -l does not count it. Report the
    // wc -l-compatible number and annotate the missing terminator.
    const wcLines = newlines;
    const lineWord = wcLines === 1 ? 'line' : 'lines';
    const tail = hasTrailingNewline ? '' : ' (no final newline)';
    return `${wcLines} ${lineWord}${tail}, ${bytes} bytes`;
}
/** Soft, non-blocking portability check for newly-created paths.
 *  Returns a short note to append to the success message, or '' if clean.
 *  See FLAW #8. */
function portabilityNote(filePath) {
    const base = path.basename(filePath);
    // Portable POSIX filename charset: alnum, dot, underscore, hyphen.
    // Everything else is allowed but flagged.
    const nonPortable = /[^A-Za-z0-9._-]/.test(base);
    if (!nonPortable) { return ''; }
    const offenders = [...new Set(base.match(/[^A-Za-z0-9._-]/g) || [])].join('');
    return ` [note: filename contains non-portable characters "${offenders}" — may not survive on FAT/exFAT or some archive formats]`;
}
function formatFilePreview(filePath, content) {
    return `Current on-disk content of ${filePath} (${summarizeContent(content)}):\n` +
        `--- BEGIN FILE ---\n${filePreview(content)}\n--- END FILE ---`;
}
/** TOCTOU guard: re-stat `filePath` against the mtime captured at read time
 *  and reject if it changed externally. `opName` is the verb in the message. */
async function checkMtimeUnchanged(filePath, mtimeAtRead, opName) {
    try {
        const mtimeNow = (await withDeadline(fs.promises.stat(filePath), TOOL_OP_TIMEOUT_MS, 'stat')).mtimeMs;
        if (mtimeNow !== mtimeAtRead) {
            return {
                ok: false,
                result: {
                    success: false,
                    output: `REJECTED: file ${filePath} was modified externally between read and write ` +
                        `(mtime changed from ${new Date(mtimeAtRead).toISOString()} to ${new Date(mtimeNow).toISOString()}). ` +
                        `Re-read the file and retry — your ${opName} would have clobbered the external change.`,
                },
            };
        }
    }
    catch { /* file vanished — caller proceeds and surfaces real error */ }
    return { ok: true };
}
/** Wrap `writeFileAtomic` with the standard `<opName> failed: <msg>` error
 *  formatting so each call site collapses to one line. */
async function tryWriteAtomic(filePath, content, opName) {
    try {
        await writeFileAtomic(filePath, content);
        return { ok: true };
    }
    catch (writeErr) {
        return {
            ok: false,
            result: {
                success: false,
                output: `${opName} failed: ${errMsg(writeErr)}`,
            },
        };
    }
}
/** Resolve a (possibly relative) path against the VS Code workspace.
 *  Tries absolute → existing-in-each-workspace-folder → cwd → first workspace folder. */
export function resolveWorkspacePath(filePath) {
    if (!filePath) {
        return filePath;
    }
    let p = filePath;
    if (p === '~' || p.startsWith('~/')) {
        const home = process.env['HOME'] || process.env['USERPROFILE'] || '';
        if (home) {
            p = path.join(home, p.slice(p === '~' ? 1 : 2));
        }
    }
    if (path.isAbsolute(p)) {
        return p;
    }
    const workspaceFolders = vscode.workspace.workspaceFolders;
    const candidates = [];
    if (workspaceFolders && workspaceFolders.length > 0) {
        for (const f of workspaceFolders) {
            candidates.push(path.join(f.uri.fsPath, p));
        }
    }
    try {
        candidates.push(path.resolve(p));
    }
    catch { /* ignore */ }
    for (const c of candidates) {
        try {
            // Sync existence check retained here: resolveWorkspacePath is called
            // synchronously from many sites and the cost is a single stat per
            // candidate. Async would require a wide refactor of all callers.
            if (fs.existsSync(c)) {
                return c;
            }
        }
        catch { /* ignore */ }
    }
    // Fall back to the first workspace folder so writes land somewhere sensible.
    if (workspaceFolders && workspaceFolders.length > 0) {
        return path.join(workspaceFolders[0].uri.fsPath, p);
    }
    return path.resolve(p);
}

// ---------------------------------------------------------------------------
// Per-sub-agent terminal registry.
//
// Every delegated sub-agent that calls execute_command gets its OWN
// terminal — sub-agents NEVER share a terminal with siblings or with the
// main session. Rationale: VS Code shell-integration's `executeCommand`
// serializes commands per-terminal; with a shared terminal a second
// sub-agent's command silently queues behind the first, the no-output
// watchdog mis-resolves it as `(command produced no output)`, and the
// agent reasons from a fake success. Per-agent terminals make the bug
// physically impossible. Terminals are reaped via `disposeAgentTerminal`
// from the orchestrator's `runSubAgent` exit path so they don't leak
// across runs.
// ---------------------------------------------------------------------------
const subAgentTerminals: Map<string, vscode.Terminal> = new Map();

export function disposeAgentTerminal(agentId: string): void {
    const t = subAgentTerminals.get(agentId);
    if (!t) { return; }
    subAgentTerminals.delete(agentId);
    try { t.dispose(); } catch { /* ignore — terminal may already be gone */ }
}

export async function executeTool(name, args, signal, ctx?) {
    try {
        switch (name) {
            case 'read_file': {
                const filePath = resolveWorkspacePath(String(args['path'] || ''));
                // Use a single stat() with explicit errno dispatch instead of a
                // pathExists() pre-check: pathExists swallows ELOOP / EACCES /
                // ENAMETOOLONG and surfaces them all as "File not found", which
                // misleads the agent (e.g. a circular symlink chain shouldn't
                // look identical to a missing file).
                let stat;
                try {
                    stat = await withDeadline(fs.promises.stat(filePath), TOOL_OP_TIMEOUT_MS, 'stat');
                } catch (e) {
                    const code = (e && typeof e === 'object' && 'code' in e) ? (e as NodeJS.ErrnoException).code : undefined;
                    if (code === 'ENOENT') {
                        return { success: false, output: `File not found: ${filePath}` };
                    }
                    if (code === 'ELOOP') {
                        return { success: false, output: `Circular symlink chain at: ${filePath}` };
                    }
                    if (code === 'EACCES' || code === 'EPERM') {
                        return { success: false, output: `Permission denied: ${filePath}` };
                    }
                    if (code === 'ENAMETOOLONG') {
                        return { success: false, output: `Path too long: ${filePath}` };
                    }
                    return { success: false, output: `Cannot stat ${filePath}: ${errMsg(e)}` };
                }
                // Friendly errors for non-regular-file targets — readFile would
                // otherwise throw a raw EISDIR / EINVAL that the agent then has
                // to decode. Catching here gives an actionable message.
                if (stat.isDirectory()) {
                    return {
                        success: false,
                        output: `Path is a directory, not a file: ${filePath}. Use list_files to view its contents.`,
                    };
                }
                if (!stat.isFile()) {
                    return {
                        success: false,
                        output: `Path is not a regular file (likely a socket, FIFO, or device): ${filePath}`,
                    };
                }
                if (stat.size > 2 * 1024 * 1024) {
                    return { success: false, output: `File too large (${Math.round(stat.size / 1024)}KB). Max 2MB.` };
                }
                // Binary-content guard. Reading as utf8 directly silently maps
                // every invalid byte to U+FFFD, so a binary file looks like
                // garbled text with no warning — agents have parsed that as
                // real content. Read as Buffer first, reject on null bytes
                // (strong binary signal), then strict-decode UTF-8.
                const buf = await withDeadline(fs.promises.readFile(filePath), TOOL_OP_TIMEOUT_MS, 'read');
                if (buf.indexOf(0) >= 0) {
                    return {
                        success: false,
                        output: `File appears to be binary (contains null bytes): ${filePath} (${stat.size} bytes). ` +
                            `read_file only supports text. Use execute_command with tools like 'file', 'hexdump -C | head', ` +
                            `or 'strings' to inspect binary content.`,
                    };
                }
                let content;
                try {
                    content = new TextDecoder('utf-8', { fatal: true }).decode(buf);
                } catch {
                    return {
                        success: false,
                        output: `File is not valid UTF-8: ${filePath} (${stat.size} bytes). ` +
                            `It may be binary, or use a non-UTF-8 encoding (Latin-1, UTF-16, etc.). ` +
                            `read_file only supports UTF-8 text.`,
                    };
                }
                const header = `// File: ${filePath} (${summarizeContent(content)})\n`;
                return { success: true, output: header + content };
            }
            // write_file is for new files / full rewrites ONLY; small edits
            // must use replace_in_file. Enforced by the >50%-overlap guard below.
            case 'write_file': {
                const filePath = resolveWorkspacePath(String(args['path'] || ''));
                const content = String(args['content'] || '');
                // Read old content for diff + capture mtime for TOCTOU guard below.
                let oldContent = '';
                let isNewFile = true;
                let mtimeAtRead = 0;
                if (await pathExists(filePath)) {
                    try {
                        oldContent = await withDeadline(fs.promises.readFile(filePath, 'utf8'), TOOL_OP_TIMEOUT_MS, 'read');
                        mtimeAtRead = (await withDeadline(fs.promises.stat(filePath), TOOL_OP_TIMEOUT_MS, 'stat')).mtimeMs;
                        isNewFile = false;
                    }
                    catch { /* ignore */ }
                }
                // Guard: SEARCH/REPLACE markers in content mean the model meant replace_in_file.
                if (/^\s*-{3,}\s*SEARCH\b/m.test(content) ||
                    /^\s*\+{3,}\s*REPLACE\b/m.test(content)) {
                    return {
                        success: false,
                        output: `REJECTED: write_file content contains SEARCH/REPLACE markers ` +
                            `(------- SEARCH / +++++++ REPLACE). These are diff markers, NOT ` +
                            `valid file content. You almost certainly meant to call replace_in_file ` +
                            `instead of write_file.\n\n` +
                            `Retry using the replace_in_file tool with the SEARCH/REPLACE blocks ` +
                            `passed in its <diff> parameter — not write_file's <content>. The <diff> ` +
                            `parameter of replace_in_file is where SEARCH/REPLACE blocks belong; ` +
                            `write_file's <content> must be the literal final file body with no diff syntax.`,
                    };
                }
                // Short-circuit: identical content → no-op success
                if (!isNewFile && oldContent === content) {
                    return {
                        success: true,
                        output: `No changes needed for ${filePath} — content is already identical.`,
                        diffData: { filePath, isNewFile: false, oldContent, newContent: content },
                    };
                }
                // Guard: refuse rewrites with mostly-unchanged content; force replace_in_file
                // for small edits. Bypass via _force=true for genuine large rewrites.
                // Skip overlap check for very small files (under 20 lines).
                if (!isNewFile && args['_force'] !== true && oldContent.length > 0) {
                    const oldLines = oldContent.split('\n');
                    if (oldLines.length < 20) {
                        // Small file — skip overlap guard, allow write_file
                    }
                    else {
                        const newLines = content.split('\n');
                        const oldSet = new Map();
                        for (const line of oldLines) {
                            oldSet.set(line, (oldSet.get(line) || 0) + 1);
                        }
                        let unchanged = 0;
                        for (const line of newLines) {
                            const c = oldSet.get(line) || 0;
                            if (c > 0) {
                                unchanged++;
                                oldSet.set(line, c - 1);
                            }
                        }
                        const minLines = Math.max(oldLines.length, newLines.length, 1);
                        const overlap = unchanged / minLines;
                        // >50% identical lines = small edit pretending to be a rewrite → reject.
                        if (overlap > 0.5 && oldLines.length >= 5) {
                            return {
                                success: false,
                                output: `REJECTED: write_file is FORBIDDEN for editing existing files when most of the content is unchanged ` +
                                    `(here ~${Math.round(overlap * 100)}% of lines are identical to the on-disk content).\n\n` +
                                    `You MUST use the replace_in_file tool with SEARCH/REPLACE blocks to make this edit. ` +
                                    `The SEARCH text must match the file EXACTLY (whitespace included). For multiple changes, ` +
                                    `emit multiple SEARCH/REPLACE blocks in file order in a single replace_in_file call.\n\n` +
                                    `${formatFilePreview(filePath, oldContent)}\n\n` +
                                    `Now retry the edit using replace_in_file with precise SEARCH/REPLACE blocks targeting only ` +
                                    `the lines that need to change.`,
                            };
                        }
                    } // end of oldLines.length >= 20 else-block
                }
                const dir = path.dirname(filePath);
                if (!(await pathExists(dir))) {
                    await withDeadline(fs.promises.mkdir(dir, { recursive: true }), TOOL_OP_TIMEOUT_MS, 'mkdir');
                }
                // TOCTOU guard: refuse if file changed externally between read and write.
                if (!isNewFile) {
                    const mtimeCheck = await checkMtimeUnchanged(filePath, mtimeAtRead, 'write');
                    if (!mtimeCheck.ok) {
                        return mtimeCheck.result;
                    }
                }
                // Persist FULL content to disk (atomic temp+rename).
                const writeRes = await tryWriteAtomic(filePath, content, 'write_file');
                if (!writeRes.ok) {
                    return writeRes.result;
                }
                const action = isNewFile ? 'Created' : 'Updated';
                const note = isNewFile ? portabilityNote(filePath) : '';
                return {
                    success: true,
                    output: `${action} ${filePath} (${summarizeContent(content)})${note}`,
                    diffData: { filePath, isNewFile, oldContent, newContent: content },
                };
            }
            case 'replace_in_file': {
                const filePath = resolveWorkspacePath(String(args['path'] || ''));
                const diff = String(args['diff'] || '');
                if (!(await pathExists(filePath))) {
                    return { success: false, output: `File not found: ${filePath}` };
                }
                // Capture mtime for TOCTOU guard checked just before writeFileAtomic below.
                const oldContent = await withDeadline(fs.promises.readFile(filePath, 'utf8'), TOOL_OP_TIMEOUT_MS, 'read');
                const mtimeAtRead = (await withDeadline(fs.promises.stat(filePath), TOOL_OP_TIMEOUT_MS, 'stat')).mtimeMs;
                const { blocks, warnings } = parseSearchReplaceBlocksEx(diff);
                const warnText = warnings.length > 0
                    ? `\n\nPARSE WARNINGS (these likely indicate a malformed diff body):\n` +
                        warnings.map(w => `  - ${w}`).join('\n')
                    : '';
                // Refuse to apply a diff the parser flagged as malformed instead
                // of writing a partially-parsed (corrupting) result. Loud refusal
                // beats silent data loss — this is the failure mode where a block
                // is truncated by a stray marker-looking line inside its content.
                if (warnings.length > 0) {
                    return {
                        success: false,
                        output: `replace_in_file REFUSED: the <diff> body is malformed and was NOT applied (nothing written to disk).` + warnText + `\n\nThis usually means a SEARCH/REPLACE block was not closed properly, or a line that looks like a frame marker (the SEARCH start marker, a bare separator line of seven equals signs, or the REPLACE end marker) appears INSIDE your SEARCH or REPLACE content where the parser reads it as a boundary. Re-anchor each SEARCH to surrounding context with no bare marker line, give every block all three markers each on its own line, then retry.`,
                    };
                }
                if (blocks.length === 0) {
                    return {
                        success: false,
                        output: `No SEARCH/REPLACE blocks were parsed from the <diff> body. The diff parameter ` +
                            `MUST consist of one or more blocks in this EXACT format (each marker on its own line):\n\n` +
                            `------- SEARCH\n<exact text from the file>\n=======\n<replacement text>\n+++++++ REPLACE\n\n` +
                            `Common mistakes:\n` +
                            `  - Putting the SEARCH/REPLACE blocks inside <content> of write_file (wrong: use <diff> of replace_in_file).\n` +
                            `  - Wrapping the diff in markdown code fences (\`\`\`).\n` +
                            `  - Mixing the marker syntax with extra prose.\n` +
                            `  - A literal '=======' or '------- SEARCH' line INSIDE your SEARCH/REPLACE content (it is read as a marker). ` +
                            `If you must match such a line, narrow the SEARCH to surrounding context that does not contain a bare marker line.` +
                            warnText + `\n\n` +
                            `${formatFilePreview(filePath, oldContent)}\n\n` +
                            `Re-emit a replace_in_file call where the <diff> tag body contains ONLY the marker blocks above.`,
                    };
                }
                let newContent;
                try {
                    const r = applySearchReplaceBlocks(oldContent, blocks);
                    newContent = r.result;
                }
                catch (err) {
                    const oldLines = oldContent.split('\n');
                    const preview = filePreview(oldContent);
                    const failBlock = err instanceof SearchReplaceApplyError ? err.blockIndex + 1 : undefined;
                    const appliedSoFar = err instanceof SearchReplaceApplyError ? err.appliedCount : undefined;
                    const detail = failBlock !== undefined
                        ? `Block #${failBlock} is the one that failed; ${appliedSoFar} earlier block(s) matched. ` +
                            `NOTE: nothing was written to disk — the edit is all-or-nothing, so the file is UNCHANGED. ` +
                            `Do NOT assume the earlier blocks landed; re-send the FULL corrected diff.\n\n`
                        : '';
                    return {
                        success: false,
                        output: `replace_in_file failed: ${errMsg(err)}\n\n` +
                            detail +
                            `The SEARCH text must match the file EXACTLY — every byte, including whitespace, ` +
                            `tabs vs spaces, and trailing newlines (a tolerant trailing-whitespace/CRLF match was ` +
                            `also attempted and still missed). Below is the CURRENT on-disk content of ` +
                            `${filePath} (${oldLines.length} lines). Copy exact substrings from THIS content as ` +
                            `your SEARCH text.` + warnText + `\n\n` +
                            `--- BEGIN FILE ---\n${preview}\n--- END FILE ---\n\n` +
                            `Now retry replace_in_file with corrected SEARCH/REPLACE blocks.`,
                    };
                }
                // Complete no-op: every block already applied → success without rewriting.
                if (newContent === oldContent) {
                    return {
                        success: true,
                        output: `No changes needed for ${filePath} — all ${blocks.length} block(s) were already ` +
                            `applied (the file already matches the desired state).` + warnText,
                        diffData: { filePath, isNewFile: false, oldContent, newContent },
                    };
                }
                // TOCTOU guard: refuse if file changed externally; SEARCH blocks
                // would have been validated against stale content.
                const mtimeCheck = await checkMtimeUnchanged(filePath, mtimeAtRead, 'edit');
                if (!mtimeCheck.ok) {
                    return mtimeCheck.result;
                }
                // Persist newContent to disk (atomic).
                const writeRes = await tryWriteAtomic(filePath, newContent, 'replace_in_file');
                if (!writeRes.ok) {
                    return writeRes.result;
                }
                const oldLines = oldContent.split('\n').length;
                const newLines = newContent.split('\n').length;
                const summary = `Applied ${blocks.length} edit${blocks.length === 1 ? '' : 's'} ` +
                    `to ${filePath} (${oldLines} → ${newLines} lines)`;
                return {
                    success: true,
                    output: summary,
                    diffData: { filePath, isNewFile: false, oldContent, newContent },
                };
            }
            case 'insert_in_file': {
                const filePath = resolveWorkspacePath(String(args['path'] || ''));
                const insertText = String(args['content'] || '');
                if (!(await pathExists(filePath))) {
                    return {
                        success: false,
                        output: `File not found: ${filePath}. Use write_file to create a new file.`,
                    };
                }
                const oldContent = await withDeadline(fs.promises.readFile(filePath, 'utf8'), TOOL_OP_TIMEOUT_MS, 'read');
                const mtimeAtRead = (await withDeadline(fs.promises.stat(filePath), TOOL_OP_TIMEOUT_MS, 'stat')).mtimeMs;
                const rawLine = Number(args['line']);
                const oldLines = oldContent.split('\n');
                // FLAW #7 fix: a file ending in '\n' splits into [..., ''] —
                // a trailing empty element. Naïve slice/concat here pushed the
                // inserted text past that empty element, producing phantom
                // blank lines on append. Compute a "logical" line count that
                // ignores that trailing sentinel, and at append time go via
                // the byte content instead of the split array so the result
                // is well-formed regardless of whether the file ended in \n.
                const fileEndsWithNewline = oldContent.endsWith('\n');
                const logicalLineCount = (oldContent === '')
                    ? 0
                    : (fileEndsWithNewline ? oldLines.length - 1 : oldLines.length);
                const insertLines = insertText.split('\n');
                let newContent;
                let idx;
                if (!Number.isFinite(rawLine) || rawLine <= 0 || rawLine > logicalLineCount) {
                    // APPEND: ensure file ends in '\n', append insertText, ensure result ends in '\n'.
                    idx = logicalLineCount;
                    let prefix = oldContent;
                    if (prefix.length > 0 && !prefix.endsWith('\n')) { prefix += '\n'; }
                    let suffix = insertText;
                    if (suffix.length > 0 && !suffix.endsWith('\n')) { suffix += '\n'; }
                    newContent = prefix + suffix;
                } else {
                    idx = Math.floor(rawLine) - 1;
                    const newLines = [...oldLines.slice(0, idx), ...insertLines, ...oldLines.slice(idx)];
                    newContent = newLines.join('\n');
                }
                if (newContent === oldContent) {
                    return {
                        success: true,
                        output: `No change to ${filePath} (nothing to insert).`,
                        diffData: { filePath, isNewFile: false, oldContent, newContent },
                    };
                }
                // TOCTOU guard (mirror write_file/replace_in_file).
                const mtimeCheck = await checkMtimeUnchanged(filePath, mtimeAtRead, 'insert');
                if (!mtimeCheck.ok) {
                    return mtimeCheck.result;
                }
                const writeRes = await tryWriteAtomic(filePath, newContent, 'insert_in_file');
                if (!writeRes.ok) {
                    return writeRes.result;
                }
                const insertedCount = insertLines.filter((l, i) => l !== '' || i < insertLines.length - 1).length || insertLines.length;
                return {
                    success: true,
                    output: `Inserted ${insertedCount} line${insertedCount === 1 ? '' : 's'} into ${filePath} ` +
                        `at line ${idx + 1} (${summarizeContent(oldContent)} → ${summarizeContent(newContent)})`,
                    diffData: { filePath, isNewFile: false, oldContent, newContent },
                };
            }
            case 'delete_file': {
                const filePath = resolveWorkspacePath(String(args['path'] || ''));
                if (!(await pathExists(filePath))) {
                    return { success: false, output: `File not found: ${filePath}` };
                }
                const stat = await withDeadline(fs.promises.stat(filePath), TOOL_OP_TIMEOUT_MS, 'stat');
                if (stat.isDirectory()) {
                    return {
                        success: false,
                        output: `REJECTED: ${filePath} is a directory. delete_file only deletes files. ` +
                            `Use execute_command (e.g. rm -rf) for directory removal.`,
                    };
                }
                let removedLines = 0;
                try {
                    removedLines = (await withDeadline(fs.promises.readFile(filePath, 'utf8'), TOOL_OP_TIMEOUT_MS, 'read')).split('\n').length;
                }
                catch { /* binary or unreadable */ }
                try {
                    await withDeadline(fs.promises.unlink(filePath), TOOL_OP_TIMEOUT_MS, 'unlink');
                }
                catch (delErr) {
                    return {
                        success: false,
                        output: `delete_file failed: ${errMsg(delErr)}`,
                    };
                }
                return {
                    success: true,
                    output: `Deleted ${filePath}${removedLines ? ` (${removedLines} lines removed)` : ''}`,
                };
            }
            case 'move_file': {
                const source = resolveWorkspacePath(String(args['source'] || ''));
                const destination = resolveWorkspacePath(String(args['destination'] || ''));
                if (!source || !destination) {
                    return { success: false, output: `move_file requires both 'source' and 'destination'.` };
                }
                if (!(await pathExists(source))) {
                    return { success: false, output: `Source not found: ${source}` };
                }
                if (await pathExists(destination)) {
                    return {
                        success: false,
                        output: `REJECTED: destination already exists: ${destination}. move_file never overwrites — ` +
                            `delete or rename the destination first if you really intend to replace it.`,
                    };
                }
                const destDir = path.dirname(destination);
                if (!(await pathExists(destDir))) {
                    await withDeadline(fs.promises.mkdir(destDir, { recursive: true }), TOOL_OP_TIMEOUT_MS, 'mkdir');
                }
                try {
                    await withDeadline(fs.promises.rename(source, destination), TOOL_OP_TIMEOUT_MS, 'rename');
                }
                catch (renameErr) {
                    // Cross-device move (EXDEV): fall back to copy + unlink for files.
                    try {
                        const stat = await withDeadline(fs.promises.stat(source), TOOL_OP_TIMEOUT_MS, 'stat');
                        if (stat.isFile()) {
                            await withDeadline(fs.promises.copyFile(source, destination), TOOL_OP_TIMEOUT_MS, 'copy');
                            await withDeadline(fs.promises.unlink(source), TOOL_OP_TIMEOUT_MS, 'unlink');
                        }
                        else {
                            return {
                                success: false,
                                output: `move_file failed (cross-device directory move unsupported): ${errMsg(renameErr)}`,
                            };
                        }
                    }
                    catch (fallbackErr) {
                        return {
                            success: false,
                            output: `move_file failed: ${errMsg(fallbackErr)}`,
                        };
                    }
                }
                return { success: true, output: `Moved ${source} → ${destination}${portabilityNote(destination)}` };
            }
            case 'execute_command': {
                const command = String(args['command'] || '');
                const cwd = args['cwd']
                    ? resolveWorkspacePath(String(args['cwd']))
                    : (vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd());
                const timeout = clampInt(args['timeout_ms'], EXEC_TIMEOUT_MIN_MS, EXEC_TIMEOUT_MAX_MS, EXEC_TIMEOUT_DEFAULT_MS);
                // Honor a pre-tripped abort before spinning up a terminal/SI probe.
                if (signal?.aborted) {
                    return { success: false, output: 'execute_command aborted before start' };
                }
                // Sub-agent (ctx.agentId set) → dedicated per-agent terminal,
                // looked up in `subAgentTerminals` registry. Main session →
                // shared 'QGenie Agent' terminal as before. This is the fix
                // for the parallel-sub-agent shared-terminal queueing bug
                // documented at the registry definition above.
                const subAgentId = ctx && typeof ctx.agentId === 'string' && ctx.agentId
                    ? ctx.agentId
                    : undefined;
                const termName = subAgentId ? `QGenie · sub-${subAgentId}` : 'QGenie Agent';
                let terminal;
                if (subAgentId) {
                    terminal = subAgentTerminals.get(subAgentId);
                    if (terminal && terminal.exitStatus) {
                        // Stale entry (user closed the terminal manually, or
                        // it crashed). Drop and recreate.
                        subAgentTerminals.delete(subAgentId);
                        terminal = undefined;
                    }
                } else {
                    terminal = vscode.window.terminals.find(t => t.name === termName && !t.exitStatus);
                }
                const justCreated = !terminal;
                if (!terminal) {
                    terminal = vscode.window.createTerminal({ name: termName, cwd });
                    if (subAgentId) {
                        subAgentTerminals.set(subAgentId, terminal);
                    }
                }
                terminal.show(true);
                // Strategy A: VS Code shell integration (preferred when available).
                const waitForShellIntegration = (ms) => {
                    const initial = terminal.shellIntegration;
                    if (initial) {
                        return Promise.resolve(initial);
                    }
                    return new Promise((resolve) => {
                        const handle = setTimeout(() => { try {
                            disp.dispose();
                        }
                        catch { /* ignore */ } resolve(undefined); }, ms);
                        const onChange = vscode.window.onDidChangeTerminalShellIntegration;
                        if (!onChange) {
                            clearTimeout(handle);
                            resolve(undefined);
                            return;
                        }
                        const disp = onChange((e) => {
                            if (e.terminal === terminal && e.shellIntegration) {
                                clearTimeout(handle);
                                disp.dispose();
                                resolve(e.shellIntegration);
                            }
                        });
                    });
                };
                const si = (await waitForShellIntegration(justCreated ? 3000 : 200));
                // Without onDidEndTerminalShellExecution, Strategy A would only resolve via timeout
                // (the "commands get stuck" bug). When missing, fall through to Strategy B.
                const hasEndEvent = typeof vscode.window.onDidEndTerminalShellExecution === 'function';
                if (si && typeof si.executeCommand === 'function' && hasEndEvent) {
                    return new Promise((resolve) => {
                        const execution = si.executeCommand(command);
                        let output = '';
                        let finished = false;
                        const hasEndEvent = typeof vscode.window.onDidEndTerminalShellExecution === 'function';
                        // Idle-output watchdog: some shells drop the end event. Resolve once stdout
                        // has been quiet for IDLE_MS, or after NO_OUTPUT_GRACE_MS for silent commands.
                        // When onDidEndTerminalShellExecution is available, use much longer idle
                        // thresholds because compound commands (&&) can have multi-second gaps
                        // between sub-commands. The end event is the reliable signal in that case.
                        const IDLE_MS = hasEndEvent ? 12000 : 1500;
                        const NO_OUTPUT_GRACE_MS = hasEndEvent ? 15000 : 2500;
                        const startedAt = Date.now();
                        let lastChunkAt = Date.now();
                        let sawOutput = false;
                        // cleanup() removes this so the AbortSignal doesn't pin the closure
                        // after the command resolves.
                        let onAbort;
                        const cleanup = () => {
                            clearTimeout(timeoutHandle);
                            clearInterval(idleHandle);
                            try {
                                onEndDisp.dispose();
                            }
                            catch { /* ignore */ }
                            if (signal && onAbort) {
                                try {
                                    signal.removeEventListener('abort', onAbort);
                                }
                                catch { /* ignore */ }
                            }
                        };
                        const timeoutHandle = setTimeout(() => {
                            if (finished) {
                                return;
                            }
                            finished = true;
                            cleanup();
                            resolve({
                                success: false,
                                output: `Exit code: -1 (timeout after ${timeout}ms)\n${output || '(command produced no output before timing out)'}`,
                            });
                        }, timeout);
                        const idleHandle = setInterval(() => {
                            if (finished) {
                                return;
                            }
                            const now = Date.now();
                            // Case 1: saw output, quiet for IDLE_MS. Case 2: never saw output, grace elapsed.
                            const quietAfterOutput = sawOutput && now - lastChunkAt >= IDLE_MS;
                            const silentComplete = !sawOutput && now - startedAt >= NO_OUTPUT_GRACE_MS;
                            if (quietAfterOutput || silentComplete) {
                                finished = true;
                                cleanup();
                                const cleaned = cleanTerminalOutput(output);
                                // Don't surface "resolved on idle" to the model — the agent used to misread
                                // it as failure and retry. Use explicit "(command produced no output)" marker.
                                resolve({
                                    success: true,
                                    output: `Exit code: 0\n${cleaned.trim() || '(command produced no output)'}`,
                                });
                            }
                        }, 250);
                        (async () => {
                            try {
                                const stream = execution.read?.();
                                if (stream) {
                                    for await (const chunk of stream) {
                                        output += String(chunk);
                                        sawOutput = true;
                                        lastChunkAt = Date.now();
                                    }
                                }
                            }
                            catch { /* ignore — exit handler still fires */ }
                        })();
                        const onEndApi = vscode.window.onDidEndTerminalShellExecution;
                        const onEndDisp = typeof onEndApi === 'function'
                            ? onEndApi((e) => {
                                if (e.execution !== execution || finished) {
                                    return;
                                }
                                finished = true;
                                cleanup();
                                const exitCode = typeof e.exitCode === 'number' ? e.exitCode : 0;
                                const cleaned = cleanTerminalOutput(output);
                                resolve({
                                    success: exitCode === 0,
                                    output: `Exit code: ${exitCode}\n${cleaned.trim() || '(command produced no output)'}`,
                                });
                            })
                            : { dispose: () => { } };
                        // Stop button under Strategy A: we can't kill the underlying process (no PID
                        // via shell-integration), so we just resolve as cancelled and let it run.
                        onAbort = () => {
                            if (finished) {
                                return;
                            }
                            finished = true;
                            cleanup();
                            const cleaned = cleanTerminalOutput(output);
                            resolve({
                                success: false,
                                output: `Exit code: -1 (aborted by user — shell integration cannot kill the underlying process)\n` +
                                    `${cleaned.trim() || '(no output captured before abort)'}`,
                            });
                        };
                        if (signal) {
                            if (signal.aborted) {
                                queueMicrotask(() => { onAbort?.(); });
                            }
                            else {
                                signal.addEventListener('abort', onAbort, { once: true });
                            }
                        }
                    });
                }
                // Strategy B: spawn() fallback when shell integration is unavailable.
                // Uses $SHELL, detached process group (kill whole tree), 2MB output cap, AbortSignal.
                try {
                    const preview = command.replace(/\r?\n/g, ' \\n ');
                    terminal.sendText(`# qgenie (no shell integration) → running: ${preview}`, false);
                }
                catch { /* ignore */ }
                return new Promise((resolve) => {
                    const isWin = process.platform === 'win32';
                    const userShell = process.env['SHELL']
                        || (isWin ? (process.env['ComSpec'] || 'cmd.exe') : '/bin/sh');
                    const shellArgs = isWin ? ['/c', command] : ['-c', command];
                    let child;
                    try {
                        // stdio[0]='ignore' so children reading stdin get EOF and don't hang;
                        // the cast is runtime-safe because we only ever touch stdout/stderr.
                        child = child_process.spawn(userShell, shellArgs, {
                            cwd,
                            detached: !isWin, // POSIX: own process group so we can `kill -PG`
                            stdio: ['ignore', 'pipe', 'pipe'],
                            env: process.env,
                        });
                    }
                    catch (spawnErr) {
                        resolve({
                            success: false,
                            output: `spawn error: ${errMsg(spawnErr)}`,
                        });
                        return;
                    }
                    const MAX_BUF = 2 * 1024 * 1024;
                    let stdoutBuf = '';
                    let stderrBuf = '';
                    let stdoutTrunc = false;
                    let stderrTrunc = false;
                    let resolved = false;
                    let onAbort;
                    let killEscalation;
                    let postKillFallback;
                    const killGroup = (sig) => {
                        if (!child.pid) {
                            return;
                        }
                        try {
                            if (isWin) {
                                child.kill(sig);
                            }
                            else {
                                process.kill(-child.pid, sig);
                            }
                        }
                        catch { /* already dead */ }
                    };
                    const cleanup = () => {
                        clearTimeout(timeoutHandle);
                        if (killEscalation) {
                            clearTimeout(killEscalation);
                        }
                        if (postKillFallback) {
                            clearTimeout(postKillFallback);
                        }
                        if (signal && onAbort) {
                            try {
                                signal.removeEventListener('abort', onAbort);
                            }
                            catch { /* ignore */ }
                        }
                    };
                    const composeOutput = () => {
                        const parts = [];
                        if (stdoutBuf) {
                            parts.push(`STDOUT:\n${cleanTerminalOutput(stdoutBuf).trimEnd()}` +
                                (stdoutTrunc ? '\n[STDOUT TRUNCATED at 2MB]' : ''));
                        }
                        if (stderrBuf) {
                            parts.push(`STDERR:\n${cleanTerminalOutput(stderrBuf).trimEnd()}` +
                                (stderrTrunc ? '\n[STDERR TRUNCATED at 2MB]' : ''));
                        }
                        return parts.join('\n\n') || '(command produced no output)';
                    };
                    const finish = (result) => {
                        if (resolved) {
                            return;
                        }
                        resolved = true;
                        cleanup();
                        resolve(result);
                    };
                    // Two-stage termination: SIGTERM, then SIGKILL after 2s. Force-resolve after
                    // 4s if `close` never fires so the agent loop never wedges.
                    const terminateGroup = (reason) => {
                        killGroup('SIGTERM');
                        killEscalation = setTimeout(() => killGroup('SIGKILL'), 2000);
                        postKillFallback = setTimeout(() => {
                            if (!resolved) {
                                finish({
                                    success: false,
                                    output: `Exit code: -1 (${reason} — process group killed; close event never arrived)\n${composeOutput()}`,
                                });
                            }
                        }, 4000);
                    };
                    const timeoutHandle = setTimeout(() => {
                        if (resolved) {
                            return;
                        }
                        terminateGroup(`timeout after ${timeout}ms`);
                    }, timeout);
                    const pipeData = (stream, getBuf, setBuf, getTrunc, setTrunc) => {
                        stream.on('data', (d) => {
                            if (getTrunc()) {
                                return;
                            }
                            const s = d.toString('utf8');
                            const remaining = MAX_BUF - getBuf().length;
                            if (s.length > remaining) {
                                setBuf(getBuf() + s.slice(0, remaining));
                                setTrunc();
                            }
                            else {
                                setBuf(getBuf() + s);
                            }
                        });
                    };
                    pipeData(child.stdout, () => stdoutBuf, v => { stdoutBuf = v; }, () => stdoutTrunc, () => { stdoutTrunc = true; });
                    pipeData(child.stderr, () => stderrBuf, v => { stderrBuf = v; }, () => stderrTrunc, () => { stderrTrunc = true; });
                    child.on('error', (err) => {
                        finish({
                            success: false,
                            output: `child process error: ${err.message}\n${composeOutput()}`,
                        });
                    });
                    child.on('close', (code, sig) => {
                        const exitCode = code !== null ? code : (sig ? -1 : 0);
                        const sigSuffix = sig ? ` (signal: ${sig})` : '';
                        finish({
                            success: exitCode === 0,
                            output: `Exit code: ${exitCode}${sigSuffix}\n${composeOutput()}`,
                        });
                    });
                    // Wire AbortSignal after the child is alive; abort kills the whole group.
                    // If already fired, defer to next microtask so spawn completes first.
                    if (signal) {
                        onAbort = () => {
                            if (resolved) {
                                return;
                            }
                            terminateGroup('aborted by user');
                        };
                        if (signal.aborted) {
                            queueMicrotask(() => { onAbort?.(); });
                        }
                        else {
                            signal.addEventListener('abort', onAbort, { once: true });
                        }
                    }
                });
            }
            case 'list_files': {
                const dirPath = resolveWorkspacePath(String(args['path'] || '.'));
                const recursive = Boolean(args['recursive']);
                const maxDepth = clampInt(args['max_depth'], LIST_MAX_DEPTH_MIN, LIST_MAX_DEPTH_MAX, LIST_MAX_DEPTH_DEFAULT);
                if (!(await pathExists(dirPath))) {
                    return { success: false, output: `Directory not found: ${dirPath}` };
                }
                const lines = [`Directory: ${dirPath}`];
                let fileCount = 0;
                async function walk(dir, depth, prefix) {
                    if (depth > maxDepth || fileCount > 500) {
                        return;
                    }
                    let entries;
                    try {
                        entries = await withDeadline(fs.promises.readdir(dir, { withFileTypes: true }), TOOL_OP_TIMEOUT_MS, 'readdir');
                    }
                    catch (e) {
                        // Surface the failure instead of silently dropping the directory.
                        lines.push(`${prefix}[error reading dir: ${dir}: ${errMsg(e)}]`);
                        return;
                    }
                    for (const entry of entries) {
                        if (entry.name.startsWith('.') && depth > 0) {
                            continue;
                        }
                        fileCount++;
                        const isDir = entry.isDirectory();
                        lines.push(`${prefix}${isDir ? '[D] ' : '    '}${entry.name}`);
                        if (recursive && isDir && depth < maxDepth) {
                            await walk(path.join(dir, entry.name), depth + 1, prefix + '  ');
                        }
                    }
                }
                await walk(dirPath, 0, '');
                if (fileCount >= 500) {
                    lines.push('... (truncated at 500 entries)');
                }
                return { success: true, output: lines.join('\n') };
            }
            case 'search_files': {
                const searchPath = resolveWorkspacePath(String(args['path'] || '.'));
                const pattern = String(args['pattern'] || '');
                const filePattern = args['file_pattern'] ? String(args['file_pattern']) : '';
                const contextLines = clampInt(args['context_lines'], SEARCH_CONTEXT_LINES_MIN, SEARCH_CONTEXT_LINES_MAX, SEARCH_CONTEXT_LINES_DEFAULT);
                // -s (--no-messages) suppresses warnings like "Permission denied"
                // on unreadable subdirs. Without this, grep recursing through
                // /tmp or any mixed-permission tree exits 2 with stderr noise
                // even when there are valid matches in the readable parts —
                // and we'd surface a fatal error instead of those matches.
                const grepArgs = ['-rns', `-C${contextLines}`];
                if (filePattern) {
                    grepArgs.push(`--include=${filePattern}`);
                }
                // '--' terminates option parsing so a pattern or path beginning
                // with '-' can never be misread by grep as an option.
                grepArgs.push('--', pattern, searchPath);
                return new Promise((resolve) => {
                    child_process.execFile('grep', grepArgs, { maxBuffer: 1024 * 1024, timeout: SEARCH_GREP_TIMEOUT_MS }, (err, stdout, stderr) => {
                        try {
                            // Timeout (execFile killed grep): return a success-shaped marker.
                            if (err && err.code === 'ETIMEDOUT') {
                                resolve({ success: true, output: '(search timed out)' });
                                return;
                            }
                            // grep exit codes: 0 = matches, 1 = no matches (both success);
                            // 2 = "errors encountered" (commonly: a path was unreadable). With
                            // the -s flag set we already suppressed stderr noise about it; if
                            // we ALSO got valid stdout, the matches we DO have are still good
                            // — surface them as a partial success rather than dropping every
                            // result because one subdir was unreadable. Only treat exit 2
                            // with empty stdout as a real error, and exit >=3 as always fatal.
                            const exitCode = err && typeof err.code === 'number' ? err.code : (err ? 1 : 0);
                            if (exitCode >= 3) {
                                const detail = stderr ? stderr.trim() : (err ? errMsg(err) : 'unknown grep error');
                                resolve({ success: false, output: `grep error (exit ${exitCode}): ${detail}` });
                                return;
                            }
                            if (exitCode === 2 && !stdout) {
                                const detail = stderr ? stderr.trim() : (err ? errMsg(err) : 'no readable paths');
                                resolve({ success: false, output: `grep error (exit 2): ${detail}` });
                                return;
                            }
                            // exit 2 with stdout: partial — annotate but keep results.
                            const partialNote = exitCode === 2
                                ? '\n(note: some paths were unreadable; results may be incomplete)'
                                : '';
                            if (err && !stdout && !stderr) {
                                resolve({ success: true, output: '(no matches found)' });
                                return;
                            }
                            const lines = stdout.split('\n');
                            const truncated = lines.length > 300;
                            const body = lines.slice(0, 300).join('\n');
                            const output = (truncated ? body + '\n... (truncated)' : body) + partialNote;
                            resolve({ success: true, output });
                        }
                        catch (cbErr) {
                            resolve({ success: false, output: `search_files internal error: ${errMsg(cbErr)}` });
                        }
                    });
                });
            }
            case 'get_workspace_info': {
                const folders = vscode.workspace.workspaceFolders?.map(f => ({
                    name: f.name,
                    path: f.uri.fsPath,
                })) || [];
                const activeEditor = vscode.window.activeTextEditor;
                const activeFile = activeEditor ? {
                    path: activeEditor.document.uri.fsPath,
                    language: activeEditor.document.languageId,
                    lines: activeEditor.document.lineCount,
                    isDirty: activeEditor.document.isDirty,
                } : null;
                const openFiles = vscode.workspace.textDocuments
                    .filter(d => !d.isUntitled && d.uri.scheme === 'file')
                    .map(d => d.uri.fsPath)
                    .slice(0, 30);
                const info = {
                    workspaceFolders: folders,
                    activeFile,
                    openFiles,
                    platform: process.platform,
                    shell: process.env['SHELL'] || 'unknown',
                };
                return { success: true, output: JSON.stringify(info, null, 2) };
            }
            case 'read_active_editor': {
                const editor = vscode.window.activeTextEditor;
                if (!editor) {
                    return { success: false, output: 'No active editor open' };
                }
                const selectionOnly = Boolean(args['selection_only']);
                const filePath = editor.document.uri.fsPath;
                const lang = editor.document.languageId;
                if (selectionOnly && !editor.selection.isEmpty) {
                    const text = editor.document.getText(editor.selection);
                    const startLine = editor.selection.start.line + 1;
                    return { success: true, output: `// ${filePath} (lines ${startLine}+, ${lang})\n${text}` };
                }
                const text = editor.document.getText();
                return { success: true, output: `// ${filePath} (${editor.document.lineCount} lines, ${lang})\n${text}` };
            }
            case 'get_file_info': {
                const filePath = resolveWorkspacePath(String(args['path'] || ''));
                if (!(await pathExists(filePath))) {
                    return { success: false, output: `File not found: ${filePath}` };
                }
                const stat = await withDeadline(fs.promises.stat(filePath), TOOL_OP_TIMEOUT_MS, 'stat');
                const isFile = stat.isFile();
                let lineCount = 0;
                if (isFile && stat.size < 10 * 1024 * 1024) {
                    try {
                        const content = await withDeadline(fs.promises.readFile(filePath, 'utf8'), TOOL_OP_TIMEOUT_MS, 'read');
                        lineCount = content.split('\n').length;
                    }
                    catch { /* ignore */ }
                }
                const info = {
                    path: filePath,
                    type: isFile ? 'file' : 'directory',
                    size: stat.size,
                    sizeHuman: stat.size > 1024 * 1024
                        ? `${(stat.size / 1024 / 1024).toFixed(1)}MB`
                        : `${Math.round(stat.size / 1024)}KB`,
                    lineCount: isFile ? lineCount : undefined,
                    modified: stat.mtime.toISOString(),
                    created: stat.birthtime.toISOString(),
                };
                return { success: true, output: JSON.stringify(info, null, 2) };
            }
            case 'read_file_range': {
                const filePath = resolveWorkspacePath(String(args['path'] || ''));
                if (!(await pathExists(filePath))) {
                    return { success: false, output: `File not found: ${filePath}` };
                }
                const stat = await withDeadline(fs.promises.stat(filePath), TOOL_OP_TIMEOUT_MS, 'stat');
                if (stat.size > 2 * 1024 * 1024) {
                    return { success: false, output: `File too large (${Math.round(stat.size / 1024)}KB). Max 2MB.` };
                }
                const startLine = Number(args['start_line']);
                const endLine = Number(args['end_line']);
                if (!Number.isInteger(startLine) || !Number.isInteger(endLine) || startLine < 1 || endLine < 1) {
                    return { success: false, output: `Invalid range: start_line and end_line must be positive integers (1-based). Got start_line=${args['start_line']}, end_line=${args['end_line']}.` };
                }
                if (endLine < startLine) {
                    return { success: false, output: `Invalid range: end_line (${endLine}) is before start_line (${startLine}).` };
                }
                const content = await withDeadline(fs.promises.readFile(filePath, 'utf8'), TOOL_OP_TIMEOUT_MS, 'read');
                const lines = content.split('\n');
                // FLAW #6 fix: don't silently clamp ranges that fall entirely
                // outside the file. If the start is beyond EOF, error loudly so
                // the caller knows their range is wrong. If only the end is
                // beyond EOF, clamp but annotate the header so the caller is
                // not misled into thinking they got the lines they asked for.
                if (startLine > lines.length) {
                    return {
                        success: false,
                        output: `Range out of bounds: ${filePath} has ${lines.length} line${lines.length === 1 ? '' : 's'}, ` +
                            `but start_line=${startLine} (and end_line=${endLine}). Re-issue with start_line ≤ ${lines.length}.`,
                    };
                }
                const from = startLine;
                const to = Math.min(endLine, lines.length);
                const slice = lines.slice(from - 1, to);
                const clampNote = endLine > lines.length
                    ? ` (end_line clamped from ${endLine} to ${to} — file only has ${lines.length} lines)`
                    : '';
                const header = `// File: ${filePath} (lines ${from}-${to} of ${lines.length}${clampNote})\n`;
                return { success: true, output: header + slice.join('\n') };
            }
            case 'get_diagnostics': {
                const severityName = (sev) => {
                    switch (sev) {
                        case vscode.DiagnosticSeverity.Error: return 'error';
                        case vscode.DiagnosticSeverity.Warning: return 'warning';
                        case vscode.DiagnosticSeverity.Information: return 'info';
                        case vscode.DiagnosticSeverity.Hint: return 'hint';
                        default: return 'unknown';
                    }
                };
                const lines = [];
                let total = 0;
                const formatForUri = (uri, diags) => {
                    if (diags.length === 0) {
                        return;
                    }
                    for (const d of diags) {
                        const line = d.range.start.line + 1;
                        const col = d.range.start.character + 1;
                        const source = d.source ? ` (${d.source})` : '';
                        lines.push(`${uri.fsPath}:${line}:${col} [${severityName(d.severity)}]${source} ${d.message.replace(/\s+/g, ' ').trim()}`);
                        total++;
                    }
                };
                const pathArg = args['path'] ? String(args['path']) : '';
                if (pathArg) {
                    const filePath = resolveWorkspacePath(pathArg);
                    const uri = vscode.Uri.file(filePath);
                    formatForUri(uri, vscode.languages.getDiagnostics(uri));
                    if (total === 0) {
                        return { success: true, output: `No diagnostics for ${filePath}` };
                    }
                }
                else {
                    const all = vscode.languages.getDiagnostics();
                    for (const [uri, diags] of all) {
                        formatForUri(uri, diags);
                    }
                    if (total === 0) {
                        return { success: true, output: 'No diagnostics in the workspace.' };
                    }
                }
                const MAX = 500;
                const truncated = lines.length > MAX;
                const body = lines.slice(0, MAX).join('\n');
                const summary = `${total} diagnostic${total === 1 ? '' : 's'}:\n`;
                return { success: true, output: summary + (truncated ? body + '\n... (truncated)' : body) };
            }
            case 'git': {
                const subcommand = String(args['subcommand'] || '').trim();
                const SAFE_SUBCOMMANDS = new Set(['status', 'diff', 'log', 'blame', 'show']);
                if (!SAFE_SUBCOMMANDS.has(subcommand)) {
                    return {
                        success: false,
                        output: `REJECTED: git subcommand must be one of: ${[...SAFE_SUBCOMMANDS].join(', ')} (read-only). Got: "${subcommand}". For other git operations use execute_command (which requires approval).`,
                    };
                }
                const extraArgs = args['args'] ? String(args['args']).trim() : '';
                const pathArg = args['path'] ? String(args['path']).trim() : '';
                const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();
                // FLAW #10 fix: detect "not a git repository" up-front instead
                // of letting git emit its raw `fatal: ...` and exit code 128.
                // Walk up from cwd looking for a .git entry (file or dir; .git
                // can be a file in worktrees / submodules).
                {
                    let probe = cwd;
                    let foundGitDir = false;
                    for (let i = 0; i < 64; i++) {
                        try {
                            if (fs.existsSync(path.join(probe, '.git'))) { foundGitDir = true; break; }
                        } catch { /* ignore */ }
                        const parent = path.dirname(probe);
                        if (parent === probe) { break; }
                        probe = parent;
                    }
                    if (!foundGitDir) {
                        return {
                            success: false,
                            output: `No git repository found at or above ${cwd}. The git tool only works inside a git working tree. ` +
                                `If you need to inspect this directory's files, use list_files / read_file / search_files instead.`,
                        };
                    }
                }
                // Build an argv array and run via execFile (no shell) — this eliminates
                // shell-injection entirely (no metacharacter interpretation of extraArgs).
                // Split extraArgs on whitespace into discrete argv tokens.
                const argv = ['--no-pager', subcommand];
                if (extraArgs) {
                    // Option-injection guard. execFile (no shell) already blocks
                    // shell metacharacters, but git itself honors options that can
                    // write files (--output/-o), execute code (--exec-path,
                    // --upload-pack, --receive-pack) or escape the repo (--git-dir,
                    // --work-tree, -c/--config). Reject those tokens outright.
                    const DANGEROUS_GIT_OPT = /^(--output(=|$)|-o$|-o[^-]|--exec-path|--upload-pack|--receive-pack|--git-dir|--work-tree|-c$|--config)/;
                    for (const tok of extraArgs.split(/\s+/)) {
                        if (!tok) { continue; }
                        if (DANGEROUS_GIT_OPT.test(tok)) {
                            return {
                                success: false,
                                output: `REJECTED: git arg "${tok}" is not allowed (it can write files, execute code, or escape the repository). Remove it and retry.`,
                            };
                        }
                        argv.push(tok);
                    }
                }
                if (pathArg) {
                    argv.push('--', resolveWorkspacePath(pathArg));
                }
                const displayCommand = ['git', ...argv].join(' ');
                // Read-only and 30s-bounded. execFile with argv array — no shell involved.
                return new Promise((resolve) => {
                    child_process.execFile('git', argv, { cwd, timeout: 30000, maxBuffer: 2 * 1024 * 1024 }, (err, stdout, stderr) => {
                        try {
                            const outParts = [];
                            if (stdout) {
                                outParts.push(stdout.trimEnd());
                            }
                            if (stderr) {
                                outParts.push(`STDERR:\n${stderr.trimEnd()}`);
                            }
                            if (err && !stdout && !stderr) {
                                outParts.push(`ERROR: ${err.message}`);
                            }
                            const exitCode = err && typeof err.code === 'number' ? err.code : (err ? 1 : 0);
                            const output = outParts.join('\n\n') || '(command produced no output)';
                            resolve({
                                success: exitCode === 0,
                                output: `$ ${displayCommand}\nExit code: ${exitCode}\n${output}`,
                            });
                        }
                        catch (cbErr) {
                            resolve({ success: false, output: `git internal error: ${errMsg(cbErr)}` });
                        }
                    });
                });
            }
            case 'search_codebase': {
                const query = String(args['query'] || '').trim();
                if (!query) {
                    return { success: false, output: 'search_codebase requires a non-empty "query".' };
                }
                const k = Number.isFinite(Number(args['k'])) ? Math.max(1, Math.min(40, Number(args['k']))) : 12;
                const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
                if (!root) {
                    return { success: false, output: 'No workspace folder open; cannot search the codebase index.' };
                }
                const indexer = new CodebaseIndexer(root);
                if (!indexer.hasIndex()) {
                    return {
                        success: true,
                        output: '(no index — the codebase has not been indexed yet. Ask the user to run ' +
                            '"NEXUS: Index Codebase", or fall back to search_files / read_file for now.)',
                    };
                }
                const result = indexer.retrieve(query, { k });
                if (!result.hits.length) {
                    return {
                        success: true,
                        output: `No indexed chunks matched "${query}".\n\n${result.repoMap}`,
                    };
                }
                const CHAR_BUDGET = 12000;
                const parts: string[] = [];
                parts.push(result.repoMap.length > 2500 ? result.repoMap.slice(0, 2500) + '\n…' : result.repoMap);
                parts.push(`\n# Top ${result.hits.length} relevant chunks (of ${result.totalChunks} indexed)`);
                let used = parts.join('\n').length;
                for (const h of result.hits) {
                    const c = h.chunk;
                    const head = `\n--- ${c.file}:${c.startLine}-${c.endLine}  [${c.kind}${c.symbol ? ' ' + c.symbol : ''}]  score=${h.score.toFixed(2)} ---\n`;
                    const body = c.content.length > 1600 ? c.content.slice(0, 1600) + '\n… (truncated — read_file_range for more)' : c.content;
                    if (used + head.length + body.length > CHAR_BUDGET) {
                        parts.push(`\n(${result.hits.length} hits total; remaining omitted to stay within budget — refine the query or read_file_range the files above.)`);
                        break;
                    }
                    parts.push(head + body);
                    used += head.length + body.length;
                }
                return { success: true, output: parts.join('\n') };
            }
            default:
                return { success: false, output: `Unknown tool: ${name}` };
        }
    }
    catch (err) {
        return {
            success: false,
            output: `Tool execution error: ${errMsg(err)}`,
        };
    }
}
