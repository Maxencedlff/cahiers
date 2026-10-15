#!/usr/bin/env python3
"""
Banc de la pagination facon Word (Playwright), sur des pages de test du
mode navigateur (localStorage, jamais les cahiers reels) :
  - lignes effacees au milieu d'une page : le haut de sa suite remonte seul ;
  - Ctrl+Z juste apres : les deux pages reviennent ;
  - assez de place : la suite remonte entiere et part a la corbeille ;
  - Entree en bas de la derniere page : nouvelle page tout de suite, curseur
    dedans, la frappe continue ; Retour arriere : elle disparait ;
  - encre et formules de la suite gardees ;
  - Ctrl+A : tout le document (toutes les pages de la suite), copier,
    gras, Suppr puis Ctrl+Z.
Chaque scenario tourne en defilement puis en mode pages. Aucune ligne ne
doit manquer ni etre en double.

Prerequis : l'appli servie SANS le serveur de dev (d'autres editent les
sources : HMR). Cote Windows :
  npx vite build --outDir C:\\Users\\maxde\\AppData\\Local\\Temp\\cahiers-pag
  npx vite preview --outDir C:\\Users\\maxde\\AppData\\Local\\Temp\\cahiers-pag --port 1452 --host 0.0.0.0
puis depuis WSL :
  CAHIERS_URL=http://$(ip route show default | awk '{print $3}'):1452/ python3 scripts/banc-pagination.py [filtre]

Code de sortie 1 si une verification echoue.
"""
import json
import os
import sys

from playwright.sync_api import sync_playwright

URL = os.environ.get("CAHIERS_URL", "http://127.0.0.1:1452/")
PAUSE = 2600  # pause de frappe (remontee a 900 ms) + ecritures

problemes: list[str] = []


def verifier(cond: bool, msg: str) -> None:
    print(("  OK   " if cond else "  RATE ") + msg)
    if not cond:
        problemes.append(msg)


def ligne(i: int) -> str:
    return f"Ligne {i:02d} du cours de maths"


def page_json(pid: str, lignes: list[str], suite: str | None = None, blocs: list | None = None) -> str:
    p = {"version": 1, "id": pid, "created": "2026-10-15T10:00:00.000Z", "modified": "2026-10-15T10:00:00.000Z",
         "blocks": [{"id": pid + "-t", "type": "text", "content": "\n".join(lignes)}] + (blocs or [])}
    if suite:
        p["continues"] = suite
    return json.dumps(p)


def trait(sid: str, y: float) -> dict:
    return {"id": sid, "tool": "pen", "color": "normal", "width": 2,
            "points": [{"x": 100 + i * 6, "y": y + (i % 3), "p": 0.5, "t": i * 10} for i in range(12)]}


def pages_disque(page) -> list[dict]:
    tree = json.loads(page.evaluate("localStorage.getItem('cahiers.fs.v1')"))
    out = []
    for k in sorted(tree):
        if k.startswith("Maths/Cours/") and k.endswith(".page.json"):
            out.append(json.loads(tree[k]))
    return out


def texte(p: dict) -> str:
    return next((b["content"] for b in p["blocks"] if b["type"] == "text" and not b.get("rect")), "")


def lignes_pleines(pages: list[dict]) -> list[str]:
    return [l for p in pages for l in texte(p).split("\n") if l.strip()]


def traits(pages: list[dict]) -> list[str]:
    return sorted(s["id"] for p in pages for b in p["blocks"] if b["type"] in ("ink", "math") for s in b["strokes"])


