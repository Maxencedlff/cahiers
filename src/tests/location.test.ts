import { describe, it, expect } from "vitest";
import {
  isEmptyDir, isFirstRun, planDestination, switchFlow, verifyCopy, NOT_READY, SUBFOLDER,
  type CopyReport, type DirReport, type Inventory, type LocationApi, type StorageInfo, type SwitchAsk, type Target,
} from "../core/storage/location";

const inv = (files: number, pages: number, bytes: number): Inventory => ({ files, pages, bytes });

function report(o: Partial<DirReport> = {}): DirReport {
  return {
    path: "D:/X", exists: true, entries: [], notebooks: 0, truncated: false, relation: "none",
    files: 0, pages: 0, bytes: 0, ...o,
  };
}

describe("emplacement : que faire du dossier vise", () => {
  it("dossier vide (ou seulement des fichiers systeme) : copie", () => {
    expect(planDestination(report(), "picked")).toEqual({ kind: "copy" });
    expect(planDestination(report({ exists: false }), "picked")).toEqual({ kind: "copy" });
    expect(planDestination(report({ entries: ["desktop.ini", ".DS_Store"] }), "picked")).toEqual({ kind: "copy" });
    expect(isEmptyDir(report({ entries: ["notes.txt"] }))).toBe(false);
  });

  it("dossier qui a deja des cahiers : l'ouvrir tel quel", () => {
    const r = report({ entries: ["Maths", "Vrac"], notebooks: 2, pages: 40, files: 50 });
    expect(planDestination(r, "picked")).toEqual({ kind: "open", notebooks: 2, pages: 40 });
  });

  it("autre chose dedans : sous-dossier Cahiers, puis refus s'il est occupe", () => {
    const r = report({ entries: ["Photos", "cv.pdf"], files: 300 });
    expect(planDestination(r, "picked")).toEqual({ kind: "subfolder" });
    expect(planDestination(r, "picked", true)).toEqual({ kind: "refuse" });
  });

  it("espace prive : Vrac vide mis de cote ; ancienne copie avec pages = choix (C-13)", () => {
    const skeleton = report({ entries: ["Vrac"], files: 1 });
    expect(planDestination(skeleton, "internal")).toEqual({ kind: "aside" });
    const used = report({ entries: ["Vrac", "Maths"], notebooks: 1, pages: 3, files: 5 });
    expect(planDestination(used, "internal")).toEqual({ kind: "reopen", notebooks: 1, pages: 3 });
    // Ailleurs, un dossier qui a des cahiers est toujours ouvert tel quel.
    expect(planDestination(used, "picked").kind).toBe("open");
  });

  it("racine actuelle ou dossier imbrique : rien", () => {
    expect(planDestination(report({ relation: "same" }), "picked").kind).toBe("current");
    expect(planDestination(report({ relation: "inside" }), "picked").kind).toBe("nested");
    expect(planDestination(report({ relation: "contains" }), "internal").kind).toBe("nested");
  });
});

describe("emplacement : verification de la copie", () => {
  it("meme nombre de fichiers, pages et octets", () => {
    expect(verifyCopy(inv(10, 4, 5000), inv(10, 4, 5000)).ok).toBe(true);
    const bad = verifyCopy(inv(10, 4, 5000), inv(10, 4, 4999));
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.message).toMatch(/Rien n'a basculé/);
    expect(verifyCopy(inv(10, 4, 5000), inv(9, 4, 5000)).ok).toBe(false);
    expect(verifyCopy(inv(10, 4, 5000), inv(10, 3, 5000)).ok).toBe(false);
  });
});

describe("premier lancement", () => {
  it("seulement Vrac vide et rien a cote", () => {
    expect(isFirstRun([{ dir: "Vrac", pageCount: 0 }], [])).toBe(true);
    expect(isFirstRun([], [])).toBe(true);
    expect(isFirstRun([{ dir: "Vrac", pageCount: 2 }], [])).toBe(false);
    expect(isFirstRun([{ dir: "Vrac", pageCount: 0 }, { dir: "Maths", pageCount: 0 }], [])).toBe(false);
    expect(isFirstRun([{ dir: "Vrac", pageCount: 0 }], [{ dir: "Photos" }])).toBe(false);
  });
});

