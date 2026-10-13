import { describe, it, expect } from "vitest";
import {
  effectiveTheme, effectiveSheet, nextThemePref, inkDisplayColor, contrastRatio, isThemePref, isSheetTone, isSheetPref,
} from "../core/theme";
import {
  mathPanelMode, toastsToDrop, toastPlacement, MAX_TOASTS, TOAST_ZONE,
  sidebarMode, calcPlacement, paletteCompact, SIDEBAR_DOCK_MIN, PHONE_MAX, CALC_PANEL_W,
} from "../core/chrome";
import { statusSummary, type StatusInput } from "../core/status";
import { colorOf, PALETTE, NOTEBOOK_COLORS, NOTEBOOK_COLOR_NAMES, isSemanticColor } from "../core/palette";
import { DARK_SHEET_INKS } from "../core/theme";

// style.css lu par Node (comme textlayout.test.ts) : la feuille sombre y
// reprend les memes encres que le canvas.
const nodeFs = "node:fs";
const { readFileSync } = (await import(/* @vite-ignore */ nodeFs)) as { readFileSync(p: URL, enc: string): string };
const css = readFileSync(new URL("../style.css", import.meta.url), "utf8");

describe("theme effectif", () => {
  it("Systeme suit Windows, Clair et Sombre l'imposent", () => {
    expect(effectiveTheme("system", true)).toBe("dark");
    expect(effectiveTheme("system", false)).toBe("light");
    expect(effectiveTheme("light", true)).toBe("light");
    expect(effectiveTheme("dark", false)).toBe("dark");
  });

  it("le raccourci fait le tour des trois choix", () => {
    expect(nextThemePref("light")).toBe("dark");
    expect(nextThemePref("dark")).toBe("system");
    expect(nextThemePref("system")).toBe("light");
  });

  it("valeurs lues du stockage local verifiees", () => {
    expect(isThemePref("dark")).toBe(true);
    expect(isThemePref("noir")).toBe(false);
    expect(isSheetTone("sepia")).toBe(true);
    expect(isSheetTone(undefined)).toBe(false);
    expect(isSheetPref("auto")).toBe(true);
    expect(isSheetTone("auto")).toBe(false);
  });

  it("feuille Auto : sombre en theme sombre, claire sinon ; un choix explicite l'emporte", () => {
    expect(effectiveSheet("auto", "dark")).toBe("dark");
    expect(effectiveSheet("auto", "light")).toBe("light");
    expect(effectiveSheet("sepia", "dark")).toBe("sepia");
    expect(effectiveSheet("light", "dark")).toBe("light");
  });
});

describe("encre a l'affichage", () => {
  it("feuille claire ou sepia : la couleur stockee, telle quelle", () => {
    for (const tone of ["light", "sepia"] as const) {
      expect(inkDisplayColor("normal", "pen", tone)).toBe(colorOf("normal"));
      expect(inkDisplayColor("theoreme", "highlighter", tone)).toBe(colorOf("theoreme", "highlighter"));
    }
  });

  it("feuille sombre : le noir devient clair, lisible (AA) sur le fond", () => {
    const sheet = "#1f2126";
    const normal = inkDisplayColor("normal", "pen", "dark");
    expect(normal).not.toBe(colorOf("normal"));
    expect(contrastRatio(normal, sheet)).toBeGreaterThanOrEqual(4.5);
    // Les couleurs semantiques restent distinctes et lisibles.
    const inks = PALETTE.map((p) => inkDisplayColor(p.key, "pen", "dark"));
    expect(new Set(inks).size).toBe(PALETTE.length);
    for (const c of inks) expect(contrastRatio(c, sheet)).toBeGreaterThanOrEqual(4.5);
  });

  it("contraste WCAG : noir sur blanc = 21, meme couleur = 1", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrastRatio("#2563eb", "#2563eb")).toBeCloseTo(1, 5);
  });
});

describe("volet des formules (Σ)", () => {
  it("ferme par defaut, popover sous Σ une fois ouvert ; epingle, il reste", () => {
    expect(mathPanelMode({ open: false, pinned: false })).toBe("closed");
    expect(mathPanelMode({ open: true, pinned: false })).toBe("popover");
    expect(mathPanelMode({ open: false, pinned: true })).toBe("popover");
  });
});