def ouvrir(pw, mode: str, pages: list[str]):
    nav = pw.chromium.launch(args=["--mute-audio"])
    ctx = nav.new_context(viewport={"width": 1500, "height": 940})
    page = ctx.new_page()
    erreurs: list[str] = []
    page.on("pageerror", lambda e: erreurs.append(str(e)))
    page.goto(URL, wait_until="networkidle")
    page.evaluate("localStorage.clear()")
    page.reload(wait_until="networkidle")
    page.wait_for_timeout(700)
    tree = json.loads(page.evaluate("localStorage.getItem('cahiers.fs.v1')"))
    for i, pj in enumerate(pages):
        tree[f"Maths/Cours/{i + 1:04d}.page.json"] = pj
    meta = json.loads(tree["Maths/cahier.json"])
    meta["viewMode"] = {"Cours": mode}
    tree["Maths/cahier.json"] = json.dumps(meta)
    page.evaluate("t => localStorage.setItem('cahiers.fs.v1', t)", json.dumps(tree))
    page.reload(wait_until="networkidle")
    page.wait_for_timeout(700)
    page.get_by_text("Maths", exact=True).first.click()
    page.wait_for_timeout(1500)
    return nav, page, erreurs


def page_du_curseur(page) -> str | None:
    return page.evaluate("() => document.activeElement?.closest('[data-page]')?.dataset.page ?? null")


def aller_ligne(page, doc_index: int, n: int) -> None:
    """Curseur au debut de la ligne n (0 = premiere) du texte de la feuille doc_index affichee."""
    page.locator(".text-doc").nth(doc_index).click()
    page.keyboard.press("Control+Home")
    for _ in range(n):
        page.keyboard.press("ArrowDown")
    page.keyboard.press("Home")


def scenario_remontee(pw, mode: str) -> None:
    print(f"\n[{mode}] lignes effacees au milieu : la suite remonte")
    nav, page, err = ouvrir(pw, mode, [page_json("P1", [ligne(i) for i in range(1, 34)]),
                                        page_json("P2", [ligne(i) for i in range(34, 41)], "P1")])
    aller_ligne(page, 0, 4)
    for _ in range(5):
        page.keyboard.press("Shift+ArrowDown")
    page.keyboard.press("Delete")
    page.wait_for_timeout(PAUSE)
    ps = pages_disque(page)
    attendu = [ligne(i) for i in range(1, 41) if not 5 <= i <= 9]
    verifier(lignes_pleines(ps) == attendu, "aucune ligne perdue ni en double")
    verifier(len(ps) == 2 and ps[1]["id"] == "P2" and ps[1].get("continues") == "P1", "la suite garde son id et son lien")
    t1 = texte(ps[0]).split("\n")
    verifier(ligne(38) in t1 and ligne(39) not in t1, f"le haut de la suite est remonte (p1 finit par « {t1[-1]} »)")
    page.keyboard.type("X")
    page.wait_for_timeout(1700)
    t1 = texte(pages_disque(page)[0]).split("\n")
    verifier(len(t1) > 4 and t1[4].startswith("X"), "le curseur n'a pas bouge (la frappe va au meme endroit)")
    page.keyboard.press("Backspace")
    page.wait_for_timeout(PAUSE)
    # Ctrl+Z juste apres une remontee : la frappe d'avant et les deux pages reviennent.
    aller_ligne(page, 0, 4)
    for _ in range(3):
        page.keyboard.press("Shift+ArrowDown")
    page.keyboard.press("Delete")
    page.wait_for_timeout(PAUSE)
    avant = lignes_pleines(pages_disque(page))
    page.keyboard.press("Control+z")
    page.wait_for_timeout(PAUSE)
    apres = lignes_pleines(pages_disque(page))
    verifier(len(avant) == len(attendu) - 3, "3 lignes de plus effacees")
    verifier(apres == attendu, "Ctrl+Z rend les lignes effacees, la suite reprend les siennes")
    verifier(not err, f"aucune erreur JS {err[:2]}")
    nav.close()


