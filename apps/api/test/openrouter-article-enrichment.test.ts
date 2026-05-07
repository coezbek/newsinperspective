import { describe, expect, it } from "vitest";
import {
  looksTruncated,
  parseEnrichmentFromResponse,
} from "../src/services/openrouter-article-enrichment.js";

describe("looksTruncated", () => {
  it("accepts text ending with a period", () => {
    expect(looksTruncated("This is a complete sentence about a news event.")).toBe(false);
  });

  it("accepts text ending with closing quote / paren", () => {
    expect(looksTruncated('The minister said: "We will continue our efforts."')).toBe(false);
    expect(looksTruncated("They cited a 2026 study (Smith et al.)")).toBe(false);
    expect(looksTruncated("She replied, 'No comment.'")).toBe(false);
  });

  it("rejects text ending mid-word with a lowercase letter", () => {
    expect(looksTruncated("The investment doesn't quite match the result, the dress")).toBe(true);
  });

  it("rejects text ending with a comma or semicolon", () => {
    expect(looksTruncated("According to Defense Minister Pistorius,")).toBe(true);
    expect(looksTruncated("Officials confirmed the policy is now under review;")).toBe(true);
  });

  it("rejects text ending with a dangling connector", () => {
    expect(looksTruncated("They championed the championships 1952-1953 and 1953-1954 thanks to")).toBe(true);
    expect(looksTruncated("This is the kind of victory that leads to and")).toBe(true);
    expect(looksTruncated("She said this could change the")).toBe(true);
  });

  it("does not flag short snippets (length < 50)", () => {
    // Below the confidence threshold; we don't want to retry a 30-word
    // newsworthy snippet just because it happens to end on a comma.
    expect(looksTruncated("Short stub,")).toBe(false);
  });

  it("accepts text ending with question or exclamation marks", () => {
    expect(looksTruncated("Would the plan actually work in practice now?")).toBe(false);
    expect(looksTruncated("The crowd cheered as he raised the trophy high!")).toBe(false);
  });

  it("accepts text with trailing whitespace", () => {
    expect(looksTruncated("This sentence ends correctly.   \n  ")).toBe(false);
  });

  it("accepts stylistic em/en dashes at end (pull-quote markers, not truncation)", () => {
    expect(looksTruncated("The whole point is that things were different—")).toBe(false);
    expect(looksTruncated("She remembered exactly what was said before–")).toBe(false);
  });

  it("does not flag trailing capital-letter abbreviations (USA, IRA, NATO)", () => {
    // Lowercase-only function-word check means a sentence ending with an
    // all-caps proper noun isn't mistaken for a dangling article. Previously
    // the /i flag false-tripped on "USA" because of the trailing "A".
    expect(looksTruncated("The agreement was signed by USA")).toBe(false);
    expect(looksTruncated("Founded in the early years of the IRA")).toBe(false);
  });
});

