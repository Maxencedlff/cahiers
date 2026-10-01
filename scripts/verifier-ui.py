#!/usr/bin/env python3
"""
Verification visuelle de l'interface.

Les tests unitaires couvrent le noyau ; ce script couvre ce qu'ils ne peuvent
pas voir : que les traits s'affichent, que les blocs ne se recouvrent pas, que
la calculatrice calcule juste et que rien ne casse au split.

Prerequis : `npm run dev` dans un autre terminal, et playwright installe
(`pip install playwright && playwright install chromium`).

Usage : python3 scripts/verifier-ui.py [dossier-de-sortie]
"""
import math
import os
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

# CAHIERS_URL sert quand le serveur tourne cote Windows et le script cote WSL.
URL = os.environ.get("CAHIERS_URL", "http://127.0.0.1:1420/")
OUT = Path(sys.argv[1] if len(sys.argv) > 1 else "captures")
OUT.mkdir(parents=True, exist_ok=True)

problemes: list[str] = []


def verifier(condition: bool, message: str) -> None:
    print(("  OK   " if condition else "  RATE ") + message)
    if not condition:
        problemes.append(message)


def trait_stylet(page, points) -> None:
    """Trace au stylet (pointerType pen) : a la souris, l'outil Stylo tape du texte."""
    cdp = page.context.new_cdp_session(page)
    def envoyer(kind, x, y, boutons):
        cdp.send("Input.dispatchMouseEvent", {
            "type": kind, "x": x, "y": y, "button": "left", "buttons": boutons,
            "clickCount": 1, "pointerType": "pen", "force": 0.5,
        })
    envoyer("mousePressed", *points[0], 1)
    for x, y in points[1:]:
        envoyer("mouseMoved", x, y, 1)
    envoyer("mouseReleased", *points[-1], 0)
    cdp.detach()


