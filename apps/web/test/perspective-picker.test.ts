import { describe, expect, it } from "vitest";
import { pickTopSourcesByExtremity } from "../src/lib/perspective-picker.js";

describe("pickTopSourcesByExtremity", () => {
  it("returns empty when n <= 0 or no sources", () => {
    expect(
      pickTopSourcesByExtremity({ matrix: {}, sources: [], articleCounts: new Map(), n: 5 }),
    ).toEqual([]);
    expect(
      pickTopSourcesByExtremity({
        matrix: { a: { b: 0.5 } },
        sources: ["a", "b"],
        articleCounts: new Map(),
        n: 0,
      }),
    ).toEqual([]);
  });

  it("ranks the most extreme source first, the most central source last", () => {
    // Geometry: A is far from both B and C (mean ≈ 0.55).
    //           B is close to C, far from A      (mean ≈ 0.35).
    //           C is close to B, far from A      (mean ≈ 0.35).
    // Article counts are inverted on purpose — wire-service-like sources have
    // high article counts but low extremity. The picker must NOT promote them.
    const matrix = {
      A: { B: 0.6, C: 0.5 },
      B: { A: 0.6, C: 0.1 },
      C: { A: 0.5, B: 0.1 },
    };
    const counts = new Map([
      ["A", 1], // outlier
      ["B", 50], // wire-service-y
      ["C", 50], // wire-service-y
    ]);
    const top = pickTopSourcesByExtremity({
      matrix,
      sources: ["A", "B", "C"],
      articleCounts: counts,
      n: 3,
    });
    expect(top.map((p) => p.sourceName)).toEqual(["A", "B", "C"]);
    expect(top[0]!.meanDistance).toBeCloseTo(0.55);
  });

  it("breaks meanDistance ties by article count (descending)", () => {
    const matrix = {
      A: { B: 0.5, C: 0.5 },
      B: { A: 0.5, C: 0.5 },
      C: { A: 0.5, B: 0.5 },
    };
    const counts = new Map([
      ["A", 5],
      ["B", 20],
      ["C", 10],
    ]);
    const top = pickTopSourcesByExtremity({
      matrix,
      sources: ["A", "B", "C"],
      articleCounts: counts,
      n: 3,
    });
    expect(top.map((p) => p.sourceName)).toEqual(["B", "C", "A"]);
  });

  it("breaks remaining ties by source name (stable across renders)", () => {
    const matrix = {
      Zed: { Alpha: 0.5 },
      Alpha: { Zed: 0.5 },
    };
    const counts = new Map<string, number>();
    const top = pickTopSourcesByExtremity({
      matrix,
      sources: ["Zed", "Alpha"],
      articleCounts: counts,
      n: 2,
    });
    expect(top.map((p) => p.sourceName)).toEqual(["Alpha", "Zed"]);
  });

  it("respects n", () => {
    const matrix = {
      A: { B: 0.9, C: 0.8, D: 0.7 },
      B: { A: 0.9, C: 0.1, D: 0.1 },
      C: { A: 0.8, B: 0.1, D: 0.1 },
      D: { A: 0.7, B: 0.1, C: 0.1 },
    };
    const counts = new Map<string, number>();
    const top = pickTopSourcesByExtremity({
      matrix,
      sources: ["A", "B", "C", "D"],
      articleCounts: counts,
      n: 2,
    });
    expect(top.map((p) => p.sourceName)).toEqual(["A", "B"]);
  });

  it("treats missing matrix entries as 0 (neutral) rather than crashing", () => {
    // C has no matrix entries at all — should still appear in output with
    // meanDistance=0, ranked last on extremity but not silently dropped.
    const matrix = {
      A: { B: 0.5 },
      B: { A: 0.5 },
    };
    const counts = new Map([["A", 5], ["B", 5], ["C", 5]]);
    const top = pickTopSourcesByExtremity({
      matrix,
      sources: ["A", "B", "C"],
      articleCounts: counts,
      n: 3,
    });
    expect(top.map((p) => p.sourceName)).toEqual(["A", "B", "C"]);
    expect(top[2]!.meanDistance).toBe(0);
  });
});
