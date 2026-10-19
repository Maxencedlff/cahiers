#!/usr/bin/env python3
"""
Banc du ruban des formules (Σ) et de la calculatrice : rien ne defile, rien
ne se recouvre, a 1536 x 780 (1920 x 1080 a 125 %, fenetre maximisee),
1280 x 720 et 1920 x 1040, theme clair et sombre, calculatrice fermee,
ancree ou detachee. Puis le parcours : taper, Ctrl+Maj+M, Grec, ω,
recherche « fl », Entree, frappe reprise ; onglet et ouverture retenus ;
Récents par defaut.

Mode navigateur (localStorage, jamais les cahiers reels).
Prerequis : vite preview d'un build, playwright (chromium).
Usage : CAHIERS_URL=http://hote:port/ CAPTURES=dossier python3 scripts/banc-ruban.py [1536|1280|1920 ...]
Depuis WSL vers un serveur Windows (adresse non locale) : le drapeau
--unsafely-treat-insecure-origin-as-secure ci-dessous donne crypto.subtle.
"""
import json, sys
from playwright.sync_api import sync_playwright
import os
URL = os.environ.get("CAHIERS_URL", "http://127.0.0.1:1420/")
OUT = os.environ.get("CAPTURES", "captures-ruban") + "/"
os.makedirs(OUT, exist_ok=True)
SIZES = [(1536, 780), (1280, 720), (1920, 1040)]
only = sys.argv[1:]  # filtre optionnel "1536"
problemes = []

def verifie(ok, msg):
    print(("OK   " if ok else "RATE ") + msg)
    if not ok: problemes.append(msg)

MESURE = """() => {
  const r = (q) => { const e = document.querySelector(q); return e ? e.getBoundingClientRect() : null; };
  const over = (q) => { const e = document.querySelector(q); return e ? {sh: e.scrollHeight, ch: e.clientHeight, sw: e.scrollWidth, cw: e.clientWidth} : null; };
  const keys = [...document.querySelectorAll('.fr-keys > *')].map(k => k.getBoundingClientRect());
  const ck = [...document.querySelectorAll('.calc .keys button')].map(k => k.getBoundingClientRect());
  const send = [...document.querySelectorAll('.calc .calc-send')].map(b => b.getBoundingClientRect())[0] || null;
  const calc = document.querySelector('.calc');
  return {
    ribbon: r('.formula-ribbon'), rib: over('.formula-ribbon'), frkeys: over('.fr-keys'), frtabs: over('.fr-tabs'), keysBox: r('.fr-keys'),
    keyMinW: keys.length ? Math.min(...keys.map(k => k.width)) : 0, keysBottom: keys.length ? Math.max(...keys.map(k => k.bottom)) : 0,
    tabsRight: Math.max(0, ...[...document.querySelectorAll('.fr-tab')].map(t => t.getBoundingClientRect().right)), find: r('.fr-find'),
    panes: r('.panes'), stage: r('.stage'), insp: document.querySelector('.inspector:not(.closed)') ? r('.inspector') : null,
    calc: calc && calc.getClientRects().length && getComputedStyle(calc).display !== 'none' ? calc.getBoundingClientRect() : null, docked: calc ? calc.classList.contains('docked') : null,
    body: over('.calc-body'), calcKeyMinH: ck.length ? Math.min(...ck.map(k => k.height)) : 0, ckBottom: ck.length ? Math.max(...ck.map(k => k.bottom)) : 0,
    send, vh: innerHeight, vw: innerWidth, nKeys: keys.length, ctabs: over('.calc-tabs'), ctabsBox: r('.calc-tabs'),
  };
}"""

def ouvrir(pw, nav, w, h, settings):
    ctx = nav.new_context(viewport={"width": w, "height": h})
    page = ctx.new_page()
    errs = []
    page.on("pageerror", lambda e: errs.append(str(e)))
    page.on("console", lambda m: errs.append(m.text) if m.type == "error" else None)
    page.goto(URL, wait_until="networkidle"); page.evaluate("localStorage.clear()"); page.reload(wait_until="networkidle")
    page.wait_for_timeout(600)
    page.evaluate("s => localStorage.setItem('cahiers.settings.v1', s)", json.dumps({"layout": 3, **settings}))
    page.reload(wait_until="networkidle"); page.wait_for_timeout(600)
    page.get_by_text("Maths", exact=True).first.click(); page.wait_for_timeout(1500)
    return ctx, page, errs