def main() -> int:
    with sync_playwright() as pw:
        navigateur = pw.chromium.launch()
        page = navigateur.new_page(viewport={"width": 1500, "height": 940})
        erreurs: list[str] = []
        page.on("pageerror", lambda e: erreurs.append(str(e)))
        page.on("console", lambda m: erreurs.append(m.text) if m.type == "error" else None)

        page.goto(URL, wait_until="networkidle")
        page.evaluate("localStorage.clear()")
        page.reload(wait_until="networkidle")
        page.wait_for_timeout(1200)
        page.screenshot(path=OUT / "01-menu.png")
        verifier("Matières" in page.inner_text("#app"), "le menu liste les matieres")

        page.get_by_text("Maths", exact=True).first.click()
        page.wait_for_timeout(900)

        feuille = page.locator(".sheet").first.bounding_box()
        ox, oy = feuille["x"] + 80, feuille["y"] + 90
        trait_stylet(page, [(ox + i * 4, oy + 28 * math.sin(i / 5)) for i in range(50)])
        page.wait_for_timeout(400)
        page.screenshot(path=OUT / "02-encre.png")

        # Une zone entouree devient un bloc math, l'encre reste dessous.
        page.get_by_role("button", name="Zone math").click()
        page.mouse.move(feuille["x"] + 50, feuille["y"] + 45)
        page.mouse.down()
        page.mouse.move(feuille["x"] + 330, feuille["y"] + 170, steps=6)
        page.mouse.up()
        page.wait_for_timeout(700)
        verifier(page.locator(".block-box.math").count() == 1, "la zone entouree cree un bloc math")
        verifier(
            any(t in page.inner_text(".block-box.math")
                for t in ("conversion en attente", "clés MyScript manquantes")),
            "le bloc math attend la conversion sans bloquer l'ecriture",
        )
        page.screenshot(path=OUT / "03-zone-math.png")

        # Les blocs s'empilent au lieu de se recouvrir.
        # Frappe au clavier : le texte va dans la page sans cliquer.
        page.keyboard.type("Critere de Riemann")
        page.wait_for_timeout(1500)
        boites = page.locator(".block-box").all()
        rects = [b.bounding_box() for b in boites]
        chevauche = any(
            a and b and a is not b
            and a["y"] < b["y"] + b["height"] and b["y"] < a["y"] + a["height"]
            and a["x"] < b["x"] + b["width"] and b["x"] < a["x"] + a["width"]
            for i, a in enumerate(rects) for b in rects[i + 1:]
        )
        verifier(not chevauche, "les blocs ne se recouvrent pas")
        page.screenshot(path=OUT / "04-blocs.png")

        # Outils du cours visibles sans faire defiler la colonne, meme sur
        # un ecran de 1280x720.
        page.set_viewport_size({"width": 1280, "height": 720})
        page.wait_for_timeout(400)
        for nom in ["Pas compris", "Page suivante", "Plus d'actions"]:
            boite = page.get_by_role("button", name=nom).first.bounding_box()
            verifier(boite is not None and boite["y"] + boite["height"] <= 720 - 36,
                     f"« {nom} » visible a 1280x720")
        page.set_viewport_size({"width": 1500, "height": 940})
        page.wait_for_timeout(400)

        # Ctrl+F pendant la frappe pose un repere, sans quitter le texte.
        avant = page.locator(".flag-pin").count()
        page.keyboard.press("Control+f")
        page.wait_for_timeout(400)
        verifier(page.locator(".flag-pin").count() == avant + 1, "Ctrl+F pose un repere pendant la frappe")
        page.locator(".toast-action", has_text="Annuler").first.click()
        page.wait_for_timeout(300)
        verifier(page.locator(".flag-pin").count() == avant, "« Annuler » retire le repere")

        # Calculatrice (fermee par defaut, Ctrl+L).
        page.keyboard.press("Control+l")
        page.wait_for_timeout(1500)
        for touche in ["2", "+", "3", "×", "4", "="]:
            page.locator(f".keys button:text-is('{touche}')").first.click()
        page.wait_for_timeout(400)
        verifier("14" in page.inner_text(".calc-screen"), "2 + 3 x 4 donne 14")
        page.screenshot(path=OUT / "05-calculatrice.png")

        page.locator(".keys button:text-is('2nd')").first.click()
        page.wait_for_timeout(300)
        verifier(
            page.locator(".keys button:text-is('sin⁻¹')").count() == 1,
            "la touche 2nd change l'affichage des touches",
        )
        page.locator(".keys button:text-is('2nd')").first.click()

        page.locator(".calc-tabs button:text-is('Courbes')").click()
        page.locator(".calc-body input[type=text]").first.fill("sin(x) * x / 2")
        page.wait_for_timeout(900)
        info = page.inner_text(".calc-body")
        verifier("Racines" in info, "les racines de la courbe sont annoncees")
        page.screenshot(path=OUT / "06-courbes.png")

        page.locator(".calc-tabs button:text-is('Résoudre')").click()
        page.wait_for_timeout(200)
        page.locator(".calc-body input[type=text]").first.fill("x^2 - 3x + 2 = 0")
        page.keyboard.press("Enter")
        page.wait_for_timeout(400)
        texte = page.inner_text(".calc-body")
        compact = "".join(c for c in texte if not c.isspace() and c != "\u200b")
        verifier("Δ > 0" in texte, "le discriminant et la nature sont affiches")
        verifier("x1=1" in compact and "x2=2" in compact, "x2 - 3x + 2 a pour racines 1 et 2")
        page.screenshot(path=OUT / "07-resoudre.png")

        page.locator(".calc-tabs button:text-is('Littéral')").click()
        page.wait_for_timeout(200)
        page.locator(".calc-body input[type=text]").first.fill("x * sin(x)")
        page.get_by_role("button", name="Dériver").click()
        page.wait_for_timeout(500)
        page.get_by_role("button", name="Afficher les détails").click()
        page.wait_for_timeout(500)
        etapes = page.inner_text(".steps")
        verifier("produit" in etapes.lower(), "la regle du produit est nommee")
        page.screenshot(path=OUT / "08-derivee.png")
        page.locator(".calc-head button").click()

        # Recherche.
        page.get_by_role("button", name="Rechercher").first.click()
        page.wait_for_timeout(400)
        page.locator("input[type=text]").first.fill("Riemann")
        page.wait_for_timeout(1200)
        verifier("résultat" in page.inner_text(".screen-inner"), "la recherche trouve le texte saisi")
        page.screenshot(path=OUT / "09-recherche.png")

        # « Retour » depuis la recherche revient a l'ecran d'origine (le
        # cahier), puis le menu ouvre une autre matiere.
        page.get_by_role("button", name="Retour").click()
        page.wait_for_timeout(700)
        verifier(page.locator(".side-tools").count() > 0, "« Retour » depuis la recherche revient au cahier")

        # Split, puis retour sur l'onglet mis en panneau droit.
        page.get_by_role("button", name="Menu").click()
        page.wait_for_timeout(700)
        page.get_by_text("Elec", exact=True).first.click()
        page.wait_for_timeout(800)
        page.get_by_role("button", name="Split").click()
        page.wait_for_timeout(800)
        verifier(page.locator(".pane").count() == 2, "le split ouvre deux panneaux")
        page.screenshot(path=OUT / "10-split.png")
        page.get_by_role("button", name="Menu").click()
        page.wait_for_timeout(800)
        page.get_by_text("Maths", exact=True).first.click()
        page.wait_for_timeout(900)
        verifier(
            page.locator(".side-tools .flag-btn").count() > 0,
            "revenir sur l'onglet du panneau droit ne casse pas la vue",
        )

        # Sonde stylet (menu « ⋯ » du cahier).
        page.get_by_role("button", name="Plus d'actions").first.click()
        page.wait_for_timeout(400)
        page.get_by_role("menuitem", name="Sonde stylet (diagnostic)").click()
        page.wait_for_timeout(400)
        zone = page.locator(".probe-canvas").bounding_box()
        page.mouse.move(zone["x"] + 120, zone["y"] + 120)
        page.mouse.down()
        for i in range(40):
            page.mouse.move(zone["x"] + 120 + i * 7, zone["y"] + 120 + 40 * math.sin(i / 4))
        page.mouse.up()
        page.wait_for_timeout(400)
        lecture = page.inner_text(".probe-readout")
        verifier("mouse" in lecture, "la sonde rapporte le type de pointeur")
        verifier("points du trait 0" not in lecture, "la sonde garde le compte du dernier trait")
        page.screenshot(path=OUT / "11-sonde.png")

        navigateur.close()

    verifier(not erreurs, f"aucune erreur console ({len(erreurs)} vue(s))")
    for e in dict.fromkeys(erreurs):
        print("     ", e[:200])

    print()
    if problemes:
        print(f"{len(problemes)} verification(s) en echec.")
        return 1
    print(f"Tout est bon. Captures dans {OUT}/")
    return 0


if __name__ == "__main__":
    sys.exit(main())
