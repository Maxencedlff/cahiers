#!/usr/bin/env python3
"""
Banc de l'editeur de schemas (Playwright), sur des pages de test du mode
navigateur (localStorage, jamais les cahiers reels) :
  - le buck du cours refait A LA MAIN, a la souris : 4 fils glisses, 6
    symboles glisses depuis la palette sur les fils, fleches de tension et
    de courant posees d'un Alt+glisser avec leur etiquette tapee
    (U_K, U_D(t), V_s(t), i_L(t), i_D(t)) ; compte des gestes ; le schema
    obtenu doit etre exactement celui du modele « Hacheur série (buck) »
    (memes pieces, memes fils case par case, memes fleches) ;
  - le meme buck insere par Modèles (4 gestes) ;
  - phase « K ferme » : Alt+F sur K (fil), Alt+O sur D (circuit ouvert) ;
  - pont diviseur, RC avec fleches u/i, chronogramme (axes + creneau +
    textes) : rendus sans « _ » visible ni « Schéma vide » ;
  - aucune etiquette ne se chevauche dans le rendu de la page (boites
    reelles du DOM) ; Ctrl+Z / Ctrl+Y ; aucune erreur JS.
Captures dans CAHIERS_SHOTS (defaut : dossier courant) : banc-schemas-*.png.

Prerequis : l'appli servie SANS le serveur de dev. Cote Windows :
  npx vite build --outDir C:\\Users\\maxde\\AppData\\Local\\Temp\\cahiers-prev2
  npx vite preview --outDir C:\\Users\\maxde\\AppData\\Local\\Temp\\cahiers-prev2 --port 1461 --host 0.0.0.0
puis depuis WSL :
  CAHIERS_URL=http://$(ip route show default | awk '{print $3}'):1461/ python3 scripts/banc-schemas.py

Code de sortie 1 si une verification echoue.
"""
import json
import os
import sys

from playwright.sync_api import sync_playwright

URL = os.environ.get("CAHIERS_URL", "http://127.0.0.1:1461/")
SHOTS = os.environ.get("CAHIERS_SHOTS", ".")

problemes: list[str] = []


def verifier(cond: bool, msg: str) -> None:
    print(("  OK   " if cond else "  RATE ") + msg)
    if not cond:
        problemes.append(msg)


def page_json(pid: str, texte: str) -> str:
    return json.dumps({"version": 1, "id": pid, "created": "2026-10-15T10:00:00.000Z", "modified": "2026-10-15T10:00:00.000Z",
                       "blocks": [{"id": pid + "-t", "type": "text", "content": texte}]})


def ouvrir(pw):
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
    tree["Maths/Cours/0001.page.json"] = page_json("P1", "Schémas du cours")
    page.evaluate("t => localStorage.setItem('cahiers.fs.v1', t)", json.dumps(tree))
    page.reload(wait_until="networkidle")
    page.wait_for_timeout(700)
    page.get_by_text("Maths", exact=True).first.click()
    page.wait_for_timeout(1500)
    return nav, page, erreurs


def schemas_disque(page) -> list[dict]:
    tree = json.loads(page.evaluate("localStorage.getItem('cahiers.fs.v1')"))
    p = json.loads(tree["Maths/Cours/0001.page.json"])
    return [b for b in p["blocks"] if b["type"] == "schema"]


