import { describe, it, expect } from "vitest";
import { parseSelectedDoctrineDocIds } from "../lib/profile-helpers";

const docs = [
  { id: "doc-1", title: "Brand Voice Guide" },
  { id: "doc-2", title: "Q3 Launch Plan" },
  { id: "doc-3", title: "Field Manual v2" },
];

describe("parseSelectedDoctrineDocIds", () => {
  it("returns empty when doctrine is null/empty", () => {
    expect(parseSelectedDoctrineDocIds(null, docs)).toEqual([]);
    expect(parseSelectedDoctrineDocIds("", docs)).toEqual([]);
  });

  it("matches `- <title>` reference lines to doc ids (picker-only, no divider)", () => {
    // The current marketplace writes picker-only content with no
    // divider — every line in the textarea is a reference line.
    const doctrine = ["- Brand Voice Guide", "- Field Manual v2"].join("\n");
    expect(parseSelectedDoctrineDocIds(doctrine, docs)).toEqual([
      "doc-1",
      "doc-3",
    ]);
  });

  it("ignores prose below the legacy `--- Orders ---` divider", () => {
    // Legacy rows saved before the picker-only redesign carry an
    // `--- Orders ---` divider with free-form prose below — anything
    // below the divider must not be parsed as a ticked doc, even
    // when it happens to look like a Markdown bullet.
    const doctrine = [
      "- Brand Voice Guide",
      "",
      "--- Orders ---",
      "- Field Manual v2 (mentioned in orders, but not actually ticked)",
      "Some other free-form prose.",
    ].join("\n");
    expect(parseSelectedDoctrineDocIds(doctrine, docs)).toEqual(["doc-1"]);
  });

  it("dedupes when the same title appears twice", () => {
    const doctrine = "- Brand Voice Guide\n- Brand Voice Guide";
    expect(parseSelectedDoctrineDocIds(doctrine, docs)).toEqual(["doc-1"]);
  });

  it("ignores titles that aren't in the operator's preset doc set", () => {
    const doctrine = "- Brand Voice Guide\n- Some Other Doc Not In Preset";
    expect(parseSelectedDoctrineDocIds(doctrine, docs)).toEqual(["doc-1"]);
  });

  it("treats the whole textarea as references when no divider is present", () => {
    const doctrine = "- Brand Voice Guide\n- Q3 Launch Plan";
    expect(parseSelectedDoctrineDocIds(doctrine, docs)).toEqual([
      "doc-1",
      "doc-2",
    ]);
  });
});
