#!/usr/bin/env python3
"""
Banc de saisie rapide (feuille de route, point 2) : tableaux dans le texte
tape, joues au clavier dans la vraie interface (Playwright), mode
navigateur (localStorage, jamais les cahiers reels).

Verifie :
  - ancien format : une page avec « |x| < 1 », une formule \\begin{array} et
    un tableau pipe s'ouvre telle quelle, rien n'est reecrit au chargement ;
  - insertion (Ctrl+Maj+G), Tab / Maj+Tab, Tab dans la derniere case = ligne
    de plus, Entree = case du dessous / nouvelle ligne, Entree sur une ligne
    vide = sortie, formules tapees dans les cases (meme conversion que le
    texte), Retour arriere juste apres le tableau (n'efface pas), barre
    (+ Colonne), Echap ;
  - enregistrement lisible (tableau pipe) et relecture identique apres
    rechargement ; aucune erreur JS.

Prerequis : vite preview d'un build, playwright (chromium).
Usage : CAHIERS_URL=http://hote:port/ python3 scripts/banc-saisie.py [dossier_captures]
"""
import json
import os
import sys

from playwright.sync_api import sync_playwright

URL = os.environ.get("CAHIERS_URL", "http://127.0.0.1:1420/")
SHOTS = sys.argv[1] if len(sys.argv) > 1 else None
problemes: list[str] = []


def verifie(ok: bool, msg: str) -> None:
    print(("OK   " if ok else "RATE ") + msg)
    if not ok:
        problemes.append(msg)


def page_json(pid: str, content: str) -> str:
    return json.dumps({"version": 1, "id": pid, "created": "2026-10-15T10:00:00.000Z", "modified": "2026-10-15T10:00:00.000Z",
                       "blocks": [{"id": pid + "-t", "type": "text", "content": content}]})


def ouvrir(pw, pages: list[str]):
    nav = pw.chromium.launch(args=["--mute-audio"])
    ctx = nav.new_context(viewport={"width": 1400, "height": 940})
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
    page.evaluate("t => localStorage.setItem('cahiers.fs.v1', t)", json.dumps(tree))
    page.reload(wait_until="networkidle")
    page.wait_for_timeout(700)
    page.get_by_text("Maths", exact=True).first.click()
    page.wait_for_timeout(1500)
    return nav, page, erreurs


def disque(page, n: int = 1) -> str:
    tree = json.loads(page.evaluate("localStorage.getItem('cahiers.fs.v1')"))
    p = json.loads(tree[f"Maths/Cours/{n:04d}.page.json"])
    return next((b["content"] for b in p["blocks"] if b["type"] == "text" and not b.get("rect")), "")


def capture(page, nom: str) -> None:
    if SHOTS:
        os.makedirs(SHOTS, exist_ok=True)
        page.screenshot(path=os.path.join(SHOTS, f"{nom}.png"))


def tape(page, s: str) -> None:
    page.keyboard.type(s, delay=45)


def scenario_ancien_format(pw) -> None:
    ancien = ("Ancienne page\n|x| < 1 donc la serie converge\n"
              "$\\begin{array}{c|c} a & b \\\\ c & d \\end{array}$\n"
              "| p | $F(p)$ |\n| --- | --- |\n| 0 | $\\frac{1}{2}$ |\nSuite du cours")
    nav, page, err = ouvrir(pw, [page_json("A", ancien)])
    page.wait_for_timeout(600)
    verifie(page.locator(".doc-table").count() == 1, "ancien format : le tableau pipe s'affiche en tableau")
    verifie(page.locator(".doc-table td").count() == 4, "ancien format : 2 x 2 cases")
    verifie(page.locator(".doc-table .eq").count() == 2, "ancien format : formules dans les cases rendues")
    txt = page.locator(".text-doc").first.inner_text()
    verifie("|x| < 1 donc la serie converge" in txt, "ancien format : la ligne « |x| < 1 » reste du texte")
    verifie(disque(page) == ancien, "ancien format : rien de reecrit au chargement")
    capture(page, "saisie-ancien")
    verifie(not err, f"ancien format : aucune erreur JS {err[:2]}")
    nav.close()