class Gestes:
    """Actions de l'utilisateur, comptees (un geste = un appui, un glisser, une frappe de mot)."""

    def __init__(self, page):
        self.page = page
        self.n = 0

    def pt(self, gx: float, gy: float) -> tuple[float, float]:
        """Point ecran d'un point de la grille de l'editeur (defile si besoin, sans compter)."""
        return tuple(self.page.evaluate("""([gx, gy]) => {
          const st = document.querySelector('.sch-editor .sch-stage'), svg = st.querySelector('.sch-svg');
          const vb = svg.viewBox.baseVal, u = svg.getBoundingClientRect().width / vb.width;
          const px = (gx - vb.x) * u, py = (gy - vb.y) * u;
          if (px < st.scrollLeft + 30 || px > st.scrollLeft + st.clientWidth - 30) st.scrollLeft = px - st.clientWidth / 2;
          if (py < st.scrollTop + 30 || py > st.scrollTop + st.clientHeight - 30) st.scrollTop = py - st.clientHeight / 2;
          const r = svg.getBoundingClientRect();
          return [r.left + px, r.top + py];
        }""", [gx, gy]))

    def touche(self, k: str) -> None:
        self.page.keyboard.press(k)
        self.n += 1
        self.page.wait_for_timeout(60)

    def taper(self, s: str) -> None:
        self.page.keyboard.type(s)
        self.n += 1
        self.page.wait_for_timeout(60)

    def clic(self, sel: str) -> None:
        self.page.locator(sel).first.click()
        self.n += 1
        self.page.wait_for_timeout(150)

    def glisser(self, a, b, alt: bool = False, par=None) -> None:
        """Glisser de a a b ; `par` : coin par ou passe la main (le premier mouvement choisit le sens du fil)."""
        x0, y0 = self.pt(*a)
        xc, yc = self.pt(*par) if par else (None, None)
        x1, y1 = self.pt(*b)
        if alt:
            self.page.keyboard.down("Alt")
        self.page.mouse.move(x0, y0)
        self.page.mouse.down()
        if par:
            self.page.mouse.move(xc, yc, steps=5)
        else:
            self.page.mouse.move((x0 + x1) / 2, (y0 + y1) / 2, steps=4)
        self.page.mouse.move(x1, y1, steps=4)
        self.page.mouse.up()
        if alt:
            self.page.keyboard.up("Alt")
        self.n += 1
        self.page.wait_for_timeout(120)

    def deposer(self, bouton: str, b) -> None:
        """Glisser un symbole de la palette jusqu'au point b de la grille."""
        btn = self.page.locator(".sch-pal-btn", has_text=bouton).first.bounding_box()
        x1, y1 = self.pt(*b)
        self.page.mouse.move(btn["x"] + btn["width"] / 2, btn["y"] + btn["height"] / 2)
        self.page.mouse.down()
        self.page.mouse.move(x1, y1 - 40, steps=6)
        self.page.mouse.move(x1, y1, steps=3)
        self.page.mouse.up()
        self.n += 1
        self.page.wait_for_timeout(150)


def nouveau_schema(page, g: Gestes) -> None:
    # Clic sur la ligne de titre (pas au milieu de la feuille : on tomberait sur un schema).
    page.locator(".text-doc").first.get_by_text("Schémas du cours").click()
    page.keyboard.press("Control+End")
    page.keyboard.press("Enter")
    g.touche("Control+Shift+H")
    page.wait_for_timeout(700)


def signature(b: dict) -> dict:
    """Ce qui se voit : pieces, fils case par case, fleches (sans les ids ni le decoupage des fils)."""
    edges = set()
    for w in b["wires"]:
        p = w["pts"]
        for i in range(0, len(p) - 2, 2):
            x0, y0, x1, y1 = p[i], p[i + 1], p[i + 2], p[i + 3]
            if y0 == y1:
                for x in range(min(x0, x1), max(x0, x1)):
                    edges.add(("h", x, y0))
            else:
                for y in range(min(y0, y1), max(y0, y1)):
                    edges.add(("v", x0, y))
    names = {p["id"]: p.get("name") for p in b["parts"]}
    parts = sorted((p["sym"], p["x"], p["y"], p.get("rot", 0), p.get("name", "")) for p in b["parts"])
    notes = sorted(json.dumps({k: (names.get(v) if k == "part" else v) for k, v in n.items()}, sort_keys=True) for n in b.get("notes", []))
    return {"parts": parts, "edges": sorted(edges), "notes": notes}


