import { describe, it, expect } from "vitest";
import {
  isNewer, shortVersion, offerText, progressText, progressStep, quietEnough, sizeText, TYPING_QUIET_MS,
} from "../core/update";

describe("versions", () => {
  it("compare nombre par nombre, pas en texte", () => {
    expect(isNewer("0.2.1", "0.2.0")).toBe(true);
    expect(isNewer("0.10.0", "0.9.3")).toBe(true);
    expect(isNewer("1.0.0", "0.99.99")).toBe(true);
    expect(isNewer("0.2.0", "0.2.0")).toBe(false);
    expect(isNewer("0.1.9", "0.2.0")).toBe(false);
    expect(isNewer("v0.3.0", "0.2.5")).toBe(true);
  });
  it("version lisible : zero final retire", () => {
    expect(shortVersion("0.3.0")).toBe("0.3");
    expect(shortVersion("0.2.1")).toBe("0.2.1");
    expect(shortVersion("1.0.0")).toBe("1.0");
    expect(shortVersion("v2.10.0")).toBe("2.10");
    expect(offerText("0.3.0")).toBe("Cahiers 0.3 disponible");
  });
});

describe("progression", () => {
  it("pourcentage quand la taille est connue", () => {
    expect(progressText("0.3.0", 0, 1000)).toBe("Téléchargement de Cahiers 0.3… 0 %");
    expect(progressText("0.3.0", 425, 1000)).toBe("Téléchargement de Cahiers 0.3… 42 %");
    expect(progressText("0.3.0", 2000, 1000)).toBe("Téléchargement de Cahiers 0.3… 100 %");
  });
  it("sinon ce qui est arrive", () => {
    expect(progressText("0.2.1", 0)).toBe("Téléchargement de Cahiers 0.2.1…");
    expect(progressText("0.2.1", 5 * 1024 * 1024)).toBe("Téléchargement de Cahiers 0.2.1… 5,0 Mo");
    expect(sizeText(300)).toBe("1 Ko");
    expect(sizeText(13_000_000)).toBe("12,4 Mo");
  });
  it("redessin par paliers de 5 %", () => {
    expect(progressStep(0, 100)).toBe(0);
    expect(progressStep(4, 100)).toBe(0);
    expect(progressStep(5, 100)).toBe(1);
    expect(progressStep(100, 100)).toBe(20);
    expect(progressStep(150, 100)).toBe(20);
  });
});

describe("jamais au milieu d'une frappe", () => {
  it("le bandeau attend le silence du clavier", () => {
    const now = 1_000_000;
    expect(quietEnough(now - 500, now)).toBe(false);
    expect(quietEnough(now - TYPING_QUIET_MS, now)).toBe(true);
    expect(quietEnough(0, now)).toBe(true);
  });
});
