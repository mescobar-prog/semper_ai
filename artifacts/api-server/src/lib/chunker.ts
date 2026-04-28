/**
 * Token- and structure-aware chunker.
 *
 * Goals:
 *  - Respect a token budget instead of a character count, since the embedding
 *    model has a 256-token input limit and we want chunks to be retrievable
 *    units rather than arbitrary character ranges.
 *  - Prefer to split on document structure (Markdown-style headings, then
 *    blank lines, then sentences) before falling back to brute splitting, so
 *    each emitted chunk is a coherent passage.
 *  - Carry a small overlap between adjacent chunks so a query that lands near
 *    a boundary still finds context.
 *  - Tag each chunk with a heading trail (e.g. "FM 3-21.8 > Ch. 4 >
 *    Reconnaissance") so future ranking and citation rendering have semantic
 *    context to work with.
 *
 * The chunker is deliberately synchronous and pure: it estimates token counts
 * with a fast char/token ratio so it stays unit-testable without loading the
 * embedding model. Real per-chunk token counts are recomputed by the
 * embedding pipeline and persisted on the row.
 */

const TARGET_TOKENS = 500;
const MAX_TOKENS = 800;
const OVERLAP_TOKENS = 50;
// Approximate chars-per-token for English prose. Used for the synchronous
// budget in this chunker; the embedder later writes the *actual* count.
const CHARS_PER_TOKEN = 4;

const TARGET_CHARS = TARGET_TOKENS * CHARS_PER_TOKEN;
const MAX_CHARS = MAX_TOKENS * CHARS_PER_TOKEN;
const OVERLAP_CHARS = OVERLAP_TOKENS * CHARS_PER_TOKEN;

export interface Chunk {
  /** The chunk text (already trimmed). */
  content: string;
  /** Estimated token count using the chunker's char/token heuristic. */
  estimatedTokens: number;
  /** Heading trail (e.g. "Doc title > Ch 4 > Recon"); empty string if none. */
  headingTrail: string;
}

interface Block {
  text: string;
  /** Heading depth if this block is itself a heading line, else 0. */
  headingDepth: number;
  /** The heading trail in effect *before* this block (so headings own their
   *  parent's trail; the heading itself becomes part of the trail for the
   *  blocks that follow it). */
  trail: string[];
}

const HEADING_RE = /^(#{1,6})\s+(.+?)\s*$/;
// Recognise common doctrine/military heading shapes that lack '#':
//   "Chapter 4: Reconnaissance"
//   "Section II - Patrol Base Operations"
//   "Appendix A. References"
//   "1.2.3 Attack Order"
const PSEUDO_HEADING_RE =
  /^(?:chapter\s+\d+|section\s+[ivxlcdm\d]+|appendix\s+[a-z]|annex\s+[a-z]|part\s+[ivxlcdm\d]+|\d+(?:\.\d+){0,3})[:.\s-]\s*\S/i;

function isPseudoHeading(line: string): boolean {
  const t = line.trim();
  if (t.length === 0 || t.length > 120) return false;
  return PSEUDO_HEADING_RE.test(t);
}

function splitBlocks(text: string): Block[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  // Stack of headings indexed by depth (1..6 for markdown; 1 for pseudo).
  const trailStack: { depth: number; title: string }[] = [];
  let currentTrail: string[] = [];
  let buf: string[] = [];

  const flushBuf = () => {
    if (buf.length === 0) return;
    const joined = buf.join("\n").trim();
    buf = [];
    if (joined.length === 0) return;
    blocks.push({ text: joined, headingDepth: 0, trail: [...currentTrail] });
  };

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (line.length === 0) {
      flushBuf();
      continue;
    }

    const md = HEADING_RE.exec(line);
    if (md) {
      flushBuf();
      const depth = md[1].length;
      const title = md[2].trim();
      // Pop deeper-or-equal-depth entries before pushing this heading.
      while (
        trailStack.length > 0 &&
        trailStack[trailStack.length - 1].depth >= depth
      ) {
        trailStack.pop();
      }
      blocks.push({
        text: title,
        headingDepth: depth,
        trail: [...currentTrail],
      });
      trailStack.push({ depth, title });
      currentTrail = trailStack.map((s) => s.title);
      continue;
    }

    if (isPseudoHeading(line)) {
      flushBuf();
      const title = line.trim();
      // Treat pseudo-headings as a single shallow level so doctrine docs
      // produce a meaningful trail without exploding into deep nesting.
      while (
        trailStack.length > 0 &&
        trailStack[trailStack.length - 1].depth >= 1
      ) {
        trailStack.pop();
      }
      blocks.push({ text: title, headingDepth: 1, trail: [...currentTrail] });
      trailStack.push({ depth: 1, title });
      currentTrail = trailStack.map((s) => s.title);
      continue;
    }

    buf.push(line);
  }
  flushBuf();
  return blocks;
}