def chevauchements(page, fig) -> list[str]:
    """Etiquettes du bloc dans la page qui se recouvrent (boites reelles)."""
    return page.evaluate("""(fig) => {
      const ls = [...fig.querySelectorAll('.sch-label')].map((n) => ({ t: n.textContent, r: n.getBoundingClientRect() }));
      const out = [];
      for (let i = 0; i < ls.length; i++) for (let j = i + 1; j < ls.length; j++) {
        const a = ls[i].r, b = ls[j].r;
        if (a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1) out.push(ls[i].t + ' / ' + ls[j].t);
      }
      return out;
    }""", fig.element_handle())


def texte_brut(page, fig) -> list[str]:
    """Etiquettes affichees avec un « _ » visible (pas mises en forme)."""
    return page.evaluate("""(fig) => [...fig.querySelectorAll('.sch-label')].map((n) => {
      const c = n.cloneNode(true); c.querySelectorAll('.katex-mathml').forEach((m) => m.remove()); return c.textContent;
    }).filter((t) => t.includes('_'))""", fig.element_handle())


def fermer(page) -> None:
    page.locator(".sch-close").click()
    page.wait_for_timeout(1500)


def buck_a_la_main(pw) -> dict:
    print("\n[buck] a la main, a la souris")
    nav, page, err = ouvrir(pw)
    g = Gestes(page)
    nouveau_schema(page, g)
    # Les fils d'abord (le premier mouvement choisit vertical / horizontal).
    g.glisser((2, 12), (34, 6), par=(2, 6))        # monte a gauche puis va a droite
    g.glisser((34, 6), (2, 12), par=(34, 12))      # descend a droite puis revient : boucle fermee
    g.glisser((12, 12), (12, 6))                   # branche de la diode, vers le haut
    g.glisser((24, 6), (24, 12))                   # branche du condensateur
    # Les symboles glisses sur les fils : ils s'y inserent, dans le sens du fil.
    g.deposer("Source de tension", (2, 9))
    g.deposer("Interrupteur", (7, 6))
    g.deposer("Diode", (12, 9))
    g.deposer("Bobine", (17, 6))
    g.deposer("Condensateur", (24, 9))
    g.deposer("Résistance", (34, 9))
    # Fleches : Alt+glisser le long de la piece ou du fil, puis l'etiquette.
    g.glisser((8.5, 6), (5.5, 6), alt=True); g.taper("U_K"); g.touche("Enter")
    g.glisser((7, 7.6), (7, 4.4))                  # la fleche U_K passe au-dessus (cote du nom)
    g.glisser((12, 10.5), (12, 7.5), alt=True); g.taper("U_D(t)"); g.touche("Enter")
    g.glisser((34, 10.5), (34, 7.5), alt=True); g.taper("V_s(t)"); g.touche("Enter")
    g.glisser((14, 6), (15, 6), alt=True); g.taper("i_L(t)"); g.touche("Enter")
    g.glisser((12, 11.7), (12, 11.1), alt=True); g.taper("i_D(t)"); g.touche("Enter")
    page.locator(".sch-editor .sch-frame").screenshot(path=os.path.join(SHOTS, "banc-schemas-main-editeur.png"))
    g.clic(".sch-close")
    page.wait_for_timeout(1500)
    print(f"  gestes : {g.n}")
    verifier(g.n <= 30, f"buck a la main en {g.n} gestes (<= 30 ; avant : ~115 et etiquettes impossibles)")
    fig = page.locator(".live-schema").first
    fig.screenshot(path=os.path.join(SHOTS, "banc-schemas-main.png"))
    verifier(not chevauchements(page, fig), f"aucune etiquette ne se chevauche {chevauchements(page, fig)}")
    verifier(not texte_brut(page, fig), f"aucun « _ » visible {texte_brut(page, fig)}")
    b = schemas_disque(page)[0]
    verifier(not err, f"aucune erreur JS {err[:2]}")
    nav.close()
    return b


def note(page, label: str) -> dict | None:
    page.wait_for_timeout(1500)   # enregistrement differe de la page
    return next((n for n in schemas_disque(page)[0].get("notes", []) if n["label"] == label), None)


