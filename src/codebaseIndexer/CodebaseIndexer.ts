
/**
 * CodebaseIndexer — a fully local, AI-free codebase index for NEXUS.
 *
 * Pipeline (mirrors the design doc, minus the embedding/LLM stages):
 *   Discovery → Hashing & Merkle → Chunking → Symbol extraction →
 *   Lexical (BM25) inverted index → Persist (JSON under .nexus/index/)
 *
 * No external dependencies — pure Node stdlib (fs, crypto, path). No network,
 * no embeddings, no model. Retrieval is BM25 lexical search + a ranked symbol
 * outline, so the agent can be sent only relevant snippets instead of whole
 * files.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface IndexedFile {
  path: string;        // workspace-relative POSIX path
  hash: string;        // sha256 of file contents
  lang: string;
  size: number;
  mtime: number;       // mtimeMs at index time (for cheap staleness checks)
}

export type ChunkKind = 'function' | 'class' | 'method' | 'interface' | 'block';

export interface Chunk {
  id: number;
  file: string;        // workspace-relative path
  startLine: number;   // 1-based
  endLine: number;     // 1-based, inclusive
  kind: ChunkKind;
  symbol: string;      // best-effort symbol name ('' if none)
  lang: string;
  content: string;
}

export interface SymbolDef {
  name: string;
  file: string;
  line: number;
  kind: ChunkKind;
  rank: number;        // simple reference-count rank (no PageRank, no AI)
}

export interface IndexData {
  version: number;
  createdAt: number;
  root: string;
  files: IndexedFile[];
  chunks: Chunk[];
  symbols: SymbolDef[];
  merkle: Record<string, string>;     // dir-relative-path -> rolled-up hash
  // BM25 inverted index
  postings: Record<string, [number, number][]>; // term -> [chunkId, tf][]
  docLen: Record<number, number>;     // chunkId -> token count
  avgDocLen: number;
}

export interface SearchHit {
  chunk: Chunk;
  score: number;
}

export interface RetrievalResult {
  repoMap: string;        // ranked symbol outline
  hits: SearchHit[];
  totalChunks: number;
}

export interface IndexStats {
  fileCount: number;
  chunkCount: number;
  symbolCount: number;
  lastIndexed: number;
  sizeOnDiskBytes: number;
}

export interface ProgressReporter {
  (message: string, percent: number): void;
}

// ─── Configuration ────────────────────────────────────────────────────────────

// Bumped to 2 when the indexable-file allowlist was tightened (source-only,
// 256 KB cap, NUL-byte binary sniff). Older v1 indices are auto-invalidated
// by loadSafe()'s version check, forcing a re-index with the new rules.
const INDEX_VERSION = 2;
const INDEX_DIR = '.nexus/index';
const INDEX_FILE = 'index.json';
// FLAW FIX: was 1 MB, which let in many checked-in / generated source files
// (auto-generated protobuf TS, vendored bundles, single-file JS libs) that
// inflated the index to hundreds of MB. Hand-written source above 256 KB is
// rare; anything larger is almost always machine-generated and not useful
// for code search. The cap can be raised per-workspace later via config.
const MAX_FILE_SIZE_BYTES = 256 * 1024; // 256 KB
// How many bytes to read from the head of a file to sniff for binary
// content (NUL-byte detection). Cheap pread; runs once per candidate file.
const BINARY_SNIFF_BYTES = 512;
const WINDOW_LINES = 40;
const WINDOW_OVERLAP = 8;

// FLAW FIX: cap on per-line length when scanning for symbol markers. Lines
// longer than this are almost certainly generated/minified/bundled code and
// not human-authored declarations — so symbol extraction would be useless
// AND would risk catastrophic backtracking in SYMBOL_PATTERNS. The line is
// still kept in the chunk content (so retrieval can match it lexically) —
// only the per-line regex scan is skipped.
const MAX_SYMBOL_LINE_LEN = 500;

// FLAW FIX: O(n) keyword pre-filter. A line that doesn't contain ANY of
// these keywords cannot match ANY pattern in SYMBOL_PATTERNS, so we skip
// the (potentially exponential) regex calls entirely. This is the single
// biggest performance win for noisy / wide-line files.
const SYMBOL_KEYWORD_HINT = /(?:^|\s)(?:class|interface|function|const|def|func|fn|public|private|protected|static|abstract|export)\b/;

const DEFAULT_EXCLUDE_DIRS = new Set([
  // VCS
  '.git', '.hg', '.svn',
  // JS/TS ecosystem
  'node_modules', 'dist', 'build', 'out', '.next', '.nuxt', 'coverage',
  '.cache', '.parcel-cache', '.turbo', '.svelte-kit',
  // Python ecosystem
  '__pycache__', '.venv', 'venv', 'env', '.tox', '.mypy_cache',
  '.pytest_cache', '.ruff_cache', '.eggs', '.ipynb_checkpoints',
  // C / C++ ecosystem
  'CMakeFiles', 'cmake-build-debug', 'cmake-build-release', '_build',
  'Debug', 'Release', 'bin', 'obj', 'x64', 'x86',
  // JVM ecosystem
  'target', '.gradle', '.idea',
  // Other
  'vendor', '.terraform', '.serverless', '.vscode-test', '.nexus',
]);

// Files with these extensions are unconditionally rejected. Kept as a
// belt-and-suspenders layer in case something binary somehow has a
// "source-y" extension upstream — the real gate is the SOURCE_EXT
// allowlist below.
const BINARY_EXT = new Set([
  // Images / media
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.webp', '.svg',
  '.tiff', '.tif', '.psd', '.ai',
  '.mp3', '.mp4', '.mov', '.avi', '.wav', '.ogg', '.flac', '.mkv', '.webm',
  // Archives / compressed
  '.zip', '.gz', '.tar', '.tgz', '.txz', '.7z', '.rar', '.bz2', '.xz',
  // Compiled / linked artefacts
  '.exe', '.dll', '.so', '.dylib', '.bin', '.o', '.a', '.class', '.jar',
  '.war', '.pyc', '.pyo', '.pyd', '.wasm',
  // Fonts
  '.ttf', '.otf', '.woff', '.woff2', '.eot',
  // Documents
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  // Data / ML weights / pickled blobs
  '.csv', '.tsv', '.parquet', '.arrow', '.feather', '.h5', '.hdf5',
  '.npy', '.npz', '.pkl', '.pickle', '.joblib', '.onnx', '.pb',
  '.tflite', '.mat', '.dat', '.idx', '.safetensors', '.ckpt', '.pt', '.pth',
  // Misc
  '.lock', '.map', '.min',
]);

// SOURCE-CODE ALLOWLIST.
//
// Only files whose extension is in this map (or whose basename is in
// ALLOWED_BASENAMES below) are indexed. This is an ALLOWLIST, not a
// denylist — anything not listed here is silently skipped, which is what
// keeps the index small and focused on hand-written source.
//
// If you need to index something else (e.g. a custom DSL extension),
// add it here.
const LANG_BY_EXT: Record<string, string> = {
  // C / C++ / Objective-C / preprocessor / inline-include macros
  '.c': 'c', '.h': 'c',
  '.cc': 'cpp', '.cpp': 'cpp', '.cxx': 'cpp', '.c++': 'cpp',
  '.hh': 'cpp', '.hpp': 'cpp', '.hxx': 'cpp', '.h++': 'cpp',
  '.inc': 'cpp', '.ipp': 'cpp', '.tpp': 'cpp', '.tcc': 'cpp',
  '.cppm': 'cpp', '.ixx': 'cpp',
  '.m': 'objective-c', '.mm': 'objective-cpp',
  // Assembly
  '.s': 'asm', '.S': 'asm', '.asm': 'asm',
  // Python (incl. Cython, type stubs)
  '.py': 'python', '.pyi': 'python', '.pyx': 'python', '.pxd': 'python',
  // Rust / Go / Zig / D / Nim
  '.rs': 'rust', '.go': 'go', '.zig': 'zig', '.d': 'd', '.nim': 'nim',
  // JS / TS
  '.ts': 'typescript', '.tsx': 'typescript',
  '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
  // JVM languages
  '.java': 'java', '.kt': 'kotlin', '.kts': 'kotlin',
  '.scala': 'scala', '.sc': 'scala', '.groovy': 'groovy',
  // .NET
  '.cs': 'csharp', '.fs': 'fsharp', '.fsi': 'fsharp', '.vb': 'vb',
  // Other mainstream languages
  '.rb': 'ruby', '.php': 'php', '.swift': 'swift', '.dart': 'dart',
  '.lua': 'lua', '.pl': 'perl', '.pm': 'perl', '.r': 'r', '.R': 'r',
  // Functional / Lispy
  '.ex': 'elixir', '.exs': 'elixir', '.erl': 'erlang', '.hrl': 'erlang',
  '.ml': 'ocaml', '.mli': 'ocaml',
  '.hs': 'haskell', '.elm': 'elm',
  '.clj': 'clojure', '.cljs': 'clojure', '.cljc': 'clojure',
  '.lisp': 'lisp', '.scm': 'scheme', '.rkt': 'racket',
  // Fortran
  '.f': 'fortran', '.f90': 'fortran', '.f95': 'fortran',
  '.f03': 'fortran', '.f08': 'fortran',
  // Shell / batch
  '.sh': 'shell', '.bash': 'shell', '.zsh': 'shell', '.fish': 'shell',
  '.ps1': 'powershell', '.bat': 'batch', '.cmd': 'batch',
  // Build / macro languages the user explicitly asked for
  '.cmake': 'cmake', '.mk': 'make', '.mak': 'make',
  // Web markup / styles (kept because they're commonly mixed with code)
  '.html': 'html', '.htm': 'html',
  '.css': 'css', '.scss': 'scss', '.sass': 'sass', '.less': 'less',
  '.vue': 'vue', '.svelte': 'svelte',
  // Docs (READMEs, design notes — small and high-signal)
  '.md': 'markdown', '.rst': 'rst',
  // SQL / proto / IDL
  '.sql': 'sql', '.proto': 'proto', '.thrift': 'thrift', '.graphql': 'graphql', '.gql': 'graphql',
};

// Files that have NO extension (or a non-standard one) but ARE source.
// Matched on basename, case-sensitive.
const ALLOWED_BASENAMES: Record<string, string> = {
  'Makefile': 'make',
  'makefile': 'make',
  'GNUmakefile': 'make',
  'CMakeLists.txt': 'cmake',
  'Dockerfile': 'dockerfile',
  'Containerfile': 'dockerfile',
  'Rakefile': 'ruby',
  'Gemfile': 'ruby',
  'Guardfile': 'ruby',
  'Procfile': 'procfile',
  'BUILD': 'starlark',
  'BUILD.bazel': 'starlark',
  'WORKSPACE': 'starlark',
  'WORKSPACE.bazel': 'starlark',
};

// Lightweight, regex-based symbol detectors. NOT a parser — best-effort, but
// AI-free and dependency-free. Each entry returns { name, kind } or null.
//
// FLAW FIX: every pattern below MUST be linear-time on adversarial input.
// The previous Java/C#-method pattern had nested whitespace alternations
// which caused catastrophic backtracking on long generated lines and hung
// indexing on a single file. The replacement uses bounded repetition
// `{1,4}` on access modifiers and a single non-whitespace type token so
// the matcher is effectively atomic on the dangerous parts.
const SYMBOL_PATTERNS: { kind: ChunkKind; re: RegExp; group: number }[] = [
  { kind: 'class', re: /^\s*(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, group: 1 },
  { kind: 'interface', re: /^\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/, group: 1 },
  { kind: 'function', re: /^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/, group: 1 },
  { kind: 'function', re: /^\s*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/, group: 1 },
  { kind: 'function', re: /^\s*def\s+([A-Za-z_][\w]*)/, group: 1 },      // python
  { kind: 'class', re: /^\s*class\s+([A-Za-z_][\w]*)/, group: 1 },        // python/ruby
  { kind: 'function', re: /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_][\w]*)/, group: 1 }, // go
  { kind: 'function', re: /^\s*(?:pub\s+)?fn\s+([A-Za-z_][\w]*)/, group: 1 },         // rust
  // Java/C#-ish method: REQUIRE at least one access modifier (so we don't
  // try to match plain function calls), bounded `{1,4}` repetition on
  // modifiers, then a single non-space type token, then the method name
  // and `(`. No nested whitespace alternations, no `[…\s]+` greediness.
  { kind: 'method', re: /^\s*(?:(?:public|private|protected|static|final|abstract|synchronized)\s+){1,4}[A-Za-z_$][\w<>\[\],$]*\s+([A-Za-z_$][\w$]*)\s*\(/, group: 1 },
];

const STOPWORDS = new Set([
  'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'any', 'can',
  'this', 'that', 'with', 'from', 'into', 'const', 'let', 'var', 'function',
  'return', 'if', 'else', 'true', 'false', 'null', 'void', 'new',
]);

// ─── CodebaseIndexer ─────────────────────────────────────────────────────────

export class CodebaseIndexer {
  constructor(private readonly root: string) {}

  get indexDir(): string {
    return path.join(this.root, INDEX_DIR);
  }
  private get indexPath(): string {
    return path.join(this.indexDir, INDEX_FILE);
  }

  /** Build (or rebuild) the index. `force` ignores the Merkle cache. */
  async build(report: ProgressReporter, force = false): Promise<IndexStats> {
    report('Discovering files…', 0);
    const files = this.discover();

    report('Hashing & diffing…', 10);
    const prev = force ? undefined : this.loadSafe();

    // FLAW FIX: stat-based fast-path. Previously we read+SHA256 every file
    // on every build, which was the bulk of the cost (~30–60s on 8k files)
    // even when nothing had changed and all chunks/symbols would be reused
    // downstream. That made a re-index click *feel* like a full rebuild
    // every time. Now we stat() each file (fast) and ONLY read+hash files
    // whose (size, mtime) differ from the prior index — for everything
    // else we trust the stored hash. Result: a "no real changes" rebuild
    // is essentially a stat scan + downstream reuse.
    const prevByPathFast = prev
      ? new Map<string, IndexedFile>(prev.files.map(f => [f.path, f]))
      : null;

    const indexed: IndexedFile[] = [];
    const merkle: Record<string, string> = {};
    let reusedHashCount = 0;
    let rehashedCount = 0;
    let processed = 0;
    for (const abs of files) {
      const rel = this.toRel(abs);

      let st: fs.Stats | undefined;
      try { st = fs.statSync(abs); } catch { processed++; continue; }
      const mtime = st.mtimeMs;
      const size = st.size;

      let hash: string;
      const prevEntry = prevByPathFast?.get(rel);
      // Stat fast-path: same path + same size + mtime within ~1ms tolerance
      // → file content is the same; reuse the stored hash. Use a tiny
      // tolerance (<2ms) because filesystems quantise mtime differently;
      // we still want a true touch-without-content-change to be detected
      // by the downstream chunk-reuse layer (which is hash-based), but
      // we don't want noise like "1.0s vs 1.0001s" to invalidate the
      // fast-path either.
      if (prevEntry && prevEntry.size === size && Math.abs(prevEntry.mtime - mtime) < 2) {
        hash = prevEntry.hash;
        reusedHashCount++;
      } else {
        let buf: Buffer;
        try { buf = fs.readFileSync(abs); } catch { processed++; continue; }
        hash = crypto.createHash('sha256').update(buf).digest('hex');
        rehashedCount++;
      }

      indexed.push({
        path: rel,
        hash,
        // Use langFor() so basename-only sources (Makefile, Dockerfile,
        // CMakeLists.txt, …) get their proper language label instead of
        // falling back to 'text'.
        lang: this.langFor(abs),
        size,
        mtime,
      });
      const dir = path.posix.dirname(rel);
      merkle[dir] = crypto.createHash('sha256')
        .update((merkle[dir] ?? '') + hash).digest('hex');

      // Periodic progress so the user sees incremental work, not a freeze.
      processed++;
      if (processed % 500 === 0) {
        report(
          `Hashing… ${processed}/${files.length} (${rehashedCount} changed, ${reusedHashCount} reused)`,
          10 + (processed / files.length) * 15,
        );
      }
    }

    // Headline summary so the user can SEE the build is incremental.
    report(
      rehashedCount === 0
        ? `No file changes detected — reusing all ${reusedHashCount} hashes.`
        : `Hashed ${rehashedCount} changed of ${files.length} files (${reusedHashCount} unchanged reused).`,
      28,
    );

    // ULTIMATE FAST-PATH: nothing changed at all.
    //
    // If the prior index existed AND every file matched the stat
    // fast-path AND the file count is identical, then the file SET is
    // unchanged AND no file's content changed. The prior chunks,
    // symbols, postings, docLen, avgDocLen are ALL still correct — so
    // we can skip chunking, ranking, inverted-index construction and
    // persistence entirely and just return the existing stats. This
    // turns a "user clicked re-index but really nothing changed" event
    // from ~5–10s of useless tokenisation work into <100ms of stat
    // calls. This is the biggest win against the user's complaint
    // that the extension "indexes every reload".
    if (
      prev &&
      rehashedCount === 0 &&
      reusedHashCount === prev.files.length &&
      indexed.length === prev.files.length
    ) {
      report('Index already up to date — no rebuild needed.', 100);
      return this.statsFrom(prev);
    }

    // Reuse chunks/symbols for unchanged files (Merkle-style incremental).
    const prevByPath = new Map<string, { chunks: Chunk[]; symbols: SymbolDef[] }>();
    if (prev) {
      const prevHash = new Map(prev.files.map(f => [f.path, f.hash]));
      const chunksByFile = new Map<string, Chunk[]>();
      const symsByFile = new Map<string, SymbolDef[]>();
      for (const c of prev.chunks) { (chunksByFile.get(c.file) ?? chunksByFile.set(c.file, []).get(c.file)!).push(c); }
      for (const s of prev.symbols) { (symsByFile.get(s.file) ?? symsByFile.set(s.file, []).get(s.file)!).push(s); }
      for (const f of indexed) {
        if (prevHash.get(f.path) === f.hash) {
          prevByPath.set(f.path, {
            chunks: chunksByFile.get(f.path) ?? [],
            symbols: symsByFile.get(f.path) ?? [],
          });
        }
      }
    }

    report('Chunking & extracting symbols…', 30);
    const chunks: Chunk[] = [];
    const symbols: SymbolDef[] = [];
    let nextId = 1;
    // FLAW FIX: renamed from `processed` to avoid TS-shadowing the
    // hashing-loop counter declared at the top of build().
    let chunkProcessed = 0;
    for (const f of indexed) {
      // FLAW FIX: report the CURRENT FILE every iteration (not just every
      // 50). If chunking does hang on a pathological file, the progress
      // notification then names the offender so the user can add it to
      // .nexusignore — instead of a blank "Chunking…" with no clue.
      report(
        `Chunking ${chunkProcessed + 1}/${indexed.length}: ${f.path}`,
        30 + (chunkProcessed / indexed.length) * 30,
      );
      const reuse = prevByPath.get(f.path);
      if (reuse) {
        for (const c of reuse.chunks) { chunks.push({ ...c, id: nextId++ }); }
        for (const s of reuse.symbols) { symbols.push(s); }
      } else {
        const abs = path.join(this.root, f.path);
        let text: string;
        try { text = fs.readFileSync(abs, 'utf8'); } catch { chunkProcessed++; continue; }
        try {
          const { fileChunks, fileSymbols } = this.chunkAndExtract(f.path, f.lang, text, () => nextId++);
          chunks.push(...fileChunks);
          symbols.push(...fileSymbols);
        } catch (err) {
          // FLAW FIX: never let one bad file kill the whole build. Skip
          // and keep going; the file is still recorded in `indexed` so
          // staleness checks remain consistent.
          // eslint-disable-next-line no-console
          console.warn(`[CodebaseIndexer] skipped ${f.path}: ${(err as Error)?.message ?? err}`);
        }
      }
      chunkProcessed++;
      // FLAW FIX: yield more often (every 10 files instead of 50) so the
      // UI stays responsive even when individual files are heavy. The
      // setImmediate cost is microseconds.
      if (chunkProcessed % 10 === 0) {
        await yieldToHost();
      }
    }

    report('Ranking symbols…', 65);
    await yieldToHost();
    this.rankSymbols(symbols, chunks);

    report('Building lexical index…', 75);
    await yieldToHost();
    const { postings, docLen, avgDocLen } =
      await this.buildInvertedIndex(chunks, report);

    const data: IndexData = {
      version: INDEX_VERSION,
      createdAt: Date.now(),
      root: this.root,
      files: indexed,
      chunks,
      symbols,
      merkle,
      postings,
      docLen,
      avgDocLen,
    };

    report('Persisting…', 92);
    await this.persist(data);
    this.ensureGitignore();

    report('Done', 100);
    return this.statsFrom(data);
  }

  /** BM25 lexical retrieval + ranked symbol outline. AI-free. */
  retrieve(query: string, opts: { k?: number } = {}): RetrievalResult {
    const k = opts.k ?? 20;
    const data = this.loadSafe();
    if (!data) {
      return { repoMap: '(no index — run "NEXUS: Index Codebase" first)', hits: [], totalChunks: 0 };
    }
    const terms = tokenize(query);
    const N = data.chunks.length || 1;
    const chunkById = new Map(data.chunks.map(c => [c.id, c]));
    const k1 = 1.5, b = 0.75;
    const scores = new Map<number, number>();

    for (const term of new Set(terms)) {
      const postings = data.postings[term];
      if (!postings) { continue; }
      const df = postings.length;
      const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
      for (const [chunkId, tf] of postings) {
        const dl = data.docLen[chunkId] ?? data.avgDocLen;
        const denom = tf + k1 * (1 - b + b * (dl / (data.avgDocLen || 1)));
        const inc = idf * ((tf * (k1 + 1)) / (denom || 1));
        scores.set(chunkId, (scores.get(chunkId) ?? 0) + inc);
      }
    }

    // FLAW #9 fix: rank declaration sites above incidental mentions.
    //
    // Previously a small +2.0 substring boost was applied when the query
    // string contained the chunk's symbol. That was too weak to outweigh
    // BM25 scores on import lines that mention the symbol many times, so
    // for queries like "agentSession class definition" the import chunk
    // (which is irrelevant) outranked the actual `class AgentSession`
    // declaration. We now apply two graduated boosts:
    //
    //   (a) Symbol-token-equality boost: if the chunk's symbol, broken
    //       into camelCase / snake_case tokens, intersects the query's
    //       token set, add a moderate boost (+3.0) per matched token.
    //   (b) Declaration-site boost: if the chunk's source text actually
    //       declares an entity whose name is one of the query tokens
    //       (matching `class Foo` / `function foo` / `interface Foo` /
    //       `type Foo` / `enum Foo` / `const Foo` / `let Foo` / `var Foo`
    //       / `def foo` / `struct Foo` / `trait Foo` for common langs),
    //       add a LARGE boost (+8.0) — this is almost certainly what the
    //       caller is looking for when they ask "where is X defined".
    const qTokens = new Set(tokenize(query));
    // Strip generic intent words from the query token set — they should
    // not themselves trigger a declaration boost (we don't want to match
    // `class definition` literally; we want to match the SUBJECT of the
    // query).
    const intentWords = new Set(['class', 'function', 'method', 'interface', 'type', 'enum', 'const', 'definition', 'declared', 'declare', 'declaration', 'defined', 'define', 'where', 'find', 'locate', 'shows', 'show']);
    const subjectTokens = [...qTokens].filter(t => !intentWords.has(t));
    if (subjectTokens.length > 0) {
      // Pre-compile a single regex matching any declaration of any subject token.
      const escaped = subjectTokens.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
      // Allow camelCase reconstruction: token "agent" should match `AgentSession`
      // ONLY if every subject token concatenates to the symbol. Simpler approach:
      // also try a concatenated form (subjectTokens joined) as one big identifier.
      const concat = subjectTokens.join('');
      const idents = [...new Set([...escaped, concat])];
      const declRe = new RegExp(
        // word boundaries on both sides; declaration keyword + identifier.
        `\\b(?:class|function|interface|type|enum|const|let|var|struct|trait|def|fn|public\\s+class|export\\s+(?:class|function|interface|type|enum|const|default\\s+(?:class|function)))\\s+(?:${idents.join('|')})\\b`,
        'i',
      );
      for (const c of data.chunks) {
        const cur = scores.get(c.id) ?? 0;
        // (a) symbol-token equality
        if (c.symbol) {
          const symTokens = new Set(tokenize(c.symbol));
          let overlap = 0;
          for (const t of subjectTokens) { if (symTokens.has(t)) { overlap++; } }
          if (overlap > 0) {
            scores.set(c.id, cur + 3.0 * overlap);
          }
        }
        // (b) declaration-site boost — chunk text actually declares the subject.
        const cur2 = scores.get(c.id) ?? 0;
        if (declRe.test(c.content)) {
          scores.set(c.id, cur2 + 8.0);
        }
      }
    }

    const hits: SearchHit[] = [...scores.entries()]
      .map(([id, score]) => ({ chunk: chunkById.get(id)!, score }))
      .filter(h => h.chunk)
      .sort((a, b2) => b2.score - a.score)
      .slice(0, k);

    return { repoMap: this.buildRepoMap(data), hits, totalChunks: data.chunks.length };
  }

  stats(): IndexStats | undefined {
    const data = this.loadSafe();
    return data ? this.statsFrom(data) : undefined;
  }

  /**
   * Cheap staleness check: compares the set of indexable files and their
   * (size, mtime) against the stored index using stat() only (no hashing,
   * no reads), so it is safe to call on activation / on every status
   * request.
   *
   * FLAW FIX: this used to flag stale on ANY mtime drift > 1s, which
   * triggered spurious "Re-index" prompts after every reload because
   * mtimes naturally drift on git checkout, IDE save round-trips, build
   * artefact touches, etc. — even when file CONTENT is unchanged. Now we
   * agree with build()'s stat fast-path: a file is "possibly changed"
   * only if its SIZE differs OR its mtime drifted by >2ms (the same
   * tolerance build() uses). Size is the strongest no-false-positive
   * signal; mtime alone is only used to detect cases where a tiny edit
   * happened to keep size identical. The downstream build() will hash
   * any flagged file and confirm/deny the actual content change.
   */
  isStale(): { stale: boolean; added: number; removed: number; modified: number } {
    const data = this.loadSafe();
    if (!data) { return { stale: true, added: 0, removed: 0, modified: 0 }; }
    const stored = new Map(data.files.map(f => [f.path, f]));
    const current = this.discover();
    const seen = new Set<string>();
    let added = 0, modified = 0;
    for (const abs of current) {
      const rel = this.toRel(abs);
      seen.add(rel);
      const prevEntry = stored.get(rel);
      if (!prevEntry) { added++; continue; }
      try {
        const st = fs.statSync(abs);
        // Size differs → real content change, definitely stale.
        if (st.size !== prevEntry.size) { modified++; continue; }
        // Same size + mtime within 2ms → matches build()'s reuse path.
        if (Math.abs(st.mtimeMs - (prevEntry.mtime ?? 0)) < 2) { continue; }
        // Same size, larger mtime drift → POSSIBLY a tiny edit; flag it.
        // Build will hash and confirm.
        modified++;
      } catch { modified++; }
    }
    let removed = 0;
    for (const f of data.files) { if (!seen.has(f.path)) { removed++; } }
    const stale = added > 0 || removed > 0 || modified > 0;
    return { stale, added, removed, modified };
  }

  clear(): void {
    try { fs.rmSync(this.indexDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  hasIndex(): boolean {
    return fs.existsSync(this.indexPath);
  }

  // ─── Stage 1: Discovery ───────────────────────────────────────────────────

  private discover(): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const ignorePatterns = this.loadIgnorePatterns();

    const walk = (dir: string): void => {
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const ent of entries) {
        const abs = path.join(dir, ent.name);
        const rel = this.toRel(abs);
        if (this.isIgnored(rel, ignorePatterns)) { continue; }
        if (ent.isDirectory()) {
          if (DEFAULT_EXCLUDE_DIRS.has(ent.name)) { continue; }
          let real: string;
          try { real = fs.realpathSync(abs); } catch { continue; }
          if (seen.has(real)) { continue; } // symlink-loop guard
          seen.add(real);
          walk(abs);
        } else if (ent.isFile()) {
          if (this.isIndexableFile(abs, ent.name)) { out.push(abs); }
        }
      }
    };
    walk(this.root);
    return out;
  }

  /**
   * Decide whether a file should be indexed.
   *
   * Strategy (allowlist):
   *   1. Reject anything in BINARY_EXT or matching well-known generated
   *      filename patterns (lockfiles, *.min.js, source maps).
   *   2. Accept ONLY files whose extension is in LANG_BY_EXT or whose
   *      basename is in ALLOWED_BASENAMES — anything else is skipped.
   *   3. Reject empty files and anything > MAX_FILE_SIZE_BYTES.
   *   4. Sniff the first BINARY_SNIFF_BYTES bytes; if any NUL byte is
   *      present, treat as binary and reject (catches misnamed binaries
   *      and corrupted text files).
   */
  private isIndexableFile(abs: string, name: string): boolean {
    // (1) Hard denylist — extensions we know are binary / generated.
    const ext = path.extname(name).toLowerCase();
    if (BINARY_EXT.has(ext)) { return false; }
    if (/\.min\.(js|mjs|cjs|css)$/i.test(name)) { return false; }
    if (/\.bundle\.(js|mjs|cjs|css)$/i.test(name)) { return false; }
    if (/\.(map|d\.ts\.map)$/i.test(name)) { return false; }
    if (/(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|poetry\.lock|Cargo\.lock|Gemfile\.lock|composer\.lock)$/i.test(name)) { return false; }

    // (2) Allowlist — must be a known source extension OR an allowed basename.
    const isKnownExt = Object.prototype.hasOwnProperty.call(LANG_BY_EXT, ext);
    const isAllowedBasename = Object.prototype.hasOwnProperty.call(ALLOWED_BASENAMES, name);
    if (!isKnownExt && !isAllowedBasename) { return false; }

    // (3) Size gate — reject empty and oversized files.
    let size = 0;
    try {
      const st = fs.statSync(abs);
      size = st.size;
      if (size === 0 || size > MAX_FILE_SIZE_BYTES) { return false; }
    } catch { return false; }

    // (4) Binary sniff — open the file and look for a NUL byte in the
    //     leading window. Cheap (one syscall + one small read) and
    //     catches files with text-y extensions but binary contents.
    let fd = -1;
    try {
      fd = fs.openSync(abs, 'r');
      const want = Math.min(BINARY_SNIFF_BYTES, size);
      const buf = Buffer.allocUnsafe(want);
      const n = fs.readSync(fd, buf, 0, want, 0);
      for (let i = 0; i < n; i++) {
        if (buf[i] === 0) { return false; }
      }
    } catch {
      return false;
    } finally {
      if (fd >= 0) { try { fs.closeSync(fd); } catch { /* ignore */ } }
    }

    return true;
  }

  /** Resolve a file's language label from its path, consulting both the
   *  extension allowlist and the basename allowlist. Returns 'text' as a
   *  defensive fallback (should not happen if isIndexableFile gated correctly). */
  private langFor(abs: string): string {
    const base = path.basename(abs);
    if (Object.prototype.hasOwnProperty.call(ALLOWED_BASENAMES, base)) {
      return ALLOWED_BASENAMES[base];
    }
    const ext = path.extname(base).toLowerCase();
    return LANG_BY_EXT[ext] ?? 'text';
  }

  /** Very small .gitignore reader: plain & dir patterns only (no negation/globstar logic). */
  private loadIgnorePatterns(): string[] {
    const patterns: string[] = [];
    for (const f of ['.gitignore', '.nexusignore', '.clineignore']) {
      try {
        const txt = fs.readFileSync(path.join(this.root, f), 'utf8');
        for (const raw of txt.split(/\r?\n/)) {
          const line = raw.trim();
          if (!line || line.startsWith('#') || line.startsWith('!')) { continue; }
          patterns.push(line.replace(/^\/+/, '').replace(/\/+$/, ''));
        }
      } catch { /* file may not exist */ }
    }
    return patterns;
  }

  private isIgnored(rel: string, patterns: string[]): boolean {
    const segs = rel.split('/');
    for (const p of patterns) {
      if (!p.includes('/') && !p.includes('*')) {
        // bare name → match any path segment
        if (segs.includes(p)) { return true; }
      } else if (p.includes('*')) {
        const re = new RegExp('^' + p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
        if (segs.some(s => re.test(s)) || re.test(rel)) { return true; }
      } else if (rel === p || rel.startsWith(p + '/')) {
        return true;
      }
    }
    return false;
  }

  // ─── Stage 3+4: Chunking & symbol extraction ──────────────────────────────

  private chunkAndExtract(
    file: string, lang: string, text: string, nextId: () => number,
  ): { fileChunks: Chunk[]; fileSymbols: SymbolDef[] } {
    const lines = text.split('\n');
    const fileSymbols: SymbolDef[] = [];

    // Detect symbol boundaries.
    //
    // FLAW FIX (the big one): two cheap pre-checks before invoking the
    // SYMBOL_PATTERNS regexes on each line. Without these, a single
    // generated/minified/bundled file with very long lines could pin a
    // CPU for minutes due to catastrophic backtracking — which is why
    // indexing appeared to hang on a specific file (e.g. 8300/8391).
    //
    //   1. Skip lines longer than MAX_SYMBOL_LINE_LEN. Such lines are
    //      almost never human-authored declarations; they only contain
    //      noise that wastes regex time and risks ReDoS.
    //   2. Skip lines that contain none of the symbol-defining keywords
    //      (class / interface / function / const / def / func / fn /
    //      public / private / …). A line without ANY of those keywords
    //      cannot match ANY pattern in SYMBOL_PATTERNS, so the inner
    //      loop is wasted work.
    //
    // The line text is still kept in the chunk content for retrieval —
    // we are only skipping the per-line *symbol detection* regex pass.
    const markers: { line: number; name: string; kind: ChunkKind }[] = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.length > MAX_SYMBOL_LINE_LEN) { continue; }
      if (!SYMBOL_KEYWORD_HINT.test(line)) { continue; }
      for (const pat of SYMBOL_PATTERNS) {
        const m = pat.re.exec(line);
        if (m && m[pat.group]) {
          markers.push({ line: i, name: m[pat.group], kind: pat.kind });
          fileSymbols.push({ name: m[pat.group], file, line: i + 1, kind: pat.kind, rank: 0 });
          break;
        }
      }
    }

    const fileChunks: Chunk[] = [];
    if (markers.length > 0) {
      // Symbol-aware chunks: each chunk spans from a marker to just before the next.
      for (let i = 0; i < markers.length; i++) {
        const start = markers[i].line;
        const end = i + 1 < markers.length ? markers[i + 1].line - 1 : lines.length - 1;
        const content = lines.slice(start, end + 1).join('\n');
        if (content.trim()) {
          fileChunks.push({
            id: nextId(), file, startLine: start + 1, endLine: end + 1,
            kind: markers[i].kind, symbol: markers[i].name, lang, content,
          });
        }
      }
      // Capture a preamble chunk (imports/top-level) before the first symbol.
      if (markers[0].line > 0) {
        const content = lines.slice(0, markers[0].line).join('\n');
        if (content.trim()) {
          fileChunks.unshift({
            id: nextId(), file, startLine: 1, endLine: markers[0].line,
            kind: 'block', symbol: '', lang, content,
          });
        }
      }
    } else {
      // Fallback: sliding line windows with overlap.
      for (let start = 0; start < lines.length; start += (WINDOW_LINES - WINDOW_OVERLAP)) {
        const end = Math.min(start + WINDOW_LINES, lines.length);
        const content = lines.slice(start, end).join('\n');
        if (content.trim()) {
          fileChunks.push({
            id: nextId(), file, startLine: start + 1, endLine: end,
            kind: 'block', symbol: '', lang, content,
          });
        }
        if (end >= lines.length) { break; }
      }
    }
    return { fileChunks, fileSymbols };
  }

  // ─── Stage 4b: Symbol ranking (reference-count, no PageRank/AI) ────────────

  private rankSymbols(symbols: SymbolDef[], chunks: Chunk[]): void {
    if (symbols.length === 0) { return; }
    // FLAW FIX: previously this method built one giant string by joining
    // every chunk's content (`chunks.map(c => c.content).join('\n')`) and
    // then ran ONE RegExp.match per unique symbol name across the whole
    // blob — i.e. O(symbols × bodyBytes) work, all on the host thread.
    // On a real workspace with thousands of symbols and a few MB of code
    // that was multiple seconds to minutes of unyielding CPU, which made
    // the indexing progress notification appear frozen (the next stage's
    // `report(...)` couldn't repaint because the event loop was blocked).
    //
    // New plan: a SINGLE pass over chunk content that tokenises each
    // chunk once and increments counts for any token that matches a
    // wanted symbol name. O(bodyTokens) total, no giant string allocation,
    // no N regex compiles, identical answer for word-boundary symbol
    // matches (which is what the regex was approximating).
    const counts = new Map<string, number>();
    for (const s of symbols) {
      if (s.name.length >= 3 && !counts.has(s.name)) { counts.set(s.name, 0); }
    }
    if (counts.size > 0) {
      for (const c of chunks) {
        for (const tok of tokenize(c.content)) {
          const cur = counts.get(tok);
          if (cur !== undefined) { counts.set(tok, cur + 1); }
        }
      }
    }
    for (const s of symbols) { s.rank = counts.get(s.name) ?? 0; }
  }

  // ─── Stage 5 (replaced): BM25 inverted index ──────────────────────────────

  private async buildInvertedIndex(
    chunks: Chunk[],
    report?: ProgressReporter,
  ): Promise<{
    postings: Record<string, [number, number][]>;
    docLen: Record<number, number>;
    avgDocLen: number;
  }> {
    // IMPORTANT: use Object.create(null) so the postings map has NO prototype
    // chain. A plain {} inherits from Object.prototype, so a tokenized term
    // that happens to spell a built-in property ("toString", "hasOwnProperty",
    // "valueOf", "constructor", "length", "prototype", …) reads back the
    // inherited method instead of undefined, defeating `?? (... = [])` and
    // crashing later with ".push is not a function". Real source code
    // routinely contains those identifiers, so this is not a theoretical edge.
    const postings: Record<string, [number, number][]> =
      Object.create(null) as Record<string, [number, number][]>;
    const docLen: Record<number, number> = {};
    let totalLen = 0;
    let i = 0;
    for (const c of chunks) {
      const tokens = tokenize(c.content + ' ' + c.symbol);
      docLen[c.id] = tokens.length;
      totalLen += tokens.length;
      const tf = new Map<string, number>();
      for (const t of tokens) { tf.set(t, (tf.get(t) ?? 0) + 1); }
      for (const [term, freq] of tf) {
        (postings[term] ??= []).push([c.id, freq]);
      }
      // FLAW FIX: yield + sub-progress so the BM25 build doesn't look
      // like a freeze on large workspaces. Without this, the host thread
      // is blocked for the entire pass and the progress notification
      // can't paint anything between "Building lexical index… 75%" and
      // "Persisting… 92%" — which on big repos is the longest single
      // unyielding span in the whole build.
      if (++i % 200 === 0) {
        if (report) {
          report(
            `Building lexical index… ${i}/${chunks.length}`,
            75 + (i / chunks.length) * 15,
          );
        }
        await yieldToHost();
      }
    }
    return { postings, docLen, avgDocLen: chunks.length ? totalLen / chunks.length : 0 };
  }

  // ─── Repo-map outline (ranked, AI-free) ────────────────────────────────────

  private buildRepoMap(data: IndexData): string {
    const byFile = new Map<string, SymbolDef[]>();
    for (const s of data.symbols) {
      (byFile.get(s.file) ?? byFile.set(s.file, []).get(s.file)!).push(s);
    }
    // Rank files by their top symbol rank, then list their symbols.
    const fileRank = [...byFile.entries()]
      .map(([file, syms]) => ({ file, syms, top: Math.max(...syms.map(s => s.rank), 0) }))
      .sort((a, b) => b.top - a.top)
      .slice(0, 40);
    const lines: string[] = ['# Repo map (ranked symbol outline)'];
    for (const { file, syms } of fileRank) {
      lines.push(`\n${file}`);
      for (const s of syms.sort((a, b) => b.rank - a.rank).slice(0, 12)) {
        lines.push(`  ${s.kind} ${s.name}  (L${s.line}, refs=${s.rank})`);
      }
    }
    return lines.join('\n');
  }

  // ─── Persistence ────────────────────────────────────────────────────────────

  private async persist(data: IndexData): Promise<void> {
    fs.mkdirSync(this.indexDir, { recursive: true });
    const tmp = this.indexPath + '.tmp';
    // FLAW FIX: previously we did `fs.writeFileSync(tmp, JSON.stringify(data))`
    // which builds the ENTIRE serialized index as ONE JavaScript string.
    // On large workspaces (thousands of chunks containing source-text +
    // dense BM25 postings) that single string can exceed V8's per-string
    // cap (~512MB on 64-bit, ~256MB on 32-bit) and JSON.stringify throws
    // `RangeError: Invalid string length` — which surfaces to the user as
    // "NEXUS indexing failed: Invalid string length" RIGHT at the end of
    // the build, after all the expensive work has succeeded.
    //
    // New plan: stream the JSON to disk via a WriteStream, calling
    // JSON.stringify on each top-level field (and on each individual
    // element of the two giant collections — `chunks` array and
    // `postings` object) instead of on the whole tree at once. We never
    // hold a single string larger than one chunk or one postings list,
    // and the file on disk is byte-for-byte the same JSON document.
    await new Promise<void>((resolve, reject) => {
      const ws = fs.createWriteStream(tmp);
      ws.on('error', reject);
      ws.on('finish', () => resolve());

      const writeStr = (s: string): Promise<void> =>
        new Promise<void>((res) => {
          if (ws.write(s)) { res(); }
          else { ws.once('drain', () => res()); }
        });

      (async () => {
        try {
          await writeStr('{');
          await writeStr(`"version":${JSON.stringify(data.version)}`);
          await writeStr(`,"createdAt":${JSON.stringify(data.createdAt)}`);
          await writeStr(`,"root":${JSON.stringify(data.root)}`);
          await writeStr(`,"avgDocLen":${JSON.stringify(data.avgDocLen)}`);
          // `files`, `symbols`, `merkle`, `docLen` are normally small
          // enough that one JSON.stringify is fine; if any of them ever
          // grows past V8's string limit we'd need to stream them too,
          // but in practice `chunks` and `postings` are the only ones
          // that get pathologically large.
          await writeStr(`,"files":${JSON.stringify(data.files)}`);
          await writeStr(`,"merkle":${JSON.stringify(data.merkle)}`);
          await writeStr(`,"symbols":${JSON.stringify(data.symbols)}`);
          await writeStr(`,"docLen":${JSON.stringify(data.docLen)}`);

          // Stream chunks as a JSON array, one element at a time.
          await writeStr(',"chunks":[');
          for (let i = 0; i < data.chunks.length; i++) {
            await writeStr((i === 0 ? '' : ',') + JSON.stringify(data.chunks[i]));
          }
          await writeStr(']');

          // Stream postings as a JSON object, one term at a time.
          await writeStr(',"postings":{');
          let first = true;
          for (const term of Object.keys(data.postings)) {
            await writeStr(
              (first ? '' : ',') +
              JSON.stringify(term) + ':' +
              JSON.stringify(data.postings[term]),
            );
            first = false;
          }
          await writeStr('}');

          await writeStr('}');
          ws.end();
        } catch (e) {
          ws.destroy(e as Error);
          reject(e);
        }
      })();
    });
    fs.renameSync(tmp, this.indexPath); // atomic-ish
  }

  private loadSafe(): IndexData | undefined {
    try {
      const data = JSON.parse(fs.readFileSync(this.indexPath, 'utf8')) as IndexData;
      if (data.version !== INDEX_VERSION) { return undefined; }
      // JSON.parse always produces objects with Object.prototype on their
      // chain. Re-home `postings` onto a null-proto object so query terms
      // that collide with built-in property names ("toString" etc.) read
      // back as undefined, not as the inherited method. Same hazard, same
      // fix as in buildInvertedIndex.
      if (data.postings && typeof data.postings === 'object') {
        const safe: Record<string, [number, number][]> =
          Object.create(null) as Record<string, [number, number][]>;
        for (const k of Object.keys(data.postings)) { safe[k] = data.postings[k]; }
        data.postings = safe;
      }
      return data;
    } catch { return undefined; }
  }

  private ensureGitignore(): void {
    const gi = path.join(this.root, '.gitignore');
    const entry = '.nexus/';
    try {
      let txt = '';
      try { txt = fs.readFileSync(gi, 'utf8'); } catch { /* none */ }
      if (!txt.split(/\r?\n/).some(l => l.trim() === entry || l.trim() === '.nexus')) {
        const sep = txt && !txt.endsWith('\n') ? '\n' : '';
        fs.appendFileSync(gi, `${sep}\n# NEXUS local codebase index\n${entry}\n`);
      }
    } catch { /* best effort */ }
  }

  private statsFrom(data: IndexData): IndexStats {
    let size = 0;
    try { size = fs.statSync(this.indexPath).size; } catch { /* ignore */ }
    return {
      fileCount: data.files.length,
      chunkCount: data.chunks.length,
      symbolCount: data.symbols.length,
      lastIndexed: data.createdAt,
      sizeOnDiskBytes: size,
    };
  }

  private toRel(abs: string): string {
    return path.relative(this.root, abs).split(path.sep).join('/');
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Split identifiers/camelCase/snake_case into lowercase searchable tokens. */
function tokenize(text: string): string[] {
  const raw = text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2') // camelCase split
    .toLowerCase()
    .split(/[^a-z0-9_]+/);
  const out: string[] = [];
  for (let t of raw) {
    t = t.replace(/^_+|_+$/g, '');
    if (t.length < 2 || t.length > 40) { continue; }
    if (STOPWORDS.has(t)) { continue; }
    out.push(t);
    // also index snake_case parts
    if (t.includes('_')) {
      for (const p of t.split('_')) { if (p.length >= 2 && !STOPWORDS.has(p)) { out.push(p); } }
    }
  }
  return out;
}

/** Yield to the event loop so the extension host stays responsive. */
function yieldToHost(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve));
}