describe("disposition : barre laterale, calculatrice, palette", () => {
  it("barre laterale a cote de la page sur grand ecran, en surimpression sur tablette, en pile au telephone", () => {
    expect(sidebarMode(1920)).toBe("docked");
    expect(sidebarMode(1366)).toBe("docked");
    expect(sidebarMode(SIDEBAR_DOCK_MIN)).toBe("docked");
    expect(sidebarMode(1024)).toBe("docked");
    expect(sidebarMode(768)).toBe("overlay");
    expect(sidebarMode(PHONE_MAX - 1)).toBe("stack");
    expect(sidebarMode(390)).toBe("stack");
  });

  it("calculatrice : panneau qui pousse la page, flottante si detachee ou si la page n'a plus sa largeur", () => {
    expect(calcPlacement({ width: 1366, stage: 1118, detached: false })).toBe("panel");
    expect(calcPlacement({ width: 1366, stage: 1118, detached: true })).toBe("float");
    expect(calcPlacement({ width: 768, stage: 768, detached: false })).toBe("float");
    expect(calcPlacement({ width: 390, stage: 390, detached: false })).toBe("sheet");
    expect(CALC_PANEL_W).toBe(360);
  });

  it("palette : les six pastilles se replient en un bouton quand la zone est etroite", () => {
    expect(paletteCompact(1118)).toBe(false);
    expect(paletteCompact(390)).toBe(true);
  });

  it("couleurs de matiere : huit teintes nommees, jamais une couleur semantique", () => {
    expect(NOTEBOOK_COLORS.length).toBe(8);
    expect(new Set(NOTEBOOK_COLORS).size).toBe(8);
    for (const c of NOTEBOOK_COLORS) {
      expect(isSemanticColor(c)).toBe(false);
      expect(NOTEBOOK_COLOR_NAMES[c]).toBeTruthy();
      // Assez soutenues pour une pastille sur fond clair ou sombre.
      expect(contrastRatio(c, "#ffffff")).toBeGreaterThanOrEqual(3);
    }
    expect(isSemanticColor("#2563eb")).toBe(true);
  });
});

describe("messages ephemeres", () => {
  it("trois au plus : le plus ancien part", () => {
    expect(toastsToDrop([{ action: false }, { action: false }])).toEqual([]);
    expect(toastsToDrop([{ action: false }, { action: false }, { action: false }])).toEqual([0]);
    expect(MAX_TOASTS).toBe(3);
  });

  it("un message a bouton (Annuler) est garde avant les autres", () => {
    expect(toastsToDrop([{ action: true }, { action: false }, { action: false }])).toEqual([1]);
    expect(toastsToDrop([{ action: true }, { action: true }, { action: true }])).toEqual([0]);
    expect(toastsToDrop([{ action: true }, { action: false }, { action: false }, { action: false }], 3)).toEqual([1, 2]);
  });

  it("en haut a droite sous la barre, hors de la feuille", () => {
    const p = toastPlacement({ width: 1366, height: 768, top: 49, bottom: 0, avoid: [] });
    expect(p).toEqual({ corner: "top-right", offset: 61, right: 12 });
  });

  it("calculatrice detachee en haut a droite : en bas a droite", () => {
    const calc = { x: 1366 - 444, y: 110, w: 428, h: 400 };
    const p = toastPlacement({ width: 1366, height: 768, top: 49, bottom: 0, avoid: [calc] });
    expect(p.corner).toBe("bottom-right");
  });

  it("les deux coins pris : a gauche de l'obstacle du haut", () => {
    const calc = { x: 1366 - 444, y: 60, w: 428, h: 700 };
    const p = toastPlacement({ width: 1366, height: 768, top: 49, bottom: 0, avoid: [calc] });
    expect(p.corner).toBe("top-right");
    expect(p.right).toBe(1366 - calc.x + 12);
    expect(1366 - p.right - TOAST_ZONE.w).toBeGreaterThan(0);
  });
});

