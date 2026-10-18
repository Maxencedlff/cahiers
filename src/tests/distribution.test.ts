import { describe, it, expect } from "vitest";
import { parseDistribution, selfUpdates } from "../core/distribution";

describe("canal de distribution", () => {
  it("lit la reponse de la commande Rust", () => {
    expect(parseDistribution("app-store")).toBe("app-store");
    expect(parseDistribution("direct")).toBe("direct");
  });
  it("reponse inconnue ou absente : installateur direct", () => {
    expect(parseDistribution(undefined)).toBe("direct");
    expect(parseDistribution(null)).toBe("direct");
    expect(parseDistribution("App-Store")).toBe("direct");
    expect(parseDistribution(42)).toBe("direct");
  });
  it("mises a jour par l'appli seulement hors App Store et hors navigateur", () => {
    expect(selfUpdates("direct")).toBe(true);
    expect(selfUpdates("app-store")).toBe(false);
    expect(selfUpdates("browser")).toBe(false);
  });
});