/** Faux emplacement : des dossiers decrits, une copie qui rend ce qu'on lui dit. */
function fakeApi(o: {
  current: DirReport; picked?: string | null; targets: Record<string, DirReport>;
  copyResult?: (target: Target, sub?: string) => CopyReport; copyError?: string;
}) {
  const calls: string[] = [];
  let info: StorageInfo = { mode: "app", path: "APP", internal: "APP", missing: null };
  const api: LocationApi = {
    info: async () => info,
    pickFolder: async () => { calls.push("pick"); return o.picked === undefined ? "D:/Choisi" : o.picked; },
    inspect: async (target, sub) => {
      if (target === "current") return o.current;
      const key = sub ? `${target}/${sub}` : target;
      calls.push(`inspect:${key}`);
      return o.targets[key] ?? report({ exists: false, path: key });
    },
    copy: async (target, sub, aside) => {
      calls.push(`copy:${sub ? `${target}/${sub}` : target}${aside ? ":aside" : ""}`);
      if (o.copyError) throw new Error(o.copyError);
      return o.copyResult!(target, sub);
    },
    switchTo: async (target, sub) => {
      calls.push(`switch:${sub ? `${target}/${sub}` : target}`);
      info = { ...info, mode: target === "internal" ? "app" : "folder", path: sub ? `${target}/${sub}` : target };
      return info;
    },
    open: async () => {},
  };
  return { api, calls };
}

const yes: SwitchAsk = {
  confirmCopy: async () => true, confirmOpen: async () => true, confirmSubfolder: async () => true,
  chooseInternal: async () => "copy",
};

const okCopy = (src: Inventory) => (): CopyReport => ({ path: "x", source: src, dest: src, copied: src.files, same: 0, aside: null });