def scenario_frappe(pw) -> None:
    nav, page, err = ouvrir(pw, [page_json("B", "")])
    doc = page.locator(".text-doc").first
    # En haut du texte (un clic plus bas ajoute des lignes vides jusqu'a lui, comme OneNote).
    doc.click(position={"x": 200, "y": 60})
    tape(page, "Reponse indicielle du 1er ordre")
    page.keyboard.press("Enter")
    page.keyboard.press("Control+Shift+G")
    page.wait_for_timeout(300)
    verifie(page.locator(".doc-table").count() == 1, "Ctrl+Maj+G pose un tableau")
    foc = page.evaluate("() => !!document.activeElement?.closest('.doc-table .cell-doc')")
    verifie(foc, "le clavier est dans la premiere case")
    # En-tete, puis lignes : Tab case suivante, Tab dans la derniere = ligne de plus.
    tape(page, "t")
    page.keyboard.press("Tab")
    tape(page, "y(t)")
    page.keyboard.press("Tab")
    tape(page, "0")
    page.keyboard.press("Tab")
    tape(page, "0")
    page.keyboard.press("Tab")
    verifie(page.locator(".doc-table tr").count() == 3, "Tab dans la derniere case ajoute une ligne")
    tape(page, "tau")
    page.keyboard.press("Tab")
    tape(page, "K(1 - e^-1) ~= 0,63K")
    page.keyboard.press("Enter")
    verifie(page.locator(".doc-table tr").count() == 4, "Entree a la derniere ligne : nouvelle ligne")
    tape(page, "5tau")
    page.keyboard.press("Tab")
    tape(page, "0,99K")
    page.keyboard.press("Enter")
    page.keyboard.press("Enter")
    verifie(page.locator(".doc-table tr").count() == 4, "Entree sur une ligne vide : elle disparait, on sort")
    sortie = page.evaluate("() => !document.activeElement?.closest('.cell-doc')")
    verifie(sortie, "apres la sortie, le clavier est dans le texte de la page")
    tape(page, "On lit tau a 63 %.")
    page.wait_for_timeout(1500)
    capture(page, "saisie-tableau")
    md = disque(page)
    print("      disque :", md.replace("\n", " ⏎ "))
    lignes = md.split("\n")
    verifie(lignes[0] == "Reponse indicielle du 1er ordre", "ligne avant le tableau intacte")
    verifie(len(lignes) > 6 and lignes[1].startswith("| t |") and lignes[2] == "| --- | --- |", "tableau pipe lisible sur le disque")
    verifie(any("$" in l and l.startswith("| ") for l in lignes[3:6]), "formule tapee dans une case : $…$ dans le tableau")
    verifie("τ" in md or "\\tau" in md, "« tau » converti dans une case")
    verifie(lignes[-1].startswith("On lit"), "texte tape apres le tableau sur sa propre ligne")

    # Retour arriere au debut de la ligne qui suit : entre dans la derniere case, n'efface rien.
    page.keyboard.press("Home")
    page.keyboard.press("Backspace")
    page.wait_for_timeout(200)
    dans = page.evaluate("() => !!document.activeElement?.closest('.doc-table .cell-doc')")
    verifie(dans and page.locator(".doc-table").count() == 1, "Retour arriere apres le tableau : entre dans la case, n'efface pas")
    # Fleches entre lignes, puis barre : + Colonne.
    page.keyboard.press("ArrowUp")
    page.keyboard.press("ArrowUp")
    page.locator(".doc-table-bar button", has_text="+ Colonne").click()
    page.wait_for_timeout(200)
    verifie(page.locator(".doc-table tr").first.locator("td").count() == 3, "+ Colonne ajoute une colonne")
    tape(page, "note")
    page.keyboard.press("Escape")
    page.wait_for_timeout(1500)
    capture(page, "saisie-colonne")
    md2 = disque(page)
    verifie(md2.split("\n")[2] == "| --- | --- | --- |", "3 colonnes sur le disque")
    # Relecture apres rechargement : meme texte.
    page.reload(wait_until="networkidle")
    page.wait_for_timeout(800)
    page.get_by_text("Maths", exact=True).first.click()
    page.wait_for_timeout(1500)
    verifie(page.locator(".doc-table tr").count() == 4, "rechargement : le tableau revient")
    verifie(disque(page) == md2, "rechargement : rien de reecrit")
    capture(page, "saisie-recharge")
    verifie(not err, f"frappe : aucune erreur JS {err[:3]}")
    nav.close()


def scenario_code(pw) -> None:
    nav, page, err = ouvrir(pw, [page_json("D", "")])
    page.locator(".text-doc").first.click(position={"x": 200, "y": 60})
    tape(page, "Exemple en Python")
    page.keyboard.press("Enter")
    tape(page, "```python")
    page.keyboard.press("Enter")
    page.wait_for_timeout(200)
    verifie(page.locator(".doc-code").count() == 1, "``` puis Entree : bloc de code")
    dans = page.evaluate("() => document.activeElement?.classList.contains('doc-code-input')")
    verifie(dans, "le clavier est dans le bloc de code")
    tape(page, "def f(x):")
    page.keyboard.press("Enter")
    tape(page, "return x**2  # carre, pas de formule ici: tau")
    page.keyboard.press("Enter")
    page.keyboard.press("Shift+Tab")
    tape(page, "print(f(3))")
    page.keyboard.press("Escape")
    tape(page, "Le resultat vaut 9.")
    page.wait_for_timeout(1500)
    capture(page, "saisie-code")
    md = disque(page)
    print("      disque :", md.replace("\n", " ⏎ "))
    attendu = "Exemple en Python\n```python\ndef f(x):\n    return x**2  # carre, pas de formule ici: tau\nprint(f(3))\n```\nLe resultat vaut 9."
    verifie(md == attendu, "bloc de code enregistre tel quel (retrait auto, Maj+Tab, rien converti)")
    verifie(page.locator(".doc-code .hl-kw").count() >= 2, "mots-cles colores")
    # Retour arriere en debut de ligne suivante : entre dans le bloc, ne l'efface pas.
    page.keyboard.press("Home")
    page.keyboard.press("Backspace")
    dans = page.evaluate("() => document.activeElement?.classList.contains('doc-code-input')")
    verifie(dans and page.locator(".doc-code").count() == 1, "Retour arriere apres le bloc : entre dedans")
    page.reload(wait_until="networkidle")
    page.wait_for_timeout(800)
    page.get_by_text("Maths", exact=True).first.click()
    page.wait_for_timeout(1500)
    verifie(disque(page) == attendu and page.locator(".doc-code").count() == 1, "rechargement : bloc identique")
    verifie(not err, f"code : aucune erreur JS {err[:3]}")
    nav.close()


def main() -> int:
    with sync_playwright() as pw:
        scenario_ancien_format(pw)
        scenario_frappe(pw)
        scenario_code(pw)
    print(f"\n{len(problemes)} probleme(s)")
    return 1 if problemes else 0


if __name__ == "__main__":
    sys.exit(main())
