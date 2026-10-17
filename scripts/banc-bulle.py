#!/usr/bin/env python3
"""
Banc de la bulle d'aide aux raccourcis (core/text/hint.ts) et de la matrice
vide (`mat2x2`) dans la vraie interface (Playwright).

Chaque cas tape un texte touche par touche, attend (ou non), puis regarde si
la bulle `.text-ghost.text-hint` est la et ce qu'elle propose, appuie
eventuellement sur une touche, et relit la premiere ligne.

Prerequis : un serveur de l'appli (vite preview d'un build) et playwright.
Usage : CAHIERS_URL=http://hote:port/ python3 scripts/banc-bulle.py [dossier_captures]
"""
import os
import sys

from playwright.sync_api import sync_playwright

URL = os.environ.get("CAHIERS_URL", "http://127.0.0.1:1420/")
CAPT = sys.argv[1] if len(sys.argv) > 1 else ""

# frappe, attente (ms), bulle attendue (texte de l'apercu, None = pas de bulle),
# touche apres, texte attendu dans la ligne (ou None), formule attendue (sous-chaine du LaTeX)
CAS = [
    dict(nom="ome-tab", frappe="on note ome", bulle="ω", touche="Tab", ligne="on note ω"),
    dict(nom="ome-fleche", frappe="ome", bulle="ω", touche="ArrowRight", ligne="ω"),
    dict(nom="ome-autre", frappe="ome", bulle="ω", touche="t", ligne="omet"),
    dict(nom="ome-echap", frappe="ome", bulle="ω", touche="Escape", ligne="ome"),
    dict(nom="Delt", frappe="la variation Delt", bulle="Δ", touche="Tab", ligne="la variation Δ"),
    dict(nom="sumo", frappe="un sumo", bulle=None),
    dict(nom="limite", frappe="la limite", attente=900, bulle=None),
    dict(nom="integrer", frappe="integrer", attente=900, bulle=None),
    dict(nom="interieur", frappe="intérieur", attente=900, bulle=None),
    dict(nom="lim-vite", frappe="lim", attente=100, bulle=None),
    dict(nom="lim-pause", frappe="lim", attente=1000, bulle="lim", touche="Tab", ligne="lim_("),
    dict(nom="int-apres-egal", frappe="F = int", attente=100, bulle="∫"),
    dict(nom="tau-pause", frappe="on a tau", attente=1000, bulle="τ"),
    dict(nom="Vome", frappe="Vome", bulle=None),
    dict(nom="tab-sans-bulle", frappe="mot", touche="Tab", bulle=None, ligne="mot\t"),
    dict(nom="mat2x2-espace", frappe="A = mat2x2", bulle="", touche=" ", formule="pmatrix"),
    dict(nom="mat3-tab", frappe="mat3", bulle="", touche="Tab", formule="pmatrix"),
    dict(nom="mat2x2-remplie", frappe="mat2x2", bulle="", touche=" ", suite=["1", "Tab", "2", "Tab", "3", "Tab", "4", "Tab", " ", "f", "i", "n"],
         formule="pmatrix", ligne="¤ fin"),
]


def bulle(page):
    return page.evaluate(
        """() => { const g = document.querySelector('.text-ghost.text-hint');
        if (!g || !g.isConnected) return null;
        const r = g.getBoundingClientRect();
        return { txt: g.textContent, w: r.width, h: r.height }; }"""
    )


def ligne0(page):
    return page.evaluate(
        """() => { const root = document.querySelector('.text-doc');
        let s = '', eqs = [];
        const walk = (n) => { for (const c of n.childNodes) {
          if (c.nodeType === 3) s += c.data.replace(/\\u200b/g, '');
          else if (c.nodeType === 1 && c.classList.contains('eq')) { s += '¤'; eqs.push(c.dataset.latex || ''); }
          else if (c.nodeType === 1 && c.tagName === 'MATH-FIELD') { s += '¤'; eqs.push(c.getValue ? c.getValue('latex') : ''); }
          else if (c.nodeType === 1) walk(c); } };
        walk(root);
        return { s: s.split('\\n')[0], eqs, field: !!document.querySelector('.text-doc math-field') }; }"""
    )


def main() -> int:
    rates = 0
    with sync_playwright() as pw:
        nav = pw.chromium.launch(args=["--mute-audio"])
        page = nav.new_page(viewport={"width": 1400, "height": 900})
        erreurs = []
        page.on("pageerror", lambda e: erreurs.append(str(e)))
        page.goto(URL, wait_until="networkidle")
        page.evaluate("localStorage.clear()")
        page.reload(wait_until="networkidle")
        page.wait_for_timeout(1000)
        page.get_by_text("Maths", exact=True).first.click()
        page.wait_for_timeout(1000)
        for cas in CAS:
            page.keyboard.press("Escape")
            page.locator(".text-doc").first.click()
            page.keyboard.press("Control+a")
            page.keyboard.press("Delete")
            page.wait_for_timeout(150)
            page.keyboard.type(cas["frappe"], delay=70)
            page.wait_for_timeout(cas.get("attente", 250))
            b = bulle(page)
            pb = []
            if cas["bulle"] is None and b:
                pb.append(f"bulle inattendue {b['txt']!r}")
            if cas["bulle"] is not None and (not b or cas["bulle"] not in b["txt"]):
                pb.append(f"bulle attendue {cas['bulle']!r}, vu {b and b['txt']!r}")
            if CAPT and b:
                page.screenshot(path=os.path.join(CAPT, f"bulle-{cas['nom']}.png"), clip=dict(x=0, y=0, width=1400, height=500))
            if cas.get("touche"):
                page.keyboard.press(cas["touche"])
                page.wait_for_timeout(500)
                if bulle(page):
                    pb.append("bulle restee apres la touche")
            for k in cas.get("suite", []):
                page.keyboard.press(k)
                page.wait_for_timeout(120)
            if cas.get("suite"):
                page.wait_for_timeout(500)
            l = ligne0(page)
            if cas.get("ligne") is not None and l["s"] != cas["ligne"]:
                pb.append(f"ligne {l['s']!r} au lieu de {cas['ligne']!r}")
            if cas.get("formule") and not any(cas["formule"] in e for e in l["eqs"]):
                pb.append(f"formule {cas['formule']!r} absente ({l})")
            if CAPT and cas.get("formule"):
                page.screenshot(path=os.path.join(CAPT, f"bulle-{cas['nom']}-apres.png"), clip=dict(x=0, y=0, width=1400, height=500))
            if pb:
                rates += 1
            print(("OK   " if not pb else "RATE ") + f"{cas['nom']:<16} ligne={l['s']!r} eqs={l['eqs']}")
            for p in pb:
                print("         -> " + p)
        if erreurs:
            print("ERREURS JS :", erreurs[:5])
            rates += 1
        nav.close()
    print(f"\n{rates} cas rates")
    return 1 if rates else 0


if __name__ == "__main__":
    sys.exit(main())
