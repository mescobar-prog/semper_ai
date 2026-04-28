import { describe, it, expect } from "vitest";
import { chunkText, CHUNKER_MAX_CHARS, CHUNKER_MAX_TOKENS } from "./chunker";

describe("chunkText", () => {
  it("returns [] for empty input", () => {
    expect(chunkText("")).toEqual([]);
    expect(chunkText("   \n  \t ")).toEqual([]);
  });

  it("emits a single chunk for short text", () => {
    const out = chunkText("This is a short doc with one paragraph.");
    expect(out).toHaveLength(1);
    expect(out[0].content).toContain("short doc");
    expect(out[0].headingTrail).toBe("");
  });

  it("preserves heading trail across blocks under one heading", () => {
    const text = `# Field Manual

## Chapter 4

### Reconnaissance

A reconnaissance patrol gathers information about the enemy.
The patrol leader maintains stealth at all times.
`;
    const out = chunkText(text);
    expect(out.length).toBeGreaterThan(0);
    const last = out[out.length - 1];
    expect(last.headingTrail).toBe(
      "Field Manual > Chapter 4 > Reconnaissance",
    );
  });

  it("recognises pseudo-headings without # markers", () => {
    const text = `Chapter 4: Reconnaissance

The recon team moves at dusk.
`;
    const out = chunkText(text);
    expect(out.some((c) => c.headingTrail.includes("Chapter 4"))).toBe(true);
  });

  it("respects the max-chars cap on long single paragraphs", () => {
    // Generate a long paragraph of varied sentences so the splitter has
    // boundaries to work with.
    const sentences = Array.from(
      { length: 200 },
      (_, i) =>
        `Sentence number ${i} discusses tactical considerations relevant to the recon mission.`,
    );
    const text = sentences.join(" ");
    const out = chunkText(text);
    expect(out.length).toBeGreaterThan(2);
    for (const c of out) {
      // Hard cap: MAX_TOKENS * CHARS_PER_TOKEN. The chunker enforces this
      // exactly — every code path either appends within target, flushes
      // before exceeding, or hard-slices at MAX_CHARS.
      expect(c.content.length).toBeLessThanOrEqual(CHUNKER_MAX_CHARS);
    }
  });

  it("keeps every chunk inside the embedder's token budget on adversarial input", () => {
    // Build a multi-thousand-character single paragraph with NO headings and
    // NO blank lines — the structure-aware splitter has nothing to grip on
    // except sentence boundaries, exercising the brute-split fallback path.
    const giantParagraph = Array.from(
      { length: 800 },
      (_, i) =>
        `Adversarial sentence ${i} mentions reconnaissance, MEDEVAC, and CASEVAC procedures with deliberate verbosity to inflate the token count beyond any reasonable per-chunk budget.`,
    ).join(" ");
    // And a no-whitespace "wall of text" pathological case where even
    // sentence splitting gives nothing useful — the hard char-split must
    // still keep us within budget.
    const wallOfText = "x".repeat(20000);

    for (const input of [giantParagraph, wallOfText]) {
      const out = chunkText(input);
      expect(out.length).toBeGreaterThan(0);
      for (const c of out) {
        // Strict caps, no tolerance: this is the invariant retrieval depends
        // on. Estimated tokens are derived from char length so they cap at
        // ceil(MAX_CHARS / 4) === MAX_TOKENS.
        expect(c.content.length).toBeLessThanOrEqual(CHUNKER_MAX_CHARS);
        expect(c.estimatedTokens).toBeLessThanOrEqual(CHUNKER_MAX_TOKENS);
      }
    }
  });

  it("creates overlap between adjacent chunks", () => {
    const sentences = Array.from(
      { length: 80 },
      (_, i) =>
        `Sentence ${i} contains a unique marker word zeta-${i} for tracking.`,
    );
    const text = sentences.join(" ");
    const out = chunkText(text);
    expect(out.length).toBeGreaterThan(1);
    // The tail of the first chunk should appear at the head of the second.
    const tail = out[0].content.slice(-100);
    const head = out[1].content.slice(0, 200);
    // We don't expect a perfect substring match (sentence boundary trimming
    // can shift it), so look for a unique marker that ought to live in both.
    const tailMarkers: string[] = tail.match(/zeta-\d+/g) ?? [];
    const headMarkers: string[] = head.match(/zeta-\d+/g) ?? [];
    const overlap = tailMarkers.filter((m) => headMarkers.includes(m));
    expect(overlap.length).toBeGreaterThan(0);
  });

  it("estimates token counts roughly proportional to char count", () => {
    const text = "abc ".repeat(100); // 400 chars
    const out = chunkText(text);
    expect(out[0].estimatedTokens).toBeGreaterThan(80);
    expect(out[0].estimatedTokens).toBeLessThan(120);
  });

  it("strips heading markers from content but tracks them in the heading trail", () => {
    const text = `Some intro text that explains the document context briefly.

# Section One
The first section talks about training schedules.

# Section Two
The second section discusses logistics.
`;
    const out = chunkText(text);
    // No chunk content should retain the raw `#` marker — that markup is
    // captured in `headingTrail` instead, so it never contributes to the
    // embedded vector or the displayed snippet body.
    for (const c of out) {
      expect(c.content).not.toMatch(/^#\s/m);
    }
    // The final chunk should have advanced its trail to "Section Two".
    const last = out[out.length - 1];
    expect(last.headingTrail).toBe("Section Two");
    expect(last.content).toContain("logistics");
  });
});
