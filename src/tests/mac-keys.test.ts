import { describe, it, expect, afterEach } from "vitest";
import {
  altKeyName, ctrlCommand, isApplePlatform, isMacSystemKey, keyLabel, keysOf, setMacKeys, typesChar,
  usesMacKeys, type KeyLike,
} from "../core/shortcuts";
import { mapKey } from "../ui/calculator/keys";

/** Evenement clavier minimal. */
function press(key: string, code: string, mods: Partial<KeyLike> = {}): KeyLike {
  return { key, code, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, ...mods };
}
const opt = (key: string, code: string, shift = false) => press(key, code, { altKey: true, shiftKey: shift });

const was = usesMacKeys();
afterEach(() => setMacKeys(was));

describe("Option sur Mac : la touche physique", () => {
  it("Option+= tape « ≠ » : c'est Alt+=", () => {
    expect(altKeyName(opt("≠", "Equal"))).toBe("=");
    expect(altKeyName(opt("±", "Equal", true))).toBe("=");
  });
  it("Option+lettre : ƒ, ∏, touche morte → la lettre", () => {
    expect(altKeyName(opt("ƒ", "KeyF"))).toBe("f");
    expect(altKeyName(opt("∏", "KeyP", true))).toBe("p");
    expect(altKeyName(opt("Dead", "KeyE"))).toBe("e");
    expect(altKeyName(opt("ˆ", "KeyI"))).toBe("i");
  });
  it("Option+chiffre : ¡ ™ → le chiffre (couleurs)", () => {
    expect(altKeyName(opt("¡", "Digit1"))).toBe("1");
    expect(altKeyName(opt("™", "Digit2"))).toBe("2");
    expect(altKeyName(opt("º", "Digit0"))).toBe("0");
  });
});

describe("Alt sous Windows : rien ne change", () => {
  it("QWERTY : la lettre ou le chiffre tape", () => {
    expect(altKeyName(opt("e", "KeyE"))).toBe("e");
    expect(altKeyName(opt("3", "Digit3"))).toBe("3");
    expect(altKeyName(opt("=", "Equal"))).toBe("=");
    expect(altKeyName(opt("+", "Equal", true))).toBe("=");
  });
  it("AZERTY : la lettre de la disposition passe avant la place physique", () => {
    expect(altKeyName(opt("a", "KeyQ"))).toBe("a");
    expect(altKeyName(opt("z", "KeyW"))).toBe("z");
    expect(altKeyName(opt("q", "KeyA"))).toBe("q");
  });
  it("AZERTY : rangee des chiffres sans Maj (& é \" ' ( à) → chiffre", () => {
    expect(altKeyName(opt("&", "Digit1"))).toBe("1");
    expect(altKeyName(opt("é", "Digit2"))).toBe("2");
    expect(altKeyName(opt("(", "Digit5"))).toBe("5");
    expect(altKeyName(opt("à", "Digit0"))).toBe("0");
    expect(altKeyName(opt("=", "Equal"))).toBe("=");
  });
  it("touches non imprimables gardees telles quelles", () => {
    expect(altKeyName(opt("ArrowLeft", "ArrowLeft"))).toBe("ArrowLeft");
  });
});

describe("Cmd sur Mac", () => {
  const cmd = (key: string, shift = false) => press(key, "", { metaKey: true, shiftKey: shift });
  const ctl = (key: string, shift = false) => press(key, "", { ctrlKey: true, shiftKey: shift });

  it("Cmd fait office de Ctrl", () => {
    expect(ctrlCommand(cmd("l"), true)).toBe("calc");
    expect(ctrlCommand(cmd("f"), true)).toBe("search");
    expect(ctrlCommand(cmd("F", true), true)).toBe("flag");
    expect(ctrlCommand(cmd("Z", true), true)).toBe("redo");
    expect(ctrlCommand(cmd(","), true)).toBe("settings");
    expect(ctrlCommand(cmd("H", true), true)).toBe("schema");
  });
  it("Cmd+Q, H, W, M restent au systeme ; Controle les remplace", () => {
    for (const k of ["q", "h", "w", "m"]) {
      expect(isMacSystemKey(cmd(k), true)).toBe(true);
      expect(ctrlCommand(cmd(k), true)).toBeNull();
    }
    expect(ctrlCommand(ctl("w"), true)).toBe("closeTab");
    expect(ctrlCommand(ctl("m"), true)).toBe("menu");
    expect(ctrlCommand(cmd("W", true), true)).toBe("closeSplit");
  });
  it("hors Mac, rien ne change (Windows : Ctrl+W, Ctrl+M)", () => {
    expect(ctrlCommand(ctl("w"), false)).toBe("closeTab");
    expect(ctrlCommand(ctl("m"), false)).toBe("menu");
    expect(isMacSystemKey(cmd("w"), false)).toBe(false);
  });
});

describe("libelles Mac", () => {
  it("⌘ pour Ctrl, ⌥ pour Alt, ⌃ pour les touches du systeme", () => {
    expect(keyLabel("Alt+=", true)).toBe("⌥=");
    expect(keyLabel("Alt+Maj+=", true)).toBe("⌥⇧=");
    expect(keyLabel("Ctrl+W", true)).toBe("⌃W");
    expect(keyLabel("Ctrl+M", true)).toBe("⌃M");
    expect(keyLabel("Ctrl+Tab", true)).toBe("⌃Tab");
    expect(keyLabel("Ctrl+Maj+W", true)).toBe("⌘⇧W");
    expect(keyLabel("Ctrl+W", false)).toBe("Ctrl+W");
  });
  it("infobulles : fermer l'onglet en ⌃W sur Mac, Ctrl+W ailleurs", () => {
    setMacKeys(true);
    expect(keysOf("closeTab")).toBe("⌃W");
    expect(keysOf("menu")).toBe("⌃M");
    expect(keysOf("calc")).toBe("⌘L");
    setMacKeys(false);
    expect(keysOf("closeTab")).toBe("Ctrl+W");
  });
  it("plateforme lue aussi dans userAgentData (« macOS »)", () => {
    expect(isApplePlatform("Mozilla/5.0", "macOS")).toBe(true);
    expect(isApplePlatform("Mozilla/5.0 (Windows NT 10.0)", "Windows")).toBe(false);
  });
});

describe("frappe d'un caractere", () => {
  it("Option seule tape sur Mac, pas sous Windows (raccourci)", () => {
    expect(typesChar(opt("{", "Digit5"), true)).toBe(true);
    expect(typesChar(opt("{", "Digit5"), false)).toBe(false);
  });
  it("AltGr (Ctrl+Alt) tape sous Windows ; Cmd jamais", () => {
    expect(typesChar(press("@", "Digit0", { ctrlKey: true, altKey: true }), false)).toBe(true);
    expect(typesChar(press("a", "KeyA", { metaKey: true }), true)).toBe(false);
    expect(typesChar(press("a", "KeyA"), false)).toBe(true);
  });
  it("calculatrice : Option+( = [ sur Mac AZERTY s'ecrit, les autres Option restent des raccourcis", () => {
    expect(mapKey({ key: "[", code: "Digit5", altKey: true, shiftKey: true }, true)).toEqual({ kind: "insert", text: "[" });
    expect(mapKey({ key: "{", code: "Digit5", altKey: true }, true)).toEqual({ kind: "insert", text: "{" });
    expect(mapKey({ key: "≠", code: "Equal", altKey: true }, true)).toBeNull();
    expect(mapKey({ key: "[", altKey: true }, false)).toBeNull();
  });
});
