import { create, all } from "mathjs";
import { humanError, normalizeInput } from "./engine";

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

export interface ParsedMatrix { ok: boolean; matrix?: number[][]; message?: string }

/**
 * Lecture d'une matrice saisie en texte.
 * - une ligne par retour a la ligne ou par « ; » ;
 * - cellules separees par des espaces ou des tabulations ;
 * - virgule decimale francaise : « 0,5 » est UNE cellule, 0.5 ;
 * - chaque cellule est evaluee : 1/2, pi, sqrt(2), -3e-2 ;
 * - la syntaxe mathjs [1, 2; 3, 4] reste acceptee (virgule = separateur).
 */
export function readMatrix(text: string): ParsedMatrix {
  const src = text.trim();
  if (!src) return { ok: false, message: "Matrice vide" };
  if (src.startsWith("[")) {
    try {
      const v = math.evaluate(normalizeInput(src)) as any;
      const arr = v?.toArray ? v.toArray() : v;
      const rows = Array.isArray(arr) && !Array.isArray(arr[0]) ? [arr] : arr;
      if (!Array.isArray(rows) || rows.some((r: unknown) => !Array.isArray(r))) {
        return { ok: false, message: "Matrice illisible" };
      }
      return checkShape(rows.map((r: unknown[]) => r.map(Number)));
    } catch (e) {
      return { ok: false, message: humanError(e) };
    }
  }
  const lines = src.split(/[\n;]+/).map((l) => l.trim()).filter(Boolean);
  const out: number[][] = [];
  for (let i = 0; i < lines.length; i++) {
    const row: number[] = [];
    // « 1, 2, 3 » : une virgule suivie d'une espace separe deux cellules.
    for (const raw of lines[i].replace(/,(?=\s)/g, " ").split(/\s+/).filter(Boolean)) {
      const cell = raw.replace(/,$/, "").replace(/(\d),(\d)/g, "$1.$2");
      let value: number;
      try {
        value = Number(math.evaluate(normalizeInput(cell)));
      } catch {
        return { ok: false, message: `Ligne ${i + 1} : cellule « ${raw} » illisible` };
      }
      if (!Number.isFinite(value)) {
        return { ok: false, message: `Ligne ${i + 1} : cellule « ${raw} » n'est pas un nombre réel` };
      }
      row.push(value);
    }
    out.push(row);
  }
  return checkShape(out);
}

function checkShape(m: number[][]): ParsedMatrix {
  if (m.length === 0 || m[0].length === 0) return { ok: false, message: "Matrice vide" };
  if (m.some((r) => r.some((c) => !Number.isFinite(c)))) {
    return { ok: false, message: "Les cellules doivent être des nombres réels" };
  }
  const width = m[0].length;
  const bad = m.findIndex((r) => r.length !== width);
  if (bad >= 0) {
    return { ok: false, message: `Ligne ${bad + 1} : ${m[bad].length} cellule(s) au lieu de ${width}` };
  }
  return { ok: true, matrix: m };
}

/** Lecture simple : la matrice, ou null si elle est illisible. */
export function parseMatrix(text: string): number[][] | null {
  const r = readMatrix(text);
  return r.ok ? r.matrix! : null;
}

function round(v: number): number {
  const r = Math.round(v);
  if (Math.abs(v - r) < 1e-10) return r;
  return Math.round(v * 1e10) / 1e10;
}
