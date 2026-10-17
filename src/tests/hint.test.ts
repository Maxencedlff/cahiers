import { describe, expect, it } from "vitest";
import { emptyMatrix, matrixShortcut, shortcutHint } from "../core/text/hint";
import { greekWordAtEnd, mathWordsAtEnd } from "../core/text/automath";

const h = (before: string, after = "") => shortcutHint(before, after);

describe("bulle d'aide aux raccourcis : declenchement", () => {
  it("lettres grecques des 3 lettres, tout de suite", () => {
    expect(h("on note ome")).toMatchObject({ typed: "ome", insert: "ω", delay: false });
    expect(h("omeg")?.insert).toBe("ω");
    expect(h("omega")?.insert).toBe("ω");
    expect(h("la pulsation Ome")?.insert).toBe("Ω");
    expect(h("Delt")?.insert).toBe("Δ");
    expect(h("delt")?.insert).toBe("δ");
    expect(h("alph")?.insert).toBe("α");
    expect(h("sigm")?.insert).toBe("σ");
    expect(h("lamb")?.insert).toBe("λ");
    expect(h("eps")?.insert).toBe("ε");
    expect(h("epsil")?.insert).toBe("ε");
    expect(h("thet")?.insert).toBe("θ");
    expect(h("(ome")?.insert).toBe("ω");
  });

  it("les raccourcis proposes sont ceux que la frappe convertit deja", () => {
    for (const w of ["omega", "tau", "alpha", "Delta", "sigma", "lambda", "theta", "epsilon", "phi"]) {
      expect(greekWordAtEnd(w)).toBe(h(w)!.insert);
    }
    expect(mathWordsAtEnd("forall")).toBe(h("fora")!.insert);
    expect(mathWordsAtEnd("infty")).toBe(h("inft")!.insert);
  });

  it("grands operateurs : debut tape comme en LaTeX sans barre", () => {
    expect(h("lim")).toMatchObject({ insert: "lim_(", delay: true });
    expect(h("sum")).toMatchObject({ insert: "sum_(", delay: true });
    expect(h("int")).toMatchObject({ insert: "int_", delay: true });
    expect(h("sqr")).toMatchObject({ insert: "sqrt(", delay: false });
  });

  it("derriere un operateur : tout de suite, meme sur un debut de mot courant", () => {
    expect(h("F = int")).toMatchObject({ insert: "int_", delay: false });
    expect(h("s(inf) = lim")).toMatchObject({ insert: "lim_(", delay: false });
    expect(h("y = tau")?.delay).toBe(false);
    expect(h("S = sum")?.delay).toBe(false);
  });

  it("debut d'un mot francais courant : seulement apres une pause", () => {
    for (const w of ["tau", "sig", "lim", "int", "inf", "for", "the", "eta", "gam", "del", "lam", "chi", "phi", "alp", "bet", "exi", "pro"]) {
      expect(h(`le ${w}`)?.delay, w).toBe(true);
    }
  });

  it("mots francais finis ou plus longs : jamais", () => {
    for (const w of [
      "sumo", "limite", "limiter", "integrer", "integrale", "intérieur", "interieur", "intensité", "taux",
      "signal", "signe", "theorie", "thermique", "forme", "force", "infini", "information", "etat", "etape",
      "gamme", "delai", "lampe", "chiffre", "philosophie", "alphabet", "beton", "produit", "programme",
      "omettre", "omelette", "existe", "tautologie", "sigmoide", "alphanumerique",
    ]) {
      expect(h(w), w).toBeNull();
      expect(h(`on a ${w}`), w).toBeNull();
    }
  });

  it("jamais colle a une lettre, un chiffre, un _ ou un \\", () => {
    expect(h("Vome")).toBeNull();
    expect(h("2tau")).toBeNull();
    expect(h("x_tau")).toBeNull();
    expect(h("\\ome")).toBeNull();
    expect(h("l'int")).toBeNull();
    expect(h("éome")).toBeNull();
  });

  it("trop court, sigle ou mot coupe au milieu : rien", () => {
    expect(h("om")).toBeNull();
    expect(h("pi")).toBeNull();
    expect(h("mu")).toBeNull();
    expect(h("ta")).toBeNull();
    expect(h("THE")).toBeNull();
    expect(h("INT")).toBeNull();
    expect(h("ome", "ga")).toBeNull();
    expect(h("ome", " suite")).not.toBeNull();
    expect(h("ome", ")")).not.toBeNull();
    expect(h("")).toBeNull();
    expect(h("on a ")).toBeNull();
    expect(h("bonjour")).toBeNull();
    expect(h("tableau")).toBeNull();
  });
});

describe("matrice vide", () => {
  it("mat2x2, mat3x3, mat2x3", () => {
    expect(matrixShortcut("mat2x2")).toEqual({ rows: 2, cols: 2, complete: true });
    expect(matrixShortcut("mat3x3")).toEqual({ rows: 3, cols: 3, complete: true });
    expect(matrixShortcut("mat2x3")).toEqual({ rows: 2, cols: 3, complete: true });
    expect(matrixShortcut("mat3")).toEqual({ rows: 3, cols: 3, complete: false });
    expect(matrixShortcut("mat3x")).toEqual({ rows: 3, cols: 3, complete: false });
    expect(matrixShortcut("mat")).toBeNull();
    expect(matrixShortcut("mat1")).toBeNull();
    expect(matrixShortcut("mat9x9")).toBeNull();
    expect(matrixShortcut("matiere")).toBeNull();
    expect(matrixShortcut("mat2x2x")).toBeNull();
  });

  it("bulle et formule a cases", () => {
    expect(emptyMatrix(2, 2)).toBe("\\begin{pmatrix}#?&#?\\\\#?&#?\\end{pmatrix}");
    expect(emptyMatrix(2, 3)).toBe("\\begin{pmatrix}#?&#?&#?\\\\#?&#?&#?\\end{pmatrix}");
    const b = h("soit A = mat2x2");
    expect(b).toMatchObject({ typed: "mat2x2", insert: "", math: emptyMatrix(2, 2), delay: false });
    expect(h("mat3")?.math).toBe(emptyMatrix(3, 3));
    expect(h("les maths")).toBeNull();
    expect(h("mat")).toBeNull();
    expect(h("format2x2")).toBeNull();
  });
});
