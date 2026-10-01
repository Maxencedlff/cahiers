import { describe, it, expect, afterEach } from "vitest";
import {
  SHORTCUTS, GROUPS, ctrlCommand, isReloadKey, keysOf, titleOf, pageLabel, parsePageInput, type KeyLike,
} from "../core/shortcuts";
import { MATH_TEMPLATES } from "../core/templates";
import { SYMBOLS, symbolName } from "../core/symbols";
import { loadSettings } from "../core/settings";

/** Evenement clavier minimal : « Ctrl+Maj+N » -> {key: "N", ctrlKey, shiftKey}. */
function press(key: string, mods: Partial<KeyLike> = {}): KeyLike {
  return { key, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, ...mods };
}
const ctrl = (key: string, shift = false) => press(shift && key.length === 1 ? key.toUpperCase() : key,
  { ctrlKey: true, shiftKey: shift });

describe("table des raccourcis", () => {
  it("aucune combinaison en double", () => {
    const keys = SHORTCUTS.map((s) => s.keys);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("chaque raccourci a un groupe connu et un libelle", () => {
    for (const s of SHORTCUTS) {
      expect(GROUPS).toContain(s.group);
      expect(s.label.length).toBeGreaterThan(2);
    }
  });

  it("les modeles Alt ne prennent pas une touche d'outil", () => {
    const tools = ["e", "h", "g", "z", "t"];
    for (const t of MATH_TEMPLATES) if (t.key) expect(tools).not.toContain(t.key);
  });

  it("chaque raccourci Ctrl de la table est reconnu tel qu'affiche", () => {
    for (const s of SHORTCUTS) {
      if (!s.ctrl) continue;
      expect(ctrlCommand(ctrl(s.ctrl.key, s.ctrl.shift))).toBe(s.ctrl.command);
    }
  });
});

describe("ctrlCommand", () => {
  it("Ctrl+F pose un repere, quel que soit le focus (D3)", () => {
    expect(ctrlCommand(ctrl("f"))).toBe("flag");
  });

  it("Maj change la commande : intercalaire, insertion, panneau droit", () => {
    expect(ctrlCommand(ctrl("PageDown"))).toBe("nextPage");
    expect(ctrlCommand(ctrl("PageDown", true))).toBe("nextDivider");
    expect(ctrlCommand(ctrl("PageUp", true))).toBe("prevDivider");
    expect(ctrlCommand(ctrl("n"))).toBe("newPage");
    expect(ctrlCommand(ctrl("n", true))).toBe("insertPage");
    // Ctrl+Maj+W fermait l'onglet entier : le test de Maj venait apres.
    expect(ctrlCommand(ctrl("w"))).toBe("closeTab");
    expect(ctrlCommand(ctrl("w", true))).toBe("closeSplit");
    expect(ctrlCommand(ctrl("Tab", true))).toBe("prevTab");
    expect(ctrlCommand(ctrl("p"))).toBe("exportPage");
    expect(ctrlCommand(ctrl("p", true))).toBe("exportAll");
  });

  it("AltGr (Ctrl+Alt) tape un caractere, jamais une commande", () => {
    // AltGr+8 en AZERTY donne « \ » : ne doit pas ouvrir le split.
    expect(ctrlCommand(press("\\", { ctrlKey: true, altKey: true, code: "Digit8" }))).toBeNull();
    expect(ctrlCommand(press("@", { ctrlKey: true, altKey: true, code: "Digit0" }))).toBeNull();
  });

  it("split au clavier AZERTY (touche « * » au meme emplacement que « \\ »)", () => {
    expect(ctrlCommand(press("*", { ctrlKey: true, code: "Backslash" }))).toBe("split");
    expect(ctrlCommand(press("\\", { ctrlKey: true, code: "Backslash" }))).toBe("split");
  });

  it("aide : F1, Ctrl+/ et Ctrl+Maj+: (AZERTY)", () => {
    expect(ctrlCommand(press("F1"))).toBe("help");
    expect(ctrlCommand(press("/", { ctrlKey: true }))).toBe("help");
    expect(ctrlCommand(press("/", { ctrlKey: true, shiftKey: true, code: "Period" }))).toBe("help");
  });

  it("lettres seules, Alt et raccourcis inconnus : rien", () => {
    expect(ctrlCommand(press("f"))).toBeNull();
    expect(ctrlCommand(press("f", { altKey: true }))).toBeNull();
    expect(ctrlCommand(ctrl("c"))).toBeNull();
    expect(ctrlCommand(ctrl("v"))).toBeNull();
    expect(ctrlCommand(press("F1", { ctrlKey: true }))).toBeNull();
  });
});

describe("infobulles et indicateur de page", () => {
  it("titleOf ajoute les touches de la table", () => {
    expect(keysOf("flag")).toBe("Ctrl+F");
    expect(titleOf("Pas compris", "flag")).toBe("Pas compris (Ctrl+F)");
    expect(titleOf("Intercalaire suivant", "nextDivider")).toBe("Intercalaire suivant (Ctrl+Maj+Pg↓)");
  });

  it("p. N / total", () => {
    expect(pageLabel(4, 12)).toBe("p. 4 / 12");
    expect(pageLabel(1, 0)).toBe("p. 1");
  });

  it("Ctrl+G : numero existant, sinon un message", () => {
    const nums = [1, 2, 3, 4];
    expect(parsePageInput("3", nums)).toEqual({ page: 3 });
    expect(parsePageInput(" p. 2 ", nums)).toEqual({ page: 2 });
    expect(parsePageInput("p4", nums)).toEqual({ page: 4 });
    expect(parsePageInput("9", nums)).toEqual({ error: "Pas de page 9 : cet intercalaire va de 1 à 4" });
    expect("error" in parsePageInput("abc", nums)).toBe(true);
    expect("error" in parsePageInput("", nums)).toBe(true);
  });
});

describe("ruban Maths", () => {
  it("chaque symbole a un nom lisible, pas du LaTeX", () => {
    for (const [, insert] of SYMBOLS) {
      const name = symbolName(insert);
      expect(name).not.toMatch(/\\/);
      expect(name.length).toBeGreaterThan(1);
    }
    expect(symbolName("\\alpha")).toBe("alpha");
    expect(symbolName("\\Rightarrow")).toBe("implique");
  });
});

describe("reglages de disposition", () => {
  const store = new Map<string, string>();
  const ls = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v); },
  };
  afterEach(() => { store.clear(); delete (globalThis as { localStorage?: unknown }).localStorage; });

  it("calculatrice fermee et ruban Maths deplie par defaut (D6)", () => {
    (globalThis as { localStorage?: unknown }).localStorage = ls;
    const s = loadSettings();
    expect(s.calcOpen).toBe(false);
    expect(s.mathOpen).toBe(true);
  });

  it("l'ancien defaut « calculatrice ouverte » est ferme une fois, puis respecte", () => {
    (globalThis as { localStorage?: unknown }).localStorage = ls;
    store.set("cahiers.settings.v1", JSON.stringify({ calcOpen: true }));
    const s = loadSettings();
    expect(s.calcOpen).toBe(false);
    expect(s.layout).toBe(2);
    // Rouverte ensuite par l'utilisateur (Ctrl+L) : le choix tient.
    store.set("cahiers.settings.v1", JSON.stringify({ ...s, calcOpen: true }));
    expect(loadSettings().calcOpen).toBe(true);
  });

  it("le repli du ruban Maths est retenu", () => {
    (globalThis as { localStorage?: unknown }).localStorage = ls;
    store.set("cahiers.settings.v1", JSON.stringify({ mathOpen: false, layout: 2 }));
    expect(loadSettings().mathOpen).toBe(false);
  });
});

describe("touches qui rechargeraient le WebView2", () => {
  it("F5, Ctrl+R et Ctrl+Maj+R sont reconnues", () => {
    expect(isReloadKey(press("F5"))).toBe(true);
    expect(isReloadKey(ctrl("r"))).toBe(true);
    expect(isReloadKey(ctrl("r", true))).toBe(true);
  });

  it("AltGr+R et la lettre seule tapent du texte", () => {
    expect(isReloadKey(press("r", { ctrlKey: true, altKey: true }))).toBe(false);
    expect(isReloadKey(press("r"))).toBe(false);
    expect(isReloadKey(press("R", { shiftKey: true }))).toBe(false);
  });

  it("Ctrl+Maj+R n'est pas une commande : seul le blocage la retient", () => {
    expect(ctrlCommand(ctrl("r", true))).toBeNull();
    expect(ctrlCommand(ctrl("r"))).toBe("convert");
  });
});