describe("emplacement : bascule", () => {
  const current = report({ path: "APP", relation: "same", files: 12, pages: 7, bytes: 9000 });

  it("vers un dossier vide : copie, verifie, puis bascule", async () => {
    const { api, calls } = fakeApi({
      current, targets: { picked: report({ path: "D:/Choisi" }) }, copyResult: okCopy(inv(12, 7, 9000)),
    });
    const out = await switchFlow(api, "picked", yes);
    expect(out.kind).toBe("switched");
    expect(calls).toEqual(["pick", "inspect:picked", "copy:picked", "switch:picked"]);
  });

  it("boite fermee : rien", async () => {
    const { api, calls } = fakeApi({ current, picked: null, targets: {} });
    expect((await switchFlow(api, "picked", yes)).kind).toBe("cancelled");
    expect(calls).toEqual(["pick"]);
  });

  it("copie incomplete : jamais de bascule", async () => {
    const { api, calls } = fakeApi({
      current, targets: { picked: report() },
      copyResult: () => ({ path: "x", source: inv(12, 7, 9000), dest: inv(11, 7, 8000), copied: 11, same: 0, aside: null }),
    });
    const out = await switchFlow(api, "picked", yes);
    expect(out.kind).toBe("failed");
    expect(calls.some((c) => c.startsWith("switch"))).toBe(false);
  });

  it("erreur de copie (fichier different a destination) : jamais de bascule", async () => {
    const { api, calls } = fakeApi({ current, targets: { picked: report() }, copyError: "rien n'a été copié" });
    const out = await switchFlow(api, "picked", yes);
    expect(out).toEqual({ kind: "failed", message: "rien n'a été copié" });
    expect(calls.some((c) => c.startsWith("switch"))).toBe(false);
  });

  it("copie refusee par l'utilisateur : rien n'est copie", async () => {
    const { api, calls } = fakeApi({ current, targets: { picked: report() }, copyResult: okCopy(inv(1, 1, 1)) });
    const out = await switchFlow(api, "picked", { ...yes, confirmCopy: async () => false });
    expect(out.kind).toBe("cancelled");
    expect(calls).toEqual(["pick", "inspect:picked"]);
  });

  it("dossier qui a deja des cahiers : ouvert tel quel, sans copie", async () => {
    const { api, calls } = fakeApi({
      current, targets: { picked: report({ entries: ["Maths"], notebooks: 1, pages: 30 }) },
    });
    const out = await switchFlow(api, "picked", yes);
    expect(out.kind).toBe("switched");
    expect(calls).toEqual(["pick", "inspect:picked", "switch:picked"]);
    const no = fakeApi({ current, targets: { picked: report({ entries: ["Maths"], notebooks: 1, pages: 30 }) } });
    expect((await switchFlow(no.api, "picked", { ...yes, confirmOpen: async () => false })).kind).toBe("cancelled");
    expect(no.calls.some((c) => c.startsWith("switch"))).toBe(false);
  });

  it("dossier occupe : copie dans le sous-dossier Cahiers", async () => {
    const { api, calls } = fakeApi({
      current, targets: { picked: report({ entries: ["Photos"], files: 80 }) }, copyResult: okCopy(inv(12, 7, 9000)),
    });
    const out = await switchFlow(api, "picked", yes);
    expect(out.kind).toBe("switched");
    expect(calls).toEqual(["pick", "inspect:picked", `inspect:picked/${SUBFOLDER}`, `copy:picked/${SUBFOLDER}`, `switch:picked/${SUBFOLDER}`]);
  });

  it("ramener dans l'appli : Vrac vide de l'espace prive mis de cote, puis copie", async () => {
    const { api, calls } = fakeApi({
      current: report({ path: "D:/ESEO", relation: "same", files: 400, pages: 250, bytes: 9e6 }),
      targets: { internal: report({ entries: ["Vrac"], notebooks: 1, files: 1 }) },
      copyResult: okCopy(inv(400, 250, 9e6)),
    });
    const out = await switchFlow(api, "internal", yes);
    expect(out.kind).toBe("switched");
    expect(calls).toEqual(["inspect:internal", "copy:internal:aside", "switch:internal"]);
  });

  it("tout est ecrit et la presence liberee seulement apres confirmation, juste avant la copie", async () => {
    // C-18 : une annulation ne doit rien liberer ; C-11 : le voile se pose la.
    const { api, calls } = fakeApi({ current, targets: { picked: report() }, copyResult: okCopy(inv(12, 7, 9000)) });
    const ask: SwitchAsk = { ...yes, ready: async () => { calls.push("ready"); return true; } };
    expect((await switchFlow(api, "picked", ask)).kind).toBe("switched");
    expect(calls).toEqual(["pick", "inspect:picked", "ready", "copy:picked", "switch:picked"]);

    const no = fakeApi({ current, targets: { picked: report() }, copyResult: okCopy(inv(1, 1, 1)) });
    const refused: SwitchAsk = { ...yes, confirmCopy: async () => false, ready: async () => { no.calls.push("ready"); return true; } };
    expect((await switchFlow(no.api, "picked", refused)).kind).toBe("cancelled");
    expect(no.calls).not.toContain("ready");
  });

  it("une page refusee par le disque : rien n'est copie ni bascule", async () => {
    const { api, calls } = fakeApi({ current, targets: { picked: report() }, copyResult: okCopy(inv(12, 7, 9000)) });
    const out = await switchFlow(api, "picked", { ...yes, ready: async () => false });
    expect(out).toEqual({ kind: "unchanged", message: NOT_READY });
    expect(calls).toEqual(["pick", "inspect:picked"]);
    const open = fakeApi({ current, targets: { picked: report({ entries: ["Maths"], notebooks: 1, pages: 30 }) } });
    expect((await switchFlow(open.api, "picked", { ...yes, ready: async () => false })).kind).toBe("unchanged");
    expect(open.calls.some((c) => c.startsWith("switch"))).toBe(false);
  });

  it("ramener dans l'appli qui a une ancienne copie : mise de cote puis copie des notes actuelles", async () => {
    const setup = () => fakeApi({
      current: report({ path: "D:/ESEO", relation: "same", files: 400, pages: 250, bytes: 9e6 }),
      targets: { internal: report({ entries: ["Vrac", "Maths"], notebooks: 1, pages: 3, files: 5 }) },
      copyResult: okCopy(inv(400, 250, 9e6)),
    });
    const copy = setup();
    let confirmCopy = 0;
    const out = await switchFlow(copy.api, "internal", { ...yes, confirmCopy: async () => { confirmCopy++; return true; } });
    expect(out.kind).toBe("switched");
    expect(copy.calls).toEqual(["inspect:internal", "copy:internal:aside", "switch:internal"]);
    expect(confirmCopy).toBe(0); // une seule question
    const reopen = setup();
    expect((await switchFlow(reopen.api, "internal", { ...yes, chooseInternal: async () => "open" })).kind).toBe("switched");
    expect(reopen.calls).toEqual(["inspect:internal", "switch:internal"]);
    const cancel = setup();
    expect((await switchFlow(cancel.api, "internal", { ...yes, chooseInternal: async () => null })).kind).toBe("cancelled");
    expect(cancel.calls).toEqual(["inspect:internal"]);
  });

  it("dossier dans l'emplacement actuel : refuse sans rien faire", async () => {
    const { api, calls } = fakeApi({ current, targets: { picked: report({ relation: "inside" }) } });
    expect((await switchFlow(api, "picked", yes)).kind).toBe("unchanged");
    expect(calls).toEqual(["pick", "inspect:picked"]);
  });
});
