import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { enrichSourceProfileFromWikidata, trimToSentence } from "../src/services/source-profile-wikidata.js";

type MockResponse = { ok: boolean; status?: number; json: () => Promise<unknown> };

function jsonRes(body: unknown, ok = true, status = 200): MockResponse {
  return { ok, status, json: async () => body };
}

function mockFetchByPredicate(
  match: (url: string) => MockResponse | Promise<MockResponse> | null,
): void {
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    const r = match(url);
    if (!r) throw new Error(`Unexpected fetch to ${url}`);
    return (await r) as unknown as Response;
  }));
}

describe("trimToSentence", () => {
  it("returns short text unchanged", () => {
    expect(trimToSentence("hello world", 280)).toBe("hello world");
  });

  it("trims at sentence boundary near max", () => {
    const text = "First sentence here. Second sentence is also short.";
    expect(trimToSentence(text, 22)).toBe("First sentence here.");
  });
});

describe("enrichSourceProfileFromWikidata", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("resolves npr.org and returns rich profile", async () => {
    mockFetchByPredicate((url) => {
      if (url.includes("wbsearchentities")) {
        if (url.includes("search=NPR")) {
          return jsonRes({
            search: [
              { id: "Q671510", label: "NPR", description: "American non-profit media organization" },
            ],
          });
        }
        return jsonRes({ search: [] });
      }
      if (url.includes("query.wikidata.org/sparql")) {
        return jsonRes({
          results: {
            bindings: [
              {
                item: { type: "uri", value: "http://www.wikidata.org/entity/Q671510" },
                website: { type: "uri", value: "https://www.npr.org/" },
                countryLabel: { type: "literal", value: "United States of America" },
                hqLabel: { type: "literal", value: "Washington, D.C." },
                ownerLabel: { type: "literal", value: "NPR Foundation" },
                employees: { type: "literal", value: "1141" },
                article: { type: "uri", value: "https://en.wikipedia.org/wiki/NPR" },
              },
            ],
          },
        });
      }
      if (url.includes("/page/summary/")) {
        return jsonRes({
          extract:
            "National Public Radio is an American non-profit media organization headquartered in Washington, D.C. It serves as a national syndicator to a network of over 1,000 public radio stations.",
        });
      }
      return null;
    });

    const result = await enrichSourceProfileFromWikidata({ domain: "npr.org", sourceName: "NPR" });
    expect(result).not.toBeNull();
    expect(result!.wikidataId).toBe("Q671510");
    expect(result!.country).toBe("United States of America");
    expect(result!.headquarters).toBe("Washington, D.C.");
    expect(result!.mediaOwner).toBe("NPR Foundation");
    expect(result!.wikipediaUrl).toBe("https://en.wikipedia.org/wiki/NPR");
    expect(result!.employeeCount).toBe(1141);
    expect(result!.model).toBe("wikidata");
    expect(result!.description).toMatch(/National Public Radio/);
  });

  it("rejects candidate when P856 host does not match the domain", async () => {
    mockFetchByPredicate((url) => {
      if (url.includes("wbsearchentities")) {
        if (url.includes("Some")) {
          return jsonRes({ search: [{ id: "Q999999", label: "Some Other Org" }] });
        }
        return jsonRes({ search: [] });
      }
      if (url.includes("query.wikidata.org/sparql")) {
        return jsonRes({
          results: {
            bindings: [
              {
                item: { type: "uri", value: "http://www.wikidata.org/entity/Q999999" },
                website: { type: "uri", value: "https://example.com/" },
              },
            ],
          },
        });
      }
      return null;
    });

    const result = await enrichSourceProfileFromWikidata({
      domain: "npr.org",
      sourceName: "Some Other Org",
    });
    expect(result).toBeNull();
  });

  it("returns null when wbsearchentities yields no candidates", async () => {
    mockFetchByPredicate((url) => {
      if (url.includes("wbsearchentities")) return jsonRes({ search: [] });
      return null;
    });
    const result = await enrichSourceProfileFromWikidata({
      domain: "nonexistent.example",
      sourceName: "Nonexistent",
    });
    expect(result).toBeNull();
  });
});