def scenario_remontee_entiere(pw, mode: str) -> None:
    print(f"\n[{mode}] beaucoup de place : la suite remonte entiere, encre et formule gardees")
    blocs = [{"id": "P2-ink", "type": "ink", "strokes": [trait("s1", 200), trait("s2", 260)], "recognized": None, "mode": "raw"}]
    l2 = [ligne(34), "Formule $\\frac{a}{b}$ du cours", ligne(36)]
    nav, page, err = ouvrir(pw, mode, [page_json("P1", [ligne(i) for i in range(1, 34)]),
                                        page_json("P2", l2, "P1", blocs),
                                        page_json("P3", ["Page ajoutee a la main"])])
    aller_ligne(page, 0, 2)
    for _ in range(20):
        page.keyboard.press("Shift+ArrowDown")
    page.keyboard.press("Delete")
    page.wait_for_timeout(PAUSE + 1000)
    ps = pages_disque(page)
    attendu = [ligne(i) for i in range(1, 34) if not 3 <= i <= 22] + l2 + ["Page ajoutee a la main"]
    verifier(lignes_pleines(ps) == attendu, "aucune ligne perdue ni en double")
    verifier(len(ps) == 2 and ps[0]["id"] == "P1" and ps[1]["id"] == "P3", "la suite vide est partie, la page a la main reste")
    verifier(traits(ps) == ["s1", "s2"], "l'encre de la suite est remontee avec elle")
    verifier(not err, f"aucune erreur JS {err[:2]}")
    nav.close()


def scenario_entree(pw, mode: str) -> None:
    print(f"\n[{mode}] Entree en bas de page : nouvelle page, puis Retour arriere")
    nav, page, err = ouvrir(pw, mode, [page_json("P1", [ligne(i) for i in range(1, 32)])])
    page.locator(".text-doc").first.click()
    page.keyboard.press("Control+End")
    for _ in range(3):
        page.keyboard.press("Enter")
        page.wait_for_timeout(120)
    page.wait_for_timeout(800)
    ps = pages_disque(page)
    verifier(len(ps) == 2, f"la 3e Entree ouvre une page ({len(ps)} page(s))")
    verifier(page_du_curseur(page) == "2", f"curseur sur la nouvelle page (page {page_du_curseur(page)})")
    page.keyboard.type("abc")
    page.wait_for_timeout(1500)
    ps = pages_disque(page)
    verifier(len(ps) == 2 and "abc" in texte(ps[1]) and "abc" not in texte(ps[0]), "la frappe continue sur la nouvelle page")
    for _ in range(3):
        page.keyboard.press("Backspace")
        page.wait_for_timeout(100)
    # Retour arriere jusqu'a ce que la page vide disparaisse (lignes vides, puis la tete de page).
    for _ in range(6):
        page.keyboard.press("Backspace")
        page.wait_for_timeout(700)
        if len(pages_disque(page)) == 1:
            break
    page.wait_for_timeout(PAUSE)
    ps = pages_disque(page)
    print("        page 1 finit par :", repr(texte(ps[0])[-40:]))
    verifier(len(ps) == 1, f"la page vide disparait ({len(ps)} page(s))")
    verifier(lignes_pleines(ps) == [ligne(i) for i in range(1, 32)], "le texte de la page 1 est intact")
    verifier(page_du_curseur(page) == "1", "curseur revenu sur la page 1")
    verifier(not err, f"aucune erreur JS {err[:2]}")
    nav.close()


