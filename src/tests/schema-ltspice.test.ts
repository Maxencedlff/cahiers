import { describe, it, expect } from "vitest";
import { importAsc } from "../core/schema/ltspice";
import { freePorts, partPorts, wirePts } from "../core/schema/model";

// Pont diviseur : source V1 a gauche, R1 horizontale (R90), R2 verticale, masse.
const DIVIDER = `Version 4
SHEET 1 880 680
WIRE 96 96 32 96
WIRE 32 96 32 128
WIRE 224 96 176 96
WIRE 224 128 224 96
WIRE 32 224 32 208
WIRE 224 224 224 208
FLAG 32 224 0
FLAG 224 224 0
FLAG 224 96 Vs
SYMBOL voltage 32 112 R0
SYMATTR InstName V1
SYMATTR Value 12
SYMBOL res 192 80 R90
WINDOW 0 0 56 VBottom 2
SYMATTR InstName R1
SYMATTR Value 1k
SYMBOL res 208 112 R0
SYMATTR InstName R2
SYMATTR Value 2k
TEXT 40 280 Left 2 !.op
`;

describe("import LTspice (.asc)", () => {
  it("pont diviseur : pieces, noms, valeurs, masses, aucune borne en l'air", () => {
    const { block, skipped } = importAsc(DIVIDER, "s");
    expect(skipped).toEqual([]);
    const byName = Object.fromEntries(block.parts.filter((p) => p.name).map((p) => [p.name, p]));
    expect(byName.V1.sym).toBe("V");
    expect(byName.V1.value).toBe("12");
    expect(byName.R1.sym).toBe("R");
    expect(byName.R1.value).toBe("1k");
    expect(byName.R2.sym).toBe("R");
    expect(block.parts.filter((p) => p.sym === "G")).toHaveLength(2);
    expect(block.notes?.map((n) => n.label)).toEqual(["Vs"]);
    // R1 horizontale, R2 verticale.
    const [a1, b1] = partPorts(byName.R1);
    expect(a1.y).toBe(b1.y);
    const [a2, b2] = partPorts(byName.R2);
    expect(a2.x).toBe(b2.x);
    expect(freePorts(block)).toEqual([]);
    for (const w of block.wires) {
      const p = wirePts(w);
      for (let i = 0; i + 1 < p.length; i++) expect(p[i].x === p[i + 1].x || p[i].y === p[i + 1].y).toBe(true);
    }
  });

  it("symbole inconnu : signale, pas pose ; les fils restent", () => {
    const { block, skipped } = importAsc("Version 4\nWIRE 0 0 64 0\nSYMBOL MyWeirdThing 0 0 R0\nSYMATTR InstName X1\n", "s");
    expect(skipped).toEqual(["MyWeirdThing"]);
    expect(block.parts).toHaveLength(0);
    expect(block.wires).toHaveLength(1);
  });
});
