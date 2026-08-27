import { create, all } from "mathjs";
import { humanError } from "./engine";

const math = create(all, { number: "number" });

/** Matrices (section 7) : determinant, inverse, transposee, rang. */

export interface MatrixOutcome {
  ok: boolean;
  message?: string;
  /** Resultat scalaire (determinant, rang) ou matriciel. */
  scalar?: number;
  matrix?: number[][];
  latex?: string;
}

export type MatrixOp = "det" | "inv" | "transpose" | "rank" | "trace" | "identity";

export function applyMatrixOp(m: number[][], op: MatrixOp): MatrixOutcome {
  try {
    const M = math.matrix(m);
    switch (op) {
      case "det": {
        const d = Number(math.det(M));
        return { ok: true, scalar: round(d), latex: String(round(d)) };
      }
      case "inv": {
        const inv = (math.inv(M) as unknown as { toArray(): number[][] }).toArray();
        const clean = inv.map((r) => r.map(round));
        return { ok: true, matrix: clean, latex: toLatex(clean) };
      }
      case "transpose": {
        const t = math.transpose(M).toArray() as number[][];
        return { ok: true, matrix: t, latex: toLatex(t) };
      }
      case "rank": {
        const r = rank(m);
        return { ok: true, scalar: r, latex: String(r) };
      }
      case "trace": {
        const t = Number(math.trace(M));
        return { ok: true, scalar: round(t), latex: String(round(t)) };
      }
      case "identity": {
        const id = (math.identity(m.length) as unknown as { toArray(): number[][] }).toArray();
        return { ok: true, matrix: id, latex: toLatex(id) };
      }
    }
  } catch (e) {
    return { ok: false, message: humanError(e) };
  }
}

export function multiply(a: number[][], b: number[][]): MatrixOutcome {
  try {
    const p = math.multiply(math.matrix(a), math.matrix(b)).toArray() as number[][];
    const clean = p.map((r) => r.map(round));
    return { ok: true, matrix: clean, latex: toLatex(clean) };
  } catch (e) {
    return { ok: false, message: humanError(e) };
  }
}

export function addMatrices(a: number[][], b: number[][], sign: 1 | -1 = 1): MatrixOutcome {
  try {
    const B = sign === 1 ? math.matrix(b) : math.multiply(math.matrix(b), -1);
    const r = math.add(math.matrix(a), B as any).toArray() as number[][];
    const clean = r.map((row) => row.map(round));
    return { ok: true, matrix: clean, latex: toLatex(clean) };
  } catch (e) {
    return { ok: false, message: humanError(e) };
  }
}

/**
 * Rang par elimination de Gauss avec pivot partiel.
 * mathjs ne l'expose pas directement, c'est 20 lignes.
 */
export function rank(input: number[][]): number {
  const m = input.map((r) => [...r]);
  const rows = m.length;
  const cols = rows ? m[0].length : 0;
  let r = 0;
  for (let c = 0; c < cols && r < rows; c++) {
    let pivot = r;
    for (let i = r + 1; i < rows; i++) {
      if (Math.abs(m[i][c]) > Math.abs(m[pivot][c])) pivot = i;
    }
    if (Math.abs(m[pivot][c]) < 1e-10) continue;
    [m[r], m[pivot]] = [m[pivot], m[r]];
    for (let i = r + 1; i < rows; i++) {
      const factor = m[i][c] / m[r][c];
      for (let j = c; j < cols; j++) m[i][j] -= factor * m[r][j];
    }
    r++;
  }
  return r;
}

export function toLatex(m: number[][]): string {
  const body = m.map((row) => row.map((v) => String(round(v))).join(" & ")).join(" \\\\ ");
  return `\\begin{pmatrix} ${body} \\end{pmatrix}`;
}

/** Lecture d'une matrice saisie en texte : lignes separees par des retours. */
export function parseMatrix(text: string): number[][] | null {
  const rows = text
    .trim()
    .split(/[\n;]+/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (rows.length === 0) return null;
  const out: number[][] = [];
  for (const row of rows) {
    const cells = row.split(/[\s,]+/).filter(Boolean).map(Number);
    if (cells.some((c) => !Number.isFinite(c))) return null;
    out.push(cells);
  }
  const width = out[0].length;
  if (out.some((r) => r.length !== width)) return null;
  return out;
}

function round(v: number): number {
  const r = Math.round(v);
  if (Math.abs(v - r) < 1e-10) return r;
  return Math.round(v * 1e10) / 1e10;
}