def controle(page, tag, m):
    rib = m["ribbon"]
    if rib:
        verifie(m["rib"]["sh"] <= m["rib"]["ch"] and m["frkeys"]["sh"] <= m["frkeys"]["ch"] and m["frkeys"]["sw"] <= m["frkeys"]["cw"] and m["frtabs"]["sw"] <= m["frtabs"]["cw"],
                f"{tag} ruban sans defilement (ruban {m['rib']['sh']}/{m['rib']['ch']}, touches {m['frkeys']['sh']}/{m['frkeys']['ch']} {m['frkeys']['sw']}/{m['frkeys']['cw']}, onglets {m['frtabs']['sw']}/{m['frtabs']['cw']})")
        verifie(80 <= rib["height"] <= 110, f"{tag} hauteur du ruban {rib['height']:.0f} px")
        verifie(m["keysBottom"] <= m["keysBox"]["bottom"] + 0.5, f"{tag} toutes les touches visibles ({m['nKeys']}, bas {m['keysBottom']:.0f} <= {m['keysBox']['bottom']:.0f})")
        verifie(m["keyMinW"] >= 33.5, f"{tag} touches >= 34 px de large ({m['keyMinW']:.1f})")
        verifie(m["tabsRight"] <= m["find"]["left"], f"{tag} onglets avant la recherche ({m['tabsRight']:.0f} <= {m['find']['left']:.0f})")
        verifie(rib["bottom"] <= m["panes"]["top"] + 0.5, f"{tag} pages sous le ruban ({rib['bottom']:.0f} <= {m['panes']['top']:.0f})")
        if m["insp"]:
            verifie(rib["right"] <= m["insp"]["left"] + 0.5, f"{tag} ruban hors de la colonne calculatrice")
    if m["calc"]:
        c = m["calc"]
        verifie(m["body"]["sh"] <= m["body"]["ch"], f"{tag} calculatrice sans defilement ({m['body']['sh']}/{m['body']['ch']})")
        verifie(c["bottom"] <= m["vh"] + 0.5 and c["top"] >= 0, f"{tag} calculatrice dans l'ecran ({c['top']:.0f}-{c['bottom']:.0f})")
        verifie(m["calcKeyMinH"] >= 34, f"{tag} touches de la calculatrice {m['calcKeyMinH']:.1f} px")
        verifie(m["send"] is not None and m["send"]["bottom"] <= min(c["bottom"], m["vh"]) + 0.5 and m["ckBottom"] <= m["send"]["top"] + 0.5,
                f"{tag} « Envoyer dans la page » visible, sous le pave ({m['ckBottom']:.0f} <= {m['send']['top']:.0f})")
        verifie(m["ctabs"]["sh"] <= m["ctabs"]["ch"] and m["ctabsBox"]["height"] >= 40, f"{tag} onglets de la calculatrice entiers ({m['ctabsBox']['height']:.0f} px)")
        if not m["docked"] and rib:
            print(f"     {tag} flottante : haut {c['top']:.0f}, ruban jusqu'a {rib['bottom']:.0f} ({'dessous' if c['top'] >= rib['bottom'] else 'PAR-DESSUS (pas la place)'})")
        if m["docked"] and rib:
            verifie(c["top"] < rib["top"] + 2, f"{tag} calculatrice sur toute la hauteur de sa colonne (haut {c['top']:.0f})")

def tous_onglets(page, tag):
    n = page.locator(".fr-tab").count()
    for i in range(n):
        # dispatch : a 1280 x 720, la calculatrice flottante peut passer sur le ruban.
        page.locator(".fr-tab").nth(i).dispatch_event("click"); page.wait_for_timeout(80)
        m = page.evaluate(MESURE)
        name = page.locator(".fr-tab").nth(i).get_attribute("title")
        ok = m["frkeys"]["sh"] <= m["frkeys"]["ch"] and m["keysBottom"] <= m["keysBox"]["bottom"] + 0.5 and m["keyMinW"] >= 33.5
        verifie(ok, f"{tag} onglet {name} : {m['nKeys']} touches, larg. min {m['keyMinW']:.1f}, bas {m['keysBottom']:.0f}/{m['keysBox']['bottom']:.0f}")
        if name == "Grec":
            page.locator(".mathkey.shift").dispatch_event("click"); page.wait_for_timeout(80)
            m = page.evaluate(MESURE)
            verifie(m["frkeys"]["sh"] <= m["frkeys"]["ch"], f"{tag} Grec majuscule tient")
            page.locator(".mathkey.shift").dispatch_event("click")

