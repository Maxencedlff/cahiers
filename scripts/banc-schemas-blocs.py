#!/usr/bin/env python3
"""
Banc des schemas-blocs (Playwright), sur des pages de test du mode
navigateur (localStorage, jamais les cahiers reels) :
  - systeme du 1er ordre fait A LA MAIN : clavier (fleches, Maj+G gain,
    s comparateur, Maj+B integrateur, valeurs tapees) + UN glisser de la
    sortie y(t) vers l'entree − du comparateur (retour trace seul,
    par-dessous) ; compte des gestes (< 30) ; plus aucune borne libre ;
  - bloc au texte long « τ dy/dt + y(t) = K e(t) » : le texte tient dans
    le rectangle (boites reelles du DOM) ;
  - un clic sur le signe − du comparateur le change en + ;
  - gain tourne (Ctrl+R deux fois) : pointe a gauche ;
  - modeles « Bloc de transfert », « Système du 1er ordre », « Système du
    2e ordre » : rendus dans la page, sans chevauchement ni « _ » visible ;
  - schemas faits a la main le 16/10 (copie en lecture des pages du cahier
    reel si elles sont la, CAHIERS_REEL) : toujours lus et dessines.
Captures dans CAHIERS_SHOTS : banc-blocs-*.png. Code de sortie 1 si une
verification echoue.

Cote Windows :
  npx vite build --outDir C:\\Users\\maxde\\AppData\\Local\\Temp\\cahiers-prev-schema
  npx vite preview --outDir C:\\Users\\maxde\\AppData\\Local\\Temp\\cahiers-prev-schema --port 1465 --host 0.0.0.0
puis depuis WSL :
  CAHIERS_URL=http://$(ip route show default | awk '{print $3}'):1465/ python3 scripts/banc-schemas-blocs.py
"""
import importlib.util
import json
import os
import sys

from playwright.sync_api import sync_playwright

ICI = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location("banc_schemas", os.path.join(ICI, "banc-schemas.py"))
bs = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(bs)

URL = os.environ.get("CAHIERS_URL", "http://127.0.0.1:1465/")
bs.URL = URL
SHOTS = os.environ.get("CAHIERS_SHOTS", ".")
REEL = os.environ.get("CAHIERS_REEL", "/mnt/c/Users/maxde/OneDrive/Desktop/ESEO/Automatique et génie électrique/Cours")
verifier = bs.verifier


def disque(page) -> dict:
    """Le schema tel qu'enregistre (attend l'ecriture, differee)."""
    for _ in range(30):
        b = bs.schemas_disque(page)
        if b and b[0]["parts"]:
            return b[0]
        page.wait_for_timeout(200)
    return {"parts": [], "wires": []}


def bornes_libres(page) -> int:
    return page.evaluate("document.querySelectorAll('.sch-editor .sch-free').length")