def scenario_ctrl_a(pw, mode: str) -> None:
    print(f"\n[{mode}] Ctrl+A : tout le document")
    nav, page, err = ouvrir(pw, mode, [page_json("P1", [ligne(i) for i in range(1, 34)]),
                                        page_json("P2", [ligne(i) for i in range(34, 41)], "P1"),
                                        page_json("P3", ["Autre sujet a la main"])])
    attendu = [ligne(i) for i in range(1, 41)]
    page.locator(".text-doc").first.click()
    page.keyboard.press("Control+a")
    page.wait_for_timeout(400)
    sel = page.evaluate("() => document.querySelectorAll('.sheet.doc-sel').length")
    verifier(sel >= 1, f"les pages de la suite sont surlignees ({sel})")
    # Presse-papiers relu au vol (la page de test n'est pas en https : pas de navigator.clipboard).
    page.evaluate("""() => { window.__clip = {}; const set = DataTransfer.prototype.setData;
      DataTransfer.prototype.setData = function (t, v) { window.__clip[t] = v; return set.call(this, t, v); }; }""")
    page.keyboard.press("Control+c")
    page.wait_for_timeout(300)
    clip = page.evaluate("() => window.__clip['text/plain'] ?? ''")
    verifier([l for l in clip.split("\n") if l.strip()] == attendu, "Ctrl+C copie les 2 pages (pas la page a la main)")
    page.keyboard.press("Control+b")
    page.wait_for_timeout(PAUSE)
    ps = pages_disque(page)
    verifier(all(l.startswith("**") for l in lignes_pleines(ps[:2])) and "**" not in texte(ps[2]),
             "Ctrl+B met tout le document en gras, pas la page d'apres")
    page.keyboard.press("Control+z")
    page.wait_for_timeout(PAUSE)
    ps = pages_disque(page)
    verifier(lignes_pleines(ps) == attendu + ["Autre sujet a la main"], "Ctrl+Z retire le gras")
    page.locator(".text-doc").first.click()
    page.keyboard.press("Control+a")
    page.wait_for_timeout(400)
    page.keyboard.press("Delete")
    page.wait_for_timeout(PAUSE)
    ps = pages_disque(page)
    verifier(lignes_pleines(ps) == ["Autre sujet a la main"] and len(ps) == 2, "Suppr efface les 2 pages de la suite, une page vide reste")
    page.keyboard.press("Control+z")
    page.wait_for_timeout(PAUSE)
    ps = pages_disque(page)
    verifier(lignes_pleines(ps) == attendu + ["Autre sujet a la main"] and len(ps) == 3, "Ctrl+Z rend tout le document")
    # Echap : la selection document tombe, Ctrl+A d'une page seule = la page.
    page.locator(".text-doc").first.click()
    page.keyboard.press("Control+a")
    page.keyboard.press("Escape")
    page.wait_for_timeout(200)
    verifier(page.evaluate("() => document.querySelectorAll('.sheet.doc-sel').length") == 0, "Echap retire la selection document")
    verifier(not err, f"aucune erreur JS {err[:2]}")
    nav.close()


def scenario_cascade(pw, mode: str) -> None:
    print(f"\n[{mode}] trois pages pleines : la remontee se propage de suite en suite")
    nav, page, err = ouvrir(pw, mode, [page_json("P1", [ligne(i) for i in range(1, 34)]),
                                        page_json("P2", [ligne(i) for i in range(34, 67)], "P1"),
                                        page_json("P3", [ligne(i) for i in range(67, 75)], "P2")])
    aller_ligne(page, 0, 4)
    for _ in range(5):
        page.keyboard.press("Shift+ArrowDown")
    page.keyboard.press("Delete")
    page.wait_for_timeout(PAUSE)
    if mode == "pages":
        # La page 2 n'est pas affichee : elle remonte sa suite quand on y va.
        page.keyboard.press("Control+PageDown")
        page.wait_for_timeout(PAUSE)
    ps = pages_disque(page)
    attendu = [ligne(i) for i in range(1, 75) if not 5 <= i <= 9]
    verifier(lignes_pleines(ps) == attendu, "aucune ligne perdue ni en double")
    n = [len([l for l in texte(p).split("\n") if l.strip()]) for p in ps]
    verifier(n[:2] == [33, 33] and n[2] == 3, f"pages 1 et 2 pleines, la 3 raccourcie ({n})")
    verifier(not err, f"aucune erreur JS {err[:2]}")
    nav.close()


SCENARIOS = {
    "remontee": scenario_remontee,
    "entiere": scenario_remontee_entiere,
    "cascade": scenario_cascade,
    "entree": scenario_entree,
    "ctrla": scenario_ctrl_a,
}


def main() -> int:
    filtre = sys.argv[1] if len(sys.argv) > 1 else ""
    modes = [m for m in ("scroll", "pages") if not (len(sys.argv) > 2 and sys.argv[2] != m)]
    with sync_playwright() as pw:
        for nom, f in SCENARIOS.items():
            if filtre and filtre not in nom:
                continue
            for mode in modes:
                f(pw, mode)
    print(f"\n{len(problemes)} echec(s)")
    for p in problemes:
        print("  - " + p)
    return 1 if problemes else 0


if __name__ == "__main__":
    sys.exit(main())
