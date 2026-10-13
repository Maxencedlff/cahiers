import { describe, expect, it } from "vitest";
import { appAltKey, MATH_TEMPLATES } from "../core/templates";

describe("Alt de l'appli contre MathLive", () => {
  it("les modeles Alt sont retires des raccourcis MathLive", () => {
    expect(appAltKey("alt+p")).toBe(true); // pi de MathLive
    expect(appAltKey("alt+v")).toBe(true); // racine de MathLive
    expect(appAltKey("alt+d")).toBe(true);
    expect(appAltKey("alt+[KeyP]")).toBe(true);
  });
  it("les autres raccourcis MathLive restent", () => {
    expect(appAltKey("alt+o")).toBe(false);
    expect(appAltKey("alt+[ArrowLeft]")).toBe(false);
    expect(appAltKey("alt+shift+v")).toBe(false);
  });
});

describe("raccourcis Alt des modeles", () => {
  it("cinq lettres seulement (avec Alt+=), meme place en AZERTY et QWERTY", () => {
    const keys = MATH_TEMPLATES.filter((t) => t.key).map((t) => t.key).sort();
    expect(keys).toEqual(["b", "f", "i", "p", "r"]);
    // Ces touches ne bougent pas entre AZERTY et QWERTY : lues sur e.code.
    for (const k of keys) expect("azqwm").not.toContain(k!);
  });
});