def premier_ordre_main(pw) -> None:
    print("\n[1er ordre] a la main : clavier + un glisser pour le retour")
    nav, page, err = bs.ouvrir(pw)
    g = bs.Gestes(page)
    bs.nouveau_schema(page, g)
    # e(t) -> K -> comparateur -> 1/τ -> ∫dt -> y(t) ; une fleche apres une valeur la valide et continue le fil.
    g.touche("ArrowRight"); g.touche("ArrowRight")
    g.touche("Shift+G"); g.taper("K")
    g.touche("ArrowRight"); g.touche("ArrowRight")
    g.touche("s")
    g.touche("ArrowRight"); g.touche("ArrowRight")
    g.touche("Shift+G"); g.taper("1/τ")
    g.touche("ArrowRight"); g.touche("ArrowRight")
    g.touche("Shift+B")
    for _ in range(4):
        g.touche("ArrowRight")
    page.wait_for_timeout(1500)
    b = disque(page)
    S = next(p for p in b["parts"] if p["sym"] == "S")
    I = next(p for p in b["parts"] if p.get("value") == "∫dt")
    out_x = I["x"] + I.get("w", 6)
    ligne = S["y"] + 1
    # Retour : de la ligne y(t) (3 cases apres l'integrateur) vers l'entree − du bas du comparateur (lachee a peu pres).
    g.glisser((out_x + 2, ligne), (S["x"] + 1.3, S["y"] + 2.4), par=(out_x + 2, ligne + 3))
    page.wait_for_timeout(1500)
    page.locator(".sch-editor .sch-frame").screenshot(path=os.path.join(SHOTS, "banc-blocs-1er-main-editeur.png"))
    verifier(bornes_libres(page) == 1, f"plus de borne libre sauf l'entree du haut du comparateur ({bornes_libres(page)})")
    b = disque(page)
    syms = [(p["sym"], p.get("value")) for p in b["parts"]]
    verifier(syms == [("Gain", "K"), ("S", None), ("Gain", "1/τ"), ("B", "∫dt")], f"pieces : {syms}")
    fb = b["wires"][-1]["pts"]
    verifier(max(fb[1::2]) >= ligne + 4 and fb[-2:] == [S["x"] + 1, S["y"] + 2], f"retour par-dessous jusqu'a l'entree − : {fb}")
    # Etiquettes des signaux : Alt+T au-dessus des fils.
    K = b["parts"][0]
    for (x, lab) in [(K["x"] - 1, "e(t)"), (I["x"] - 1, "dy/dt"), (out_x + 3, "y(t)")]:
        xx, yy = g.pt(x, ligne - 1.2)
        page.mouse.move(xx, yy)
        g.touche("Alt+t"); g.taper(lab); g.touche("Enter")
    page.locator(".sch-editor .sch-frame").screenshot(path=os.path.join(SHOTS, "banc-blocs-1er-main-etiquettes.png"))
    verifier(g.n < 30, f"1er ordre a la main en {g.n} gestes (< 30)")
    # Clic sur le signe − : il devient +, puis encore : −.
    bb = page.locator(".sch-editor .sch-label", has_text="−").first.bounding_box()
    page.mouse.click(bb["x"] + bb["width"] / 2, bb["y"] + bb["height"] / 2); page.wait_for_timeout(1500)
    b = disque(page)
    S = next(p for p in b["parts"] if p["sym"] == "S")
    verifier(S.get("value") == "++-", f"clic sur le signe − : valeur {S.get('value')}")
    page.keyboard.press("Control+z"); page.wait_for_timeout(200)
    bs.fermer(page)
    fig = page.locator(".live-schema").first
    fig.screenshot(path=os.path.join(SHOTS, "banc-blocs-1er-main.png"))
    verifier(not bs.chevauchements(page, fig), f"1er ordre a la main : aucune etiquette ne se chevauche {bs.chevauchements(page, fig)}")
    verifier(not bs.texte_brut(page, fig), f"aucun « _ » visible {bs.texte_brut(page, fig)}")
    verifier(not err, f"aucune erreur JS {err[:2]}")
    nav.close()


def bloc_long_et_gain(pw) -> None:
    print("\n[bloc au texte long, gain tourne]")
    nav, page, err = bs.ouvrir(pw)
    g = bs.Gestes(page)
    bs.nouveau_schema(page, g)
    for _ in range(4):
        g.touche("ArrowRight")
    g.touche("b"); g.taper("τ dy/dt + y(t) = K e(t)"); g.touche("Enter")
    for _ in range(4):
        g.touche("ArrowRight")
    # Gain pose puis tourne deux fois : pointe a gauche.
    g.touche("Shift+G"); g.taper("ω_0^2"); g.touche("Enter")
    g.touche("Control+r"); g.touche("Control+r")
    page.locator(".sch-editor .sch-frame").screenshot(path=os.path.join(SHOTS, "banc-blocs-long-editeur.png"))
    b = disque(page)
    B = next(p for p in b["parts"] if p["sym"] == "B")
    G = next(p for p in b["parts"] if p["sym"] == "Gain")
    verifier(B.get("w", 6) >= 11, f"bloc elargi a {B.get('w')} cases")
    verifier(G.get("rot") == 180, f"gain tourne d'un demi-tour (rot {G.get('rot')})")
    bs.fermer(page)
    fig = page.locator(".live-schema").first
    fig.screenshot(path=os.path.join(SHOTS, "banc-blocs-long.png"))
    # Le texte tient dans le rectangle du bloc (boites reelles).
    dedans = page.evaluate("""(fig) => {
      const rect = fig.querySelector('.sch-part rect').getBoundingClientRect();
      const lab = [...fig.querySelectorAll('.sch-label')].find((n) => n.textContent.includes('K'));
      const r = lab.querySelector('.katex, span, div').getBoundingClientRect();
      return [rect.left <= r.left + 1 && r.right <= rect.right + 1, Math.round(rect.width), Math.round(r.width)];
    }""", fig.element_handle())
    verifier(dedans[0], f"texte dans le bloc (bloc {dedans[1]} px, texte {dedans[2]} px)")
    verifier(not err, f"aucune erreur JS {err[:2]}")
    nav.close()