def gestes_souris(page) -> None:
    """Sur le buck pose : modifier une etiquette, glisser un courant, deplacer un groupe, annuler."""
    print("\n[buck] gestes a la souris sur le schema pose")
    page.locator(".live-schema").first.click()
    page.wait_for_timeout(700)
    g = Gestes(page)
    # Double-clic sur l'etiquette U_K : le champ s'ouvre avec U_K, on tape u_K.
    lab = page.locator(".sch-editor .sch-label", has_text="UK").first.bounding_box()
    page.mouse.dblclick(lab["x"] + lab["width"] / 2, lab["y"] + lab["height"] / 2)
    page.wait_for_timeout(200)
    champ = page.locator(".sch-editor .sch-value")
    verifier(champ.count() == 1 and champ.input_value() == "U_K", "double-clic sur U_K : champ prerempli")
    page.keyboard.type("u_K"); page.keyboard.press("Enter"); page.wait_for_timeout(300)
    verifier(note(page, "u_K") is not None, "etiquette U_K changee en u_K")
    # Glisser la fleche i_L(t) plus loin sur le fil : elle reste sur le fil.
    g.glisser((14, 6), (21.2, 6.4))
    n = note(page, "i_L(t)")
    verifier(n is not None and (n["x"], n["y"], n["dir"]) == (21, 6, "right"), f"i_L(t) glissee le long du fil ({n and (n['x'], n['y'])})")
    # Ctrl+glisser autour de C et R, puis les descendre de 2 cases : fils a angles droits, rien ne se detache.
    x0, y0 = g.pt(22, 5); x1, y1 = g.pt(36, 13.5)
    page.keyboard.down("Control"); page.mouse.move(x0, y0); page.mouse.down(); page.mouse.move(x1, y1, steps=8); page.mouse.up(); page.keyboard.up("Control")
    page.wait_for_timeout(200)
    g.glisser((24, 9), (24, 11))
    page.wait_for_timeout(1500)
    b = schemas_disque(page)[0]
    ys = sorted(p["y"] for p in b["parts"] if p.get("name") in ("C", "R"))
    droits = all(w["pts"][i] == w["pts"][i + 2] or w["pts"][i + 1] == w["pts"][i + 3] for w in b["wires"] for i in range(0, len(w["pts"]) - 2, 2))
    verifier(ys == [9, 9] and droits, f"C et R descendus ensemble, fils a angles droits (y = {ys})")
    # Ctrl+Z x3 : tout revient comme le modele.
    for _ in range(3):
        page.keyboard.press("Control+z"); page.wait_for_timeout(120)
    page.wait_for_timeout(2000)
    b = schemas_disque(page)[0]
    verifier(note(page, "U_K") is not None and sorted(p["y"] for p in b["parts"] if p.get("name") in ("C", "R")) == [7, 7],
             "Ctrl+Z x3 : etiquette, fleche et groupe reviennent")
    page.screenshot(path=os.path.join(SHOTS, "banc-schemas-gestes.png"))
    fermer(page)


