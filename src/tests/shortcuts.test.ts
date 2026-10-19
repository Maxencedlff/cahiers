import { describe, it, expect, afterEach } from "vitest";
import {
  SHORTCUTS, GROUPS, ctrlCommand, escapeAction, isReloadKey, keysOf, titleOf, pageLabel, parsePageInput,
  keyLabel, isApplePlatform, setMacKeys, usesMacKeys, type EscapeState, type KeyLike,
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
    const tools = ["e", "h", "g", "z", "t", "a"];
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
  it("Ctrl+F = recherche (convention universelle) ; Ctrl+Maj+F pose un repere, quel que soit le focus (D3)", () => {
    expect(ctrlCommand(ctrl("f"))).toBe("search");
    expect(ctrlCommand(ctrl("k"))).toBe("search");
    expect(ctrlCommand(ctrl("f", true))).toBe("flag");
    expect(keysOf("search")).toBe("Ctrl+F");
  });

  it("Reglages (Ctrl+,), barre laterale (Ctrl+Maj+S) ; Ctrl+D ne bascule plus le doigt", () => {
    expect(ctrlCommand(ctrl(","))).toBe("settings");
    expect(ctrlCommand(ctrl("s", true))).toBe("sidebar");
    expect(ctrlCommand(ctrl("d"))).toBeNull();
    expect(ctrlCommand(ctrl("d", true))).toBe("viewMode");
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

  it("copier, couper, coller l'encre du lasso ; Ctrl+Maj+X reste la permutation", () => {
    expect(ctrlCommand(ctrl("c"))).toBe("copy");
    expect(ctrlCommand(ctrl("x"))).toBe("cut");
    expect(ctrlCommand(ctrl("v"))).toBe("paste");
    expect(ctrlCommand(ctrl("x", true))).toBe("swap");
  });

  it("aide : F1, Ctrl+/ et Ctrl+Maj+: (AZERTY)", () => {
    expect(ctrlCommand(press("F1"))).toBe("help");
    expect(ctrlCommand(press("/", { ctrlKey: true }))).toBe("help");
    expect(ctrlCommand(press("/", { ctrlKey: true, shiftKey: true, code: "Period" }))).toBe("help");
  });

  it("lettres seules, Alt et raccourcis inconnus : rien", () => {
    expect(ctrlCommand(press("f"))).toBeNull();
    expect(ctrlCommand(press("f", { altKey: true }))).toBeNull();
    expect(ctrlCommand(ctrl("b"))).toBeNull();
    expect(ctrlCommand(ctrl("q"))).toBeNull();
    expect(ctrlCommand(press("F1", { ctrlKey: true }))).toBeNull();
  });

  it("zoom en AZERTY : Ctrl+=, Ctrl+Maj+= (« + »), Ctrl+- (touche 6), Ctrl+à (touche 0)", () => {
    expect(ctrlCommand(press("=", { ctrlKey: true, code: "Equal" }))).toBe("zoomIn");
    expect(ctrlCommand(press("+", { ctrlKey: true, shiftKey: true, code: "Equal" }))).toBe("zoomIn");
    expect(ctrlCommand(press("-", { ctrlKey: true, code: "Digit6" }))).toBe("zoomOut");
    expect(ctrlCommand(press("à", { ctrlKey: true, code: "Digit0" }))).toBe("zoomReset");
    // QWERTY et pave numerique.
    expect(ctrlCommand(press("-", { ctrlKey: true, code: "Minus" }))).toBe("zoomOut");
    expect(ctrlCommand(press("+", { ctrlKey: true, code: "NumpadAdd" }))).toBe("zoomIn");
    expect(ctrlCommand(press("-", { ctrlKey: true, code: "NumpadSubtract" }))).toBe("zoomOut");
    expect(ctrlCommand(press("0", { ctrlKey: true, code: "Numpad0" }))).toBe("zoomReset");
    // AZERTY : la touche « ) » est code Minus, ce n'est pas un zoom.
    expect(ctrlCommand(press(")", { ctrlKey: true, code: "Minus" }))).toBeNull();
    // AltGr+0 (« @ ») et Alt+= (nouvelle formule) restent hors du zoom.
    expect(ctrlCommand(press("@", { ctrlKey: true, altKey: true, code: "Digit0" }))).toBeNull();
    expect(ctrlCommand(press("=", { altKey: true, code: "Equal" }))).toBeNull();
    expect(keysOf("zoomReset")).toBe("Ctrl+0");
  });
});

describe("infobulles et indicateur de page", () => {
  it("titleOf ajoute les touches de la table", () => {
    expect(keysOf("flag")).toBe("Ctrl+Maj+F");
    expect(titleOf("Pas compris", "flag")).toBe("Pas compris (Ctrl+Maj+F)");
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

describe("libelles des touches selon la plateforme", () => {
  it("Mac : ⌘ ⇧ ⌥ sans « + » ; Windows et Linux : en toutes lettres", () => {
    expect(keyLabel("Ctrl+Maj+F", true)).toBe("⌘⇧F");
    expect(keyLabel("Alt+E", true)).toBe("⌥E");
    expect(keyLabel("Ctrl+,", true)).toBe("⌘,");
    expect(keyLabel("Ctrl+Maj+F", false)).toBe("Ctrl+Maj+F");
    expect(keyLabel("F1", true)).toBe("F1");
  });

  it("plateforme Apple reconnue par l'agent ou la plateforme", () => {
    expect(isApplePlatform("Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5)")).toBe(true);
    expect(isApplePlatform("Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)")).toBe(true);
    expect(isApplePlatform("Mozilla/5.0 (Windows NT 10.0; Win64; x64)", "Win32")).toBe(false);
  });

  it("keysOf suit la plateforme choisie", () => {
    const was = usesMacKeys();
    setMacKeys(true);
    expect(keysOf("calc")).toBe("⌘L");
    setMacKeys(false);
    expect(keysOf("calc")).toBe("Ctrl+L");
    setMacKeys(was);
  });

  it("la fiche F1 montre une douzaine de raccourcis essentiels", () => {
    const n = SHORTCUTS.filter((s) => s.essential).length;
    expect(n).toBeGreaterThanOrEqual(10);
    expect(n).toBeLessThanOrEqual(14);
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

  it("calculatrice fermee, volet des formules non epingle, theme systeme et feuille Auto par defaut", () => {
    (globalThis as { localStorage?: unknown }).localStorage = ls;
    const s = loadSettings();
    expect(s.calcOpen).toBe(false);
    expect(s.formulasOpen).toBe(false);
    expect(s.formulasSplit).toBeNull();
    expect(s.theme).toBe("system");
    expect(s.sheet).toBe("auto");
    expect(s.sidebar).toBe(true);
    expect(s.calcDetached).toBe(false);
  });

  it("disposition 3 : l'ancienne feuille « claire » par defaut passe en Auto, un choix Sépia reste", () => {
    (globalThis as { localStorage?: unknown }).localStorage = ls;
    store.set("cahiers.settings.v1", JSON.stringify({ sheet: "light", layout: 2 }));
    expect(loadSettings().sheet).toBe("auto");
    store.set("cahiers.settings.v1", JSON.stringify({ sheet: "light", layout: 3 }));
    expect(loadSettings().sheet).toBe("light");
    store.set("cahiers.settings.v1", JSON.stringify({ sheet: "sepia", layout: 2 }));
    expect(loadSettings().sheet).toBe("sepia");
  });

  it("l'ancien defaut « calculatrice ouverte » est ferme une fois, puis respecte", () => {
    (globalThis as { localStorage?: unknown }).localStorage = ls;
    store.set("cahiers.settings.v1", JSON.stringify({ calcOpen: true }));
    const s = loadSettings();
    expect(s.calcOpen).toBe(false);
    expect(s.layout).toBe(3);
    // Rouverte ensuite par l'utilisateur (Ctrl+L) : le choix tient.
    store.set("cahiers.settings.v1", JSON.stringify({ ...s, calcOpen: true }));
    expect(loadSettings().calcOpen).toBe(true);
  });

  it("ancien volet epingle = volet ouvert, theme et feuille retenus ; valeurs inconnues ramenees au defaut", () => {
    (globalThis as { localStorage?: unknown }).localStorage = ls;
    store.set("cahiers.settings.v1", JSON.stringify({ mathOpen: true, mathPinned: true, theme: "dark", sheet: "sepia", layout: 2 }));
    const s = loadSettings();
    expect(s.formulasOpen).toBe(true);
    expect("mathPinned" in s).toBe(false);
    expect(s.theme).toBe("dark");
    expect(s.sheet).toBe("sepia");
    // L'ancien « ruban deplie » ne survit pas (remplace par l'epingle).
    expect("mathOpen" in s).toBe(false);
    // Le choix du volet ouvert tient ensuite, part bornee.
    store.set("cahiers.settings.v1", JSON.stringify({ formulasOpen: false, mathPinned: true, formulasSplit: 5 }));
    expect(loadSettings().formulasOpen).toBe(false);
    expect(loadSettings().formulasSplit).toBe(0.8);
    store.set("cahiers.settings.v1", JSON.stringify({ theme: "noir", sheet: 3, layout: 2 }));
    expect(loadSettings().theme).toBe("system");
    expect(loadSettings().sheet).toBe("auto");
  });

  it("Ctrl+Maj+M ouvre le ruban Maths, Ctrl+Maj+T change le theme ; Ctrl+M reste le menu", () => {
    expect(ctrlCommand(ctrl("m", true))).toBe("maths");
    expect(ctrlCommand(ctrl("t", true))).toBe("theme");
    expect(ctrlCommand(ctrl("m"))).toBe("menu");
    expect(ctrlCommand(ctrl("t"))).toBe("newDivider");
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

describe("nouvel intercalaire au clavier", () => {
  it("Ctrl+T, libre jusqu'ici, et dans la fiche F1", () => {
    expect(ctrlCommand(ctrl("t"))).toBe("newDivider");
    expect(keysOf("newDivider")).toBe("Ctrl+T");
    // Alt+T reste la zone texte : Ctrl+T ne la remplace pas.
    expect(ctrlCommand(press("t", { altKey: true }))).toBeNull();
  });
});

describe("Echap sur l'ecran cahier (deux fois pour le menu)", () => {
  const st = (over: Partial<EscapeState> = {}): EscapeState => ({
    again: false, handled: false, dialog: false, calc: false,
    field: false, selection: false, inText: false, ...over,
  });

  it("un seul Echap depuis un bouton (colonne d'outils) revient au texte, pas au menu", () => {
    expect(escapeAction(st())).toBe("to-text");
    expect(escapeAction(st({ again: true }))).toBe("menu");
  });

  it("dans le texte : le premier le quitte, le second de suite va au menu", () => {
    expect(escapeAction(st({ inText: true }))).toBe("leave-text");
    expect(escapeAction(st({ again: true }))).toBe("menu");
  });

  it("calculatrice qui a le clavier : il revient a la page, elle reste ouverte", () => {
    expect(escapeAction(st({ calc: true }))).toBe("release-calc");
    expect(escapeAction(st({ calc: true, again: true }))).toBe("release-calc");
  });

  it("ferme d'abord ce qui est ouvert : selection du lasso (le volet des formules, ancre, reste)", () => {
    expect(escapeAction(st({ selection: true, again: true }))).toBe("clear-selection");
  });

  it("jamais au menu quand une saisie se termine (champ, formule, composition) ni sous un dialogue", () => {
    expect(escapeAction(st({ field: true, again: true }))).toBe("leave-field");
    expect(escapeAction(st({ handled: true, again: true }))).toBe("ignore");
    expect(escapeAction(st({ dialog: true, again: true }))).toBe("ignore");
  });

  it("la fiche F1 dit « second Échap »", () => {
    const esc = SHORTCUTS.find((s) => s.keys === "Échap");
    expect(esc?.label).toMatch(/second Échap/);
  });
});