describe("indicateur d'etat", () => {
  const base: StatusInput = {
    online: true, backendReady: true, pending: 0, keysBlocked: false, lastError: null,
    saving: false, saveError: null, readOnly: false, usage: 0, quota: 2000, penSeen: true, touchWrites: false,
  };

  it("tout va bien : rien a l'ecran (niveau ok, aucun texte)", () => {
    const s = statusSummary(base);
    expect(s.level).toBe("ok");
    expect(s.short).toBe("");
    expect(s.lines.map((l) => l.label)).toContain("Enregistrement");
  });

  it("enregistrement en cours : pas un probleme", () => {
    expect(statusSummary({ ...base, saving: true, pending: 3 }).level).toBe("ok");
  });

  it("reconnaissance non configuree : orange, un mot", () => {
    const s = statusSummary({ ...base, backendReady: false });
    expect(s.level).toBe("warn");
    expect(s.short).toBe("Reconnaissance non configurée");
  });

  it("ecriture refusee : rouge, passe devant le reste", () => {
    const s = statusSummary({ ...base, online: false, saveError: "disque plein" });
    expect(s.level).toBe("err");
    expect(s.short).toBe("Non enregistré (+1)");
    expect(s.lines[0].text).toContain("disque plein");
  });

  it("hors ligne, lecture seule, quota : orange avec un texte court", () => {
    expect(statusSummary({ ...base, online: false }).short).toBe("Hors ligne");
    expect(statusSummary({ ...base, readOnly: true }).level).toBe("warn");
    const q = statusSummary({ ...base, usage: 1700 });
    expect(q.level).toBe("warn");
    expect(q.short).toBe("Quota bientôt atteint");
  });

  it("cles refusees : rouge", () => {
    const s = statusSummary({ ...base, keysBlocked: true, lastError: "Clés MyScript refusées" });
    expect(s.level).toBe("err");
    expect(s.short).toBe("Clés refusées");
  });
});

describe("feuille sombre dans style.css", () => {
  it("les --ink-* du texte tape valent celles du canvas", () => {
    const block = css.slice(css.indexOf('.app[data-sheet="dark"] {'));
    for (const [key, v] of Object.entries(DARK_SHEET_INKS)) {
      expect(block).toMatch(new RegExp(`--ink-${key}:\\s*${v.ink}`, "i"));
    }
    expect(block).toMatch(/--page-bg:\s*#1f2126/);
  });

  it("textes du chrome lisibles (AA) dans les deux themes", () => {
    const pairs: [string, string][] = [
      ["#16181d", "#ffffff"], ["#5d6470", "#ffffff"], ["#5d6470", "#f6f7f9"], ["#1a46b8", "#e8efff"],
      ["#8a4b00", "#fff6e6"], ["#a51b1b", "#fdf0f0"], ["#7a4700", "#fff4e0"], ["#ffffff", "#2563eb"],
      ["#e7e9ee", "#202227"], ["#a1a8b4", "#202227"], ["#a1a8b4", "#282a30"], ["#b9cfff", "#1e2c49"],
      // Barre laterale et fond de l'appli (texte attenue), calculatrice.
      ["#5d6470", "#ececef"], ["#5d6470", "#f5f5f7"], ["#a1a8b4", "#1b1c20"], ["#a1a8b4", "#121316"],
      ["#16181d", "#f3f4f7"], ["#5d6470", "#f3f4f7"], ["#16181d", "#e6e8ec"], ["#e7e9ee", "#33363d"],
      ["#f6c77d", "#30250f"], ["#ffa3a3", "#3a1b1d"], ["#ffd27a", "#3a2c0c"], ["#0b1220", "#5b93ff"],
      ["#e4e6eb", "#1f2126"],
    ];
    for (const [fg, bg] of pairs) {
      expect(css.toLowerCase()).toContain(fg);
      expect(contrastRatio(fg, bg), `${fg} sur ${bg}`).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe("icone Pas compris", () => {
  it("l'ambre de l'icone se voit sur la barre (3:1, composant d'interface)", () => {
    expect(css.toLowerCase()).toContain("#b26a00");
    expect(contrastRatio("#b26a00", "#f5f5f7")).toBeGreaterThanOrEqual(3);
    expect(contrastRatio("#f0b429", "#121316")).toBeGreaterThanOrEqual(3);
  });
});
