import { describe, expect, it } from "vitest";
import { getDefaultOpenRouterModels, orderOpenRouterModels, resolveOpenRouterModels } from "../src/services/openrouter-models.js";

describe("resolveOpenRouterModels", () => {
  it("falls back to the built-in free-model list", () => {
    expect(resolveOpenRouterModels(undefined)).toEqual(getDefaultOpenRouterModels());
  });
});

describe("orderOpenRouterModels", () => {
  it("applies an explicit offset without dropping any models", () => {
    const models = ["a", "b", "c", "d"];

    expect(orderOpenRouterModels(models, "", { offset: 1 })).toEqual(["b", "c", "d", "a"]);
  });

  it("changes ordering between retry rounds", () => {
    const models = ["a", "b", "c", "d"];

    expect(orderOpenRouterModels(models, "story", { round: 0 })).not.toEqual(
      orderOpenRouterModels(models, "story", { round: 1 }),
    );
  });
});
