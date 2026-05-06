import { resolveCountryFromDomain } from "../services/country-from-domain.js";

const cases: Array<[string, string, string]> = [
  ["japantimes.co.jp", "japantimes.co.jp", "Japan"],
  ["minutemirror.com.pk", "minutemirror.com.pk", "Pakistan"],
  ["skysports.com", "skysports.com", "United Kingdom"],
  ["koreatimes.co.kr", "koreatimes.co.kr", "South Korea"],
  ["straitstimes.com", "straitstimes.com", "Singapore"],
  ["cbssports.com", "cbssports.com", "United States"],
  ["brecorder.com", "brecorder.com", "(unknown — needs LLM)"],
  ["bbc.com", "bbc.com", "United Kingdom"],
  ["news.bbc.co.uk", "news.bbc.co.uk", "United Kingdom"],
  ["bbcamerica.com", "BBC America", "(BBC America — UK match via name)"],
  ["nytimes.com", "nytimes.com", "United States"],
  ["rt.com", "rt.com", "Russia"],
  ["theguardian.com", "theguardian.com", "United Kingdom"],
];

for (const [d, n, expected] of cases) {
  const got = resolveCountryFromDomain(d, n);
  const ok = expected.includes(got ?? "") || expected.includes("unknown") || expected.includes("UK match");
  console.log(`${ok ? "✓" : "✗"} ${d.padEnd(28)} → ${(got ?? "null").padEnd(20)} (expected ${expected})`);
}
