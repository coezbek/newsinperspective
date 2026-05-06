import { describe, expect, it } from "vitest";
import { extractSummary, isDisambiguationLike } from "../src/services/entity-linker.js";

describe("extractSummary", () => {
  it("returns undefined for missing input", () => {
    expect(extractSummary(undefined)).toBeUndefined();
    expect(extractSummary("")).toBeUndefined();
  });

  it("does not truncate after Inc.", () => {
    const extract =
      "eBay Inc. ( EE-bay, styled as ebay) is an American multinational e-commerce company based in San Jose, California. Sales occur via online auctions or 'buy it now' instant sales.";
    const out = extractSummary(extract)!;
    expect(out.startsWith("eBay Inc. ( EE-bay")).toBe(true);
    expect(out).toContain("e-commerce company");
  });

  it("does not truncate after Jr.", () => {
    const extract =
      "Joseph Robinette Biden Jr. (born November 20, 1942) is an American politician who was the 46th president of the United States from 2021 to 2025.";
    const out = extractSummary(extract)!;
    expect(out).toContain("Biden Jr.");
    expect(out).toContain("46th president");
  });

  it("does not truncate after a single-letter middle initial", () => {
    const extract = "Calvin H. Borel (born November 7, 1966) is an American jockey.";
    const out = extractSummary(extract)!;
    expect(out).toContain("Calvin H. Borel");
    expect(out).toContain("jockey");
  });

  it("does not truncate after dotted acronyms like U.S. or F.C.", () => {
    const extract =
      "The U.S. Senate is the upper chamber of Congress. It has 100 members.";
    const out = extractSummary(extract)!;
    expect(out).toContain("U.S. Senate");
    expect(out).toContain("upper chamber");
  });

  it("still splits on legitimate sentence ends", () => {
    const extract = "Foo is a thing. Bar is another thing. Baz is yet another.";
    const out = extractSummary(extract)!;
    // All three sentences fit within budget.
    expect(out).toContain("Foo");
    expect(out).toContain("Bar");
    expect(out).toContain("Baz");
  });

  it("caps at MAX_SENTENCES (5)", () => {
    const sents = Array.from({ length: 10 }, (_, i) => `Sentence ${i + 1} text.`).join(" ");
    const out = extractSummary(sents)!;
    expect(out).toContain("Sentence 5");
    expect(out).not.toContain("Sentence 6");
  });
});

describe("isDisambiguationLike", () => {
  it("flags titles ending with (disambiguation)", () => {
    expect(
      isDisambiguationLike({ title: "Napoli (disambiguation)", pageid: 1, ns: 0 }),
    ).toBe(true);
  });

  it("flags (surname) and (given name) and (name) suffixes", () => {
    expect(isDisambiguationLike({ title: "Bilger (surname)", pageid: 1, ns: 0 })).toBe(true);
    expect(isDisambiguationLike({ title: "Giovanni (name)", pageid: 1, ns: 0 })).toBe(true);
    expect(isDisambiguationLike({ title: "Mary (given name)", pageid: 1, ns: 0 })).toBe(true);
  });

  it('flags snippets containing "may refer to"', () => {
    expect(
      isDisambiguationLike({
        title: "Mercury",
        pageid: 1,
        ns: 0,
        snippet: 'Mercury <span class="searchmatch">may</span> refer to: ...',
      }),
    ).toBe(true);
  });

  it("does not flag normal article titles", () => {
    expect(isDisambiguationLike({ title: "EBay", pageid: 130495, ns: 0 })).toBe(false);
    expect(isDisambiguationLike({ title: "TD Securities", pageid: 22683060, ns: 0 })).toBe(false);
    expect(isDisambiguationLike({ title: "GameStop", pageid: 994639, ns: 0 })).toBe(false);
  });
});