describe("parseEnrichmentFromResponse", () => {
  it("extracts bodyAppearsTruncated=true", () => {
    const json =
      '{"isNewsworthy":true,"keywords":["x"],"translatedTitle":"t","translatedSummary":"s","translatedFullText":"body","persons":[],"organizations":[],"places":[],"language":"en","bodyAppearsTruncated":true}';
    const out = parseEnrichmentFromResponse(json);
    expect(out?.bodyAppearsTruncated).toBe(true);
  });

  it("extracts bodyAppearsTruncated=false", () => {
    const json =
      '{"isNewsworthy":true,"keywords":[],"translatedTitle":null,"translatedSummary":null,"translatedFullText":"complete body.","persons":[],"organizations":[],"places":[],"language":"en","bodyAppearsTruncated":false}';
    const out = parseEnrichmentFromResponse(json);
    expect(out?.bodyAppearsTruncated).toBe(false);
  });

  it("returns bodyAppearsTruncated=null when the field is missing (older cached responses)", () => {
    const json =
      '{"isNewsworthy":true,"keywords":[],"translatedTitle":null,"translatedSummary":null,"translatedFullText":"old cached body.","persons":[],"organizations":[],"places":[],"language":"en"}';
    const out = parseEnrichmentFromResponse(json);
    expect(out?.bodyAppearsTruncated).toBeNull();
  });

  it("returns bodyAppearsTruncated=null when the model returned a non-boolean value", () => {
    const json =
      '{"isNewsworthy":true,"keywords":[],"translatedTitle":null,"translatedSummary":null,"translatedFullText":"body.","persons":[],"organizations":[],"places":[],"language":"en","bodyAppearsTruncated":"maybe"}';
    const out = parseEnrichmentFromResponse(json);
    expect(out?.bodyAppearsTruncated).toBeNull();
  });

  it("returns null on garbage", () => {
    expect(parseEnrichmentFromResponse("not json at all")).toBeNull();
    expect(parseEnrichmentFromResponse("{ broken json")).toBeNull();
  });

  it("drops sub-floor framingSummary stubs (would give SBERT random embeddings)", () => {
    const stub = "The article reports.";
    const json = JSON.stringify({
      isNewsworthy: true,
      keywords: [],
      translatedTitle: "t",
      translatedSummary: "s",
      translatedFullText: "Complete body that ends with a period.",
      framingSummary: stub,
      persons: [],
      organizations: [],
      places: [],
      language: "en",
    });
    const out = parseEnrichmentFromResponse(json);
    expect(out?.framingSummary).toBeNull();
  });

  it("drops over-ceiling framingSummary outputs (model echoed the body)", () => {
    const runaway = "x".repeat(5000) + ".";
    const json = JSON.stringify({
      isNewsworthy: true,
      keywords: [],
      translatedTitle: "t",
      translatedSummary: "s",
      translatedFullText: "body.",
      framingSummary: runaway,
      persons: [],
      organizations: [],
      places: [],
      language: "en",
    });
    const out = parseEnrichmentFromResponse(json);
    expect(out?.framingSummary).toBeNull();
  });

  it("accepts a well-formed framingSummary in the 200-4000 char band", () => {
    const summary =
      "The piece treats Zoom's macOS client as a recurring offender, framing the two new flaws as predictable rather than surprising. The author emphasises that both issues stem from the same architectural pattern. Quotes from the disclosing researcher dominate; Zoom's response is summarised in one line. The framing centres on vendor accountability rather than user mitigation.";
    const json = JSON.stringify({
      isNewsworthy: true,
      keywords: [],
      translatedTitle: "t",
      translatedSummary: "s",
      translatedFullText: "body.",
      framingSummary: summary,
      persons: [],
      organizations: [],
      places: [],
      language: "en",
    });
    const out = parseEnrichmentFromResponse(json);
    expect(out?.framingSummary).toBe(summary);
  });

  it("nulls framingSummary when isNewsworthy=false even if model populated it", () => {
    // Hallucinating model: returns isNewsworthy=false but still emits
    // framing/translation fields. Parser must enforce the invariant so
    // boilerplate doesn't pollute SBERT input or display surfaces.
    const summary = "x".repeat(800);
    const json = JSON.stringify({
      isNewsworthy: false,
      notNewsworthyReason: "corporate boilerplate",
      keywords: ["should-not-survive"],
      translatedTitle: "should-not-survive",
      translatedSummary: "should-not-survive",
      translatedFullText: "should-not-survive",
      framingSummary: summary,
      persons: ["Some Person"],
      organizations: ["JTBC"],
      places: [],
      language: "en",
    });
    const out = parseEnrichmentFromResponse(json);
    expect(out?.isNewsworthy).toBe(false);
    expect(out?.framingSummary).toBeNull();
    expect(out?.translatedTitle).toBeNull();
    expect(out?.translatedSummary).toBeNull();
    expect(out?.translatedFullText).toBeNull();
    expect(out?.keywords).toEqual([]);
    // Entity arrays stay populated — they're factual extractions and useful
    // for entity-graph linking even on non-newsworthy pages.
    expect(out?.organizations).toEqual(["JTBC"]);
  });
});