def modeles(pw) -> None:
    print("\n[modeles de schemas-blocs]")
    for nom, item in [("transfert", "Bloc de transfert"), ("ordre1", "Système du 1er ordre"), ("ordre2", "Système du 2e ordre")]:
        nav, page, err = bs.ouvrir(pw)
        g = bs.Gestes(page)
        bs.nouveau_schema(page, g)
        g.clic(".sch-models")
        g.clic(f".ctx-item:has-text('{item}')")
        page.locator(".sch-editor .sch-frame").screenshot(path=os.path.join(SHOTS, f"banc-blocs-{nom}-editeur.png"))
        bs.fermer(page)
        fig = page.locator(".live-schema").first
        fig.screenshot(path=os.path.join(SHOTS, f"banc-blocs-{nom}.png"))
        verifier(fig.locator(".sch-empty").count() == 0, f"{nom} : dessine")
        verifier(not bs.chevauchements(page, fig), f"{nom} : aucune etiquette ne se chevauche {bs.chevauchements(page, fig)}")
        verifier(not bs.texte_brut(page, fig), f"{nom} : aucun « _ » visible {bs.texte_brut(page, fig)}")
        verifier(not err, f"{nom} : aucune erreur JS {err[:2]}")
        nav.close()


def anciens(pw) -> None:
    print("\n[schemas faits a la main le 16/10 : relus]")
    pages = []
    for n in ("0001", "0002"):
        f = os.path.join(REEL, f"{n}.page.json")
        if os.path.exists(f):
            with open(f, encoding="utf-8") as fh:
                pages.append((n, fh.read()))
    if not pages:
        print("  (cahier reel absent : saute)")
        return
    nav = pw.chromium.launch(args=["--mute-audio"])
    ctx = nav.new_context(viewport={"width": 1500, "height": 940})
    page = ctx.new_page()
    err: list[str] = []
    page.on("pageerror", lambda e: err.append(str(e)))
    page.goto(URL, wait_until="networkidle")
    page.evaluate("localStorage.clear()")
    page.reload(wait_until="networkidle")
    page.wait_for_timeout(700)
    tree = json.loads(page.evaluate("localStorage.getItem('cahiers.fs.v1')"))
    for n, txt in pages:
        tree[f"Maths/Cours/{n}.page.json"] = txt
    page.evaluate("t => localStorage.setItem('cahiers.fs.v1', t)", json.dumps(tree))
    page.reload(wait_until="networkidle")
    page.wait_for_timeout(700)
    page.get_by_text("Maths", exact=True).first.click()
    page.wait_for_timeout(2500)
    figs = page.locator(".live-schema")
    k = figs.count()
    verifier(k >= 3, f"{k} schemas du 16/10 dessines")
    for i in range(min(k, 4)):
        figs.nth(i).scroll_into_view_if_needed()
        figs.nth(i).screenshot(path=os.path.join(SHOTS, f"banc-blocs-ancien-{i}.png"))
    verifier(not err, f"aucune erreur JS {err[:2]}")
    nav.close()


def main() -> None:
    filtre = sys.argv[1] if len(sys.argv) > 1 else ""
    with sync_playwright() as pw:
        for nom, f in [("main", premier_ordre_main), ("long", bloc_long_et_gain), ("modeles", modeles), ("anciens", anciens)]:
            if filtre in nom:
                f(pw)
    print("\n" + ("TOUT EST BON" if not bs.problemes else f"{len(bs.problemes)} probleme(s)"))
    sys.exit(1 if bs.problemes else 0)


if __name__ == "__main__":
    main()