def buck_modele(pw) -> dict:
    print("\n[buck] par Modèles")
    nav, page, err = ouvrir(pw)
    g = Gestes(page)
    nouveau_schema(page, g)
    g.clic(".sch-models")
    g.clic(".ctx-item:has-text('Hacheur série')")
    page.locator(".sch-editor .sch-frame").screenshot(path=os.path.join(SHOTS, "banc-schemas-modele-editeur.png"))
    # Ctrl+Z / Ctrl+Y : le modele part puis revient.
    page.keyboard.press("Control+z"); page.wait_for_timeout(200)
    vide = page.evaluate("document.querySelectorAll('.sch-editor .sch-part').length")
    page.keyboard.press("Control+y"); page.wait_for_timeout(200)
    plein = page.evaluate("document.querySelectorAll('.sch-editor .sch-part').length")
    verifier(vide == 0 and plein == 6, f"Ctrl+Z retire le modele, Ctrl+Y le remet ({vide} puis {plein} pieces)")
    g.clic(".sch-close")
    page.wait_for_timeout(1500)
    verifier(g.n <= 4, f"buck par Modèles en {g.n} gestes")
    gestes_souris(page)
    fig = page.locator(".live-schema").first
    fig.screenshot(path=os.path.join(SHOTS, "banc-schemas-modele.png"))
    verifier(not chevauchements(page, fig), f"modele : aucune etiquette ne se chevauche {chevauchements(page, fig)}")
    b = schemas_disque(page)[0]
    # Phase K fermee : interrupteur -> fil, diode -> circuit ouvert, sans rien redessiner.
    print("\n[buck] phase « K fermé » : Alt+F sur K, Alt+O sur D")
    fig.click()
    page.wait_for_timeout(700)
    gk = Gestes(page)
    x, y = gk.pt(7, 6); page.mouse.move(x, y); gk.touche("Alt+f")
    x, y = gk.pt(12, 9); page.mouse.move(x, y); gk.touche("Alt+o")
    fermer(page)
    ph = schemas_disque(page)[0]
    syms = sorted(p["sym"] for p in ph["parts"])
    verifier(syms == sorted(["V", "X", "L", "C", "R"]), f"K remplace par un fil, D par un circuit ouvert ({syms})")
    verifier(any(n["label"] == "U_D(t)" for n in ph.get("notes", [])), "la tension U_D(t) reste sur le circuit ouvert")
    page.locator(".live-schema").first.screenshot(path=os.path.join(SHOTS, "banc-schemas-k-ferme.png"))
    verifier(not err, f"aucune erreur JS {err[:2]}")
    nav.close()
    return b


def autres(pw) -> None:
    print("\n[pont diviseur, RC, chronogrammes]")
    for nom, item in [("diviseur", "Pont diviseur"), ("rc", "Circuit RC"), ("creneau", "Créneau"), ("triangle", "Triangle")]:
        nav, page, err = ouvrir(pw)
        g = Gestes(page)
        nouveau_schema(page, g)
        g.clic(".sch-models")
        g.clic(f".ctx-item:has-text('{item}')")
        if nom == "triangle":
            # Texte libre en phrase, place a la main : mis en forme, pas de _.
            x, y = g.pt(13, 2)
            page.mouse.move(x, y)
            g.touche("Alt+t"); g.taper("Δi_L = i_L max − i_L min"); g.touche("Enter")
        g.clic(".sch-close")
        page.wait_for_timeout(1500)
        fig = page.locator(".live-schema").first
        fig.screenshot(path=os.path.join(SHOTS, f"banc-schemas-{nom}.png"))
        verifier(len(schemas_disque(page)) == 1, f"{nom} : le schema est dans la page")
        verifier(fig.locator(".sch-empty").count() == 0, f"{nom} : dessine (pas « Schéma vide »)")
        verifier(not chevauchements(page, fig), f"{nom} : aucune etiquette ne se chevauche {chevauchements(page, fig)}")
        verifier(not texte_brut(page, fig), f"{nom} : aucun « _ » visible {texte_brut(page, fig)}")
        verifier(not err, f"{nom} : aucune erreur JS {err[:2]}")
        nav.close()


def main() -> None:
    filtre = sys.argv[1] if len(sys.argv) > 1 else ""
    with sync_playwright() as pw:
        main_b = buck_a_la_main(pw) if filtre in ("", "main") else None
        modele = buck_modele(pw) if filtre in ("", "main", "modele") else None
        if main_b and modele:
            sa, sb = signature(main_b), signature(modele)
            for k in ("parts", "edges", "notes"):
                if sa[k] != sb[k]:
                    print("   a la main :", [x for x in sa[k] if x not in sb[k]][:6])
                    print("   modele    :", [x for x in sb[k] if x not in sa[k]][:6])
                verifier(sa[k] == sb[k], f"buck a la main = buck du modele ({k})")
        if filtre in ("", "autres"):
            autres(pw)
    print(f"\n{len(problemes)} probleme(s)")
    sys.exit(1 if problemes else 0)


if __name__ == "__main__":
    main()
