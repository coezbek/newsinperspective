import { describe, expect, it } from "vitest";
import { extractTranslation } from "../src/scripts/cluster-translate-titles-llm.js";

describe("extractTranslation", () => {
  const original = "Brent premašio 125 dolara zbog blokade iranskih luka";

  it("returns null for empty / whitespace input", () => {
    expect(extractTranslation("", original)).toBeNull();
    expect(extractTranslation("   ", original)).toBeNull();
  });

  it("strips a 'Translation:' prefix and surrounding quotes", () => {
    expect(
      extractTranslation('Translation: "Brent surpasses 125 dollars due to blockade"', original),
    ).toBe("Brent surpasses 125 dollars due to blockade");
    expect(
      extractTranslation("'Brent surpasses 125 dollars due to blockade'", original),
    ).toBe("Brent surpasses 125 dollars due to blockade");
  });

  it("accepts a plausible translation", () => {
    expect(
      extractTranslation(
        "Brent surpasses 125 dollars due to blockade of Iranian ports",
        original,
      ),
    ).toBe("Brent surpasses 125 dollars due to blockade of Iranian ports");
  });

  it("rejects a fragment with leading punctuation (smoke-test bug case)", () => {
    expect(extractTranslation("'s Fall to EuropeanMixing", "Ancient DNA links Rome's fall to European mixing")).toBeNull();
  });

  it("rejects word-fusion glitches like 'beatAtlético' when the original is plain", () => {
    // Free-tier model glitch observed in smoke test.
    expect(
      extractTranslation(
        "Arsenal beatAtlético to reach Champions League final",
        "Arsenal beat Atlético to reach Champions League final",
      ),
    ).toBeNull();
  });

  it("preserves legit camelCase brand names (iPhone, eBay)", () => {
    expect(
      extractTranslation(
        "Apple unveils new iPhone camera system",
        "Apple presenta el nuevo sistema de cámara del iPhone",
      ),
    ).toBe("Apple unveils new iPhone camera system");
    expect(
      extractTranslation("eBay reports record holiday sales", "eBay informa ventas récord de fiestas"),
    ).toBe("eBay reports record holiday sales");
  });

  it("rejects an output that is identical to the input", () => {
    expect(extractTranslation(original, original)).toBeNull();
  });

  it("rejects an output dramatically shorter than a long original", () => {
    const longOriginal = "A very long Romanian headline about parliamentary politics and economic policy, including details about coalitions";
    expect(extractTranslation("Politics", longOriginal)).toBeNull();
  });

  it("rejects an all-caps output (model glitch)", () => {
    expect(extractTranslation("RUSSIAN STRIKES KILL MORE THAN 20", "Russian strikes kill more than 20 across Ukrainian cities")).toBeNull();
  });

  it("rejects refusals from the model", () => {
    expect(extractTranslation("I cannot translate this text.", original)).toBeNull();
    expect(extractTranslation("Sorry, no translation is available.", original)).toBeNull();
    expect(extractTranslation("As an AI language model, I cannot...", original)).toBeNull();
  });

  it("rejects mostly non-ASCII output (model returned the original)", () => {
    expect(extractTranslation("Цените на нафтата скокнаа над 120 долари", "Brent surpasses 125 dollars")).toBeNull();
  });

  it("takes only the first non-empty line", () => {
    expect(
      extractTranslation(
        "Brent surpasses 125 dollars due to blockade of Iranian ports\n\nThis is a translation of the Croatian headline.",
        original,
      ),
    ).toBe("Brent surpasses 125 dollars due to blockade of Iranian ports");
  });
});
