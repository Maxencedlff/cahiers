import { describe, expect, it } from "vitest";
import { appAltKey } from "../core/templates";

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