function splitSentences(text: string): string[] {
  // Conservative splitter: break on .?! followed by whitespace + capital or
  // newline. Falls back to whole-text if no boundary found.
  const parts = text.split(/(?<=[.!?])\s+(?=[A-Z(\["'`])/);
  return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

function trailToString(trail: string[]): string {
  // Cap trail depth and per-segment length so headings don't dominate the
  // chunk row's storage or downstream prompts.
  return trail
    .slice(-4)
    .map((s) => (s.length > 60 ? s.slice(0, 57) + "..." : s))
    .join(" > ");
}

function approxTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

function takeOverlap(prev: string): string {
  if (prev.length <= OVERLAP_CHARS) return prev;
  // Prefer a sentence boundary inside the overlap window for cleaner reads.
  const tail = prev.slice(-OVERLAP_CHARS * 2);
  const sentenceMatch = tail.match(/[.!?]\s+(?=[A-Z(\["'`])([\s\S]+)$/);
  if (sentenceMatch && sentenceMatch[1].length <= OVERLAP_CHARS * 1.2) {
    return sentenceMatch[1].trim();
  }
  return prev.slice(-OVERLAP_CHARS).trim();
}

interface PendingChunk {
  text: string;
  trail: string[];
}

function pushChunk(out: Chunk[], pending: PendingChunk): void {
  const text = pending.text.trim();
  if (text.length === 0) return;
  out.push({
    content: text,
    estimatedTokens: approxTokens(text),
    headingTrail: trailToString(pending.trail),
  });
}

export function chunkText(content: string): Chunk[] {
  const normalized = content.replace(/\r\n/g, "\n").trim();
  if (normalized.length === 0) return [];

  const blocks = splitBlocks(normalized);
  const out: Chunk[] = [];
  let pending: PendingChunk = { text: "", trail: [] };

  const flushPending = () => {
    if (pending.text.trim().length === 0) return;
    pushChunk(out, pending);
    const overlap = takeOverlap(pending.text);
    pending = {
      text: overlap,
      // Inherit the trail in effect at the *end* of the previous chunk so
      // overlap continues to read sensibly.
      trail: pending.trail,
    };
  };

  for (const block of blocks) {
    // Headings flush so they sit at the top of the next chunk, not buried in
    // the previous one. They contribute the title text too because operators
    // sometimes search by heading.
    if (block.headingDepth > 0) {
      flushPending();
      pending.trail = block.trail.concat(block.text);
      pending.text = pending.text
        ? `${pending.text}\n\n${block.text}`
        : block.text;
      continue;
    }

    pending.trail = block.trail;

    // Block fits comfortably — append.
    const candidate = pending.text
      ? `${pending.text}\n\n${block.text}`
      : block.text;
    if (candidate.length <= TARGET_CHARS) {
      pending.text = candidate;
      continue;
    }

    // Block is huge by itself — split on sentences.
    if (block.text.length > MAX_CHARS) {
      flushPending();
      const sentences = splitSentences(block.text);
      let buf = pending.text;
      for (const sentence of sentences) {
        const next = buf ? `${buf} ${sentence}` : sentence;
        if (next.length > TARGET_CHARS && buf.length > 0) {
          pushChunk(out, { text: buf, trail: pending.trail });
          buf = `${takeOverlap(buf)} ${sentence}`.trim();
        } else if (next.length > MAX_CHARS) {
          // Pathological single sentence — hard-split on chars.
          let remainder = next;
          while (remainder.length > MAX_CHARS) {
            const head = remainder.slice(0, MAX_CHARS);
            pushChunk(out, { text: head, trail: pending.trail });
            remainder = takeOverlap(head) + remainder.slice(MAX_CHARS);
          }
          buf = remainder;
        } else {
          buf = next;
        }
      }
      pending.text = buf;
      continue;
    }

    // Adding this block would exceed the target — flush and start fresh
    // with the overlap from the previous chunk.
    flushPending();
    pending.text = pending.text
      ? `${pending.text}\n\n${block.text}`
      : block.text;
    if (pending.text.length > MAX_CHARS) {
      // Still oversize after overlap: trim down to target.
      pushChunk(out, {
        text: pending.text.slice(0, MAX_CHARS),
        trail: pending.trail,
      });
      pending = {
        text: takeOverlap(pending.text.slice(0, MAX_CHARS)),
        trail: pending.trail,
      };
    }
  }

  if (pending.text.trim().length > 0) {
    pushChunk(out, pending);
  }

  return out;
}