with sync_playwright() as pw:
    nav = pw.chromium.launch(args=["--mute-audio", f"--unsafely-treat-insecure-origin-as-secure={URL[:-1]}"])
    for (w, h) in SIZES:
        if only and str(w) not in only: continue
        for theme in ["light", "dark"]:
            for calc in ["fermee", "ancree", "detachee"]:
                st = {"theme": theme, "formulasOpen": True, "calcOpen": calc != "fermee", "calcDetached": calc == "detachee"}
                ctx, page, errs = ouvrir(pw, nav, w, h, st)
                tag = f"[{w}x{h} {theme} calc {calc}]"
                page.wait_for_timeout(600)
                m = page.evaluate(MESURE)
                controle(page, tag, m)
                if theme == "light" or w == 1536:
                    tous_onglets(page, tag)
                page.locator(".fr-tab[title='Grec']").dispatch_event("click"); page.wait_for_timeout(100)
                page.screenshot(path=f"{OUT}{w}-{theme}-{calc}.png")
                verifie(not errs, f"{tag} aucune erreur JS {errs[:2]}")
                ctx.close()
    # Parcours au clavier, 1536 x 780, calculatrice ancree.
    if not only or "1536" in only:
        ctx, page, errs = ouvrir(pw, nav, 1536, 780, {"theme": "light", "calcOpen": True})
        page.locator(".text-doc").first.click(); page.wait_for_timeout(200)
        page.keyboard.type("Pulsation ", delay=30)
        page.keyboard.press("Control+Shift+M"); page.wait_for_timeout(300)
        verifie(page.locator(".formula-ribbon").count() == 1, "Ctrl+Maj+M ouvre le ruban")
        page.locator(".fr-tab[title='Grec']").click(); page.wait_for_timeout(100)
        page.locator(".mathkey[aria-label^='oméga']").click(); page.wait_for_timeout(200)
        act = page.evaluate("() => !!document.activeElement?.closest('.text-doc')")
        verifie(act, "apres ω, le clavier est toujours dans le texte")
        page.keyboard.type(" puis ", delay=30)
        page.locator(".fr-search").click(); page.keyboard.type("fl", delay=40); page.wait_for_timeout(150)
        page.screenshot(path=f"{OUT}parcours-recherche.png")
        first = page.locator(".fr-keys .mathkey").first.get_attribute("aria-label")
        verifie(first.startswith("flèche, tend vers"), f"« fl » : premiere touche {first}")
        page.keyboard.press("Enter"); page.wait_for_timeout(300)
        act = page.evaluate("() => !!document.activeElement?.closest('.text-doc')")
        verifie(act, "Entree rend le clavier au texte")
        page.keyboard.type(" fin", delay=30); page.wait_for_timeout(400)
        txt = page.inner_text(".text-doc")
        print("texte :", repr(txt[:120]))
        verifie("ω" in txt and "→" in txt and "fin" in txt, "texte : ω et → poses, frappe reprise")
        page.screenshot(path=f"{OUT}parcours-fin.png")
        # Memorise : onglet et ouverture apres rechargement.
        s = json.loads(page.evaluate("localStorage.getItem('cahiers.settings.v1')"))
        verifie(s.get("formulasOpen") is True and s.get("formulasTab") == "greek", f"retenu : ouvert={s.get('formulasOpen')} onglet={s.get('formulasTab')}")
        page.reload(wait_until="networkidle"); page.wait_for_timeout(600)
        page.get_by_text("Maths", exact=True).first.click(); page.wait_for_timeout(1200)
        sel = page.locator(".fr-tab.on").get_attribute("title")
        verifie(sel == "Grec", f"apres rechargement, onglet {sel}")
        page.keyboard.press("Control+Shift+M"); page.wait_for_timeout(200)
        verifie(page.locator(".formula-ribbon").count() == 0, "Ctrl+Maj+M ferme le ruban")
        verifie(not errs, f"parcours sans erreur JS {errs[:2]}")
        ctx.close()
        # Recents par defaut sur une machine qui a deja servi.
        ctx, page, errs = ouvrir(pw, nav, 1536, 780, {"theme": "dark", "formulasOpen": True, "calcOpen": True})
        page.locator(".text-doc").first.click()
        page.locator(".fr-tab[title='Grec']").click(); page.locator(".mathkey[aria-label^='oméga']").click()
        page.locator(".fr-tab[title='Relations']").click(); page.locator(".mathkey[aria-label^='environ']").click()
        page.evaluate("() => { const s = JSON.parse(localStorage.getItem('cahiers.settings.v1')); s.formulasTab = null; localStorage.setItem('cahiers.settings.v1', JSON.stringify(s)); }")
        page.reload(wait_until="networkidle"); page.wait_for_timeout(600)
        page.get_by_text("Maths", exact=True).first.click(); page.wait_for_timeout(1200)
        sel = page.locator(".fr-tab.on").get_attribute("title")
        verifie(sel == "Récents", f"Récents par defaut quand non vide ({sel})")
        page.screenshot(path=f"{OUT}recents-dark.png")
        ctx.close()
    nav.close()
print(f"\n{len(problemes)} probleme(s)")
for p in problemes: print(" -", p)
