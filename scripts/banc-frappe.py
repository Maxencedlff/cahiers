#!/usr/bin/env python3
"""
Banc de frappe des formules : rejoue des phrases de cours touche par touche
dans la vraie interface (Playwright), avec des pauses de reflexion (> 900 ms)
au milieu des formules, des Retour arriere, des fleches et des reprises en
milieu de ligne, puis relit chaque ligne comme elle serait enregistree
(texte + $LaTeX$).

Mesure, pour chaque cas : la formule attendue est en UN bloc, le texte
francais reste du texte, rien n'est perdu (le texte relu de la ligne vaut le
texte tape).

Prerequis : un serveur de l'appli (vite preview d'un build, pas le serveur
de dev) et playwright (`pip install playwright && playwright install chromium`).

Usage : CAHIERS_URL=http://hote:port/ python3 scripts/banc-frappe.py [filtre]
"""
import os
import re
import sys

from playwright.sync_api import sync_playwright

URL = os.environ.get("CAHIERS_URL", "http://127.0.0.1:1420/")
FILTRE = sys.argv[1] if len(sys.argv) > 1 else ""

# Script de frappe : une liste d'etapes.
#   "texte"        : tape le texte (delai realiste entre les touches)
#   ("pause", ms)  : attend sans rien taper
#   ("key", "Backspace") : une touche ; ("key", "ArrowLeft", n) n fois
# `blocs` : formules attendues, chacune en UN bloc (texte source tel que
# relu par texToPlain, compare sans espaces) ; `texte` : mots qui doivent
# rester du texte hors formule.
P = ("pause", 1300)  # pause de reflexion au milieu d'une formule

CAS = [
    # --- Electronique : Zener, transistor ---
    dict(nom="zener-vs", frappe=["On a Vs = Vz - Vbe donc Vs ne depend pas de Ru", ("key", "Enter")],
         blocs=["Vs=Vz-Vbe"], texte=["On a", "donc", "ne depend pas de"]),
    dict(nom="zener-vs-pause", frappe=["On a Vs = Vz", P, " - Vbe", P, " donc c'est fixe", ("key", "Enter")],
         blocs=["Vs=Vz-Vbe"], texte=["On a", "donc c'est fixe"]),
    dict(nom="is-ie-chaine", frappe=["Is = Ie = Vs/Ru = (Vz - Vbe)/Ru > 0 avec Vz > Vbe", ("key", "Enter")],
         blocs=["Is=Ie=Vs/Ru=(Vz-Vbe)/Ru>0", "Vz>Vbe"], texte=["avec"]),
    dict(nom="is-ie-pauses", frappe=["Is = Ie", P, " = Vs/Ru", P, " = (Vz - Vbe)/Ru", P, " > 0 avec Vz > Vbe", ("key", "Enter")],
         blocs=["Is=Ie=Vs/Ru=(Vz-Vbe)/Ru>0", "Vz>Vbe"], texte=["avec"]),
    dict(nom="id-neg", frappe=["donc Id < 0", ("key", "Enter")], blocs=["Id<0"], texte=["donc"]),
    dict(nom="id-neg-pause", frappe=["donc Id", P, " < 0", ("key", "Enter")], blocs=["Id<0"], texte=["donc"]),
    dict(nom="beta-gg", frappe=["Comme β >> 1 on neglige IB", ("key", "Enter")], blocs=["β≫1"], texte=["Comme", "on neglige"]),
    dict(nom="beta-gg-pause", frappe=["Comme beta", P, " >> 1 on neglige IB", ("key", "Enter")], blocs=["β≫1"], texte=["Comme", "on neglige"]),
    dict(nom="vbatt-vz", frappe=["il faut Vbatt > Vz", ("key", "Enter")], blocs=["Vbatt>Vz"], texte=["il faut"]),
    dict(nom="vbatt-vz-pause", frappe=["il faut Vbatt", P, " > Vz", ("key", "Enter")], blocs=["Vbatt>Vz"], texte=["il faut"]),
    dict(nom="vbe-approx", frappe=["en lineaire Vbe ≈ VD ≈ 0,6 V.", ("key", "Enter")], blocs=["Vbe≈VD≈0,6V"], texte=["en lineaire"]),
    dict(nom="vbe-approx-pause", frappe=["en lineaire Vbe", P, " ~= VD", P, " ~= 0,6 V.", ("key", "Enter")], blocs=["Vbe≈VD≈0,6V"], texte=["en lineaire"]),
    dict(nom="pu-vsie", frappe=["Pu = Vs.Is = VsIe", ("key", "Enter")], blocs=["Pu=Vs·Is=VsIe"], texte=[]),
    dict(nom="eta", frappe=["donc η = Pu/Pf ≈ Vs/Vbatt car Is ≈ Ie", ("key", "Enter")],
         blocs=["η=Pu/Pf≈Vs/Vbatt", "Is≈Ie"], texte=["donc", "car"]),
    dict(nom="eta-pause", frappe=["donc eta = Pu/Pf", P, " ~= Vs/Vbatt car Is ~= Ie", ("key", "Enter")],
         blocs=["η=Pu/Pf≈Vs/Vbatt", "Is≈Ie"], texte=["donc", "car"]),
    dict(nom="is-ie-i", frappe=["Comme Is = Ie - i il faut que i soit faible", ("key", "Enter")],
         blocs=["Is=Ie-i"], texte=["Comme", "il faut que", "soit faible"]),
    dict(nom="i-soit", frappe=["Il faut que i = (Vbatt - Vz)/R soit negligeable", ("key", "Enter")],
         blocs=["i=(Vbatt-Vz)/R"], texte=["Il faut que", "soit negligeable"]),
    dict(nom="frac-beta", frappe=["IB = (Vz - Vbe)/(beta.Ru) donc", ("key", "Enter")],
         blocs=["IB=(Vz-Vbe)/(β·Ru)"], texte=["donc"]),
    # --- Buck ---
    dict(nom="alpha", frappe=["Objectif α = ton/T < 1", ("key", "Enter")], blocs=["α=ton/T<1"], texte=["Objectif"]),
    dict(nom="moy-ul", frappe=["En regime periodique <UL>T = 0", ("key", "Enter")], blocs=["<UL>T=0"], texte=["En regime periodique"]),
    dict(nom="s-alpha-e", frappe=["⇔ S = α.E", ("key", "Enter")], blocs=["S=α·E"], texte=[]),
    dict(nom="s-alpha-e-2", frappe=["donc S = alpha.E avec alpha = ton/T", ("key", "Enter")],
         blocs=["S=α·E", "α=ton/T"], texte=["donc", "avec"]),
    dict(nom="moyenne-ul", frappe=["(E - S) ton/T - S/T (T - ton) = 0", ("key", "Enter")],
         blocs=["(E-S)ton/T-S/T(T-ton)=0"], texte=[]),
    dict(nom="delta-il", frappe=["On veut ΔiL = 250 mA et ΔS = 50 mV", ("key", "Enter")],
         blocs=["ΔiL=250mA", "ΔS=50mV"], texte=["On veut", "et"]),
    dict(nom="intervalle", frappe=["Pour t appartient à [0, ton[, K fermé", ("key", "Enter")],
         blocs=["[0,ton["], texte=["Pour t appartient à", "K fermé"]),
    dict(nom="intervalle-2", frappe=["Pour t ∈ [ton, T[, K ouvert", ("key", "Enter")],
         blocs=["t∈[ton,T["], texte=["Pour", "K ouvert"]),
    # --- Signaux et systemes ---
    dict(nom="feq", frappe=["Donc Feq(p) = G(p)/(1 + G(p)H(p))", ("key", "Enter")],
         blocs=["Feq(p)=G(p)/(1+G(p)H(p))"], texte=["Donc"]),
    dict(nom="feq-pause", frappe=["Donc Feq(p) = G(p)", P, "/(1 + G(p)H(p))", ("key", "Enter")],
         blocs=["Feq(p)=G(p)/(1+G(p)H(p))"], texte=["Donc"]),
    dict(nom="feq-pause2", frappe=["Donc Feq(p)", P, " = G(p)/(1 + G(p)", P, "H(p)) fermé", ("key", "Enter")],
         blocs=["Feq(p)=G(p)/(1+G(p)H(p))"], texte=["Donc", "fermé"]),
    dict(nom="p12", frappe=["= (p + 12)/(p + 2)", ("key", "Enter")], blocs=["(p+12)/(p+2)"], texte=[]),
    dict(nom="laplace-e0", frappe=["3. En Laplace E(p) = E0/p soit 5/p", ("key", "Enter")],
         blocs=["E(p)=E0/p", "5/p"], texte=["En Laplace", "soit"]),
    dict(nom="laplace-e0-pause", frappe=["3. En Laplace E(p) = E0/", P, "p soit 5/p", ("key", "Enter")],
         blocs=["E(p)=E0/p", "5/p"], texte=["En Laplace", "soit"]),
    dict(nom="poles", frappe=["p^2 + 4 = 0 donc p = ±2j", ("key", "Enter")], blocs=["p^2+4=0", "p=±2j"], texte=["donc"]),
    dict(nom="s-t", frappe=["s(t) = (5 - 5e^-t)u(t)", ("key", "Enter")], blocs=["s(t)=(5-5e^-t)u(t)"], texte=[]),
    dict(nom="lim", frappe=["s(inf) = lim_(p->0) p S(p) = 5", ("key", "Enter")], blocs=["s(∞)=lim_(p→0)pS(p)=5"], texte=[]),
    dict(nom="feq-num", frappe=["Feq = 10^5/(1 + 10^5 . 0,1) ≈ 9,999", ("key", "Enter")], blocs=["Feq=10^5/(1+10^5·0,1)≈9,999"], texte=[]),
    # --- Corrections ---
    dict(nom="corr-bs", frappe=["On a Vs = Vz - Vbb", ("key", "Backspace"), "e donc", ("key", "Enter")],
         blocs=["Vs=Vz-Vbe"], texte=["On a", "donc"]),
    dict(nom="corr-bs-pause", frappe=["On a Vs = Vz - Vbb", P, ("key", "Backspace"), ("key", "Backspace"), "be donc", ("key", "Enter")],
         blocs=["Vs=Vz-Vbe"], texte=["On a", "donc"]),
    dict(nom="corr-bs-space", frappe=["On a Vs = Vz ", ("key", "Backspace"), ("key", "Backspace"), "x - Vbe donc", ("key", "Enter")],
         blocs=["Vs=Vx-Vbe"], texte=["On a", "donc"]),
    dict(nom="reprise-fin", frappe=["On a Vs = Vz donc", ("key", "Backspace", 5), " - Vbe donc", ("key", "Enter")],
         blocs=["Vs=Vz-Vbe"], texte=["On a", "donc"]),
    dict(nom="milieu-ligne", frappe=["Vs = Vz - Vbe donc stable", ("key", "ArrowLeft", 13), " + 0", ("key", "Escape"), ("key", "End"), ("key", "Enter")],
         blocs=["Vs=Vz-Vbe+0"], texte=["donc stable"]),
    dict(nom="fleche-gauche", frappe=["Vs = Vz - Vbe ", ("key", "ArrowLeft"), ("key", "ArrowRight"), "donc", ("key", "Enter")],
         blocs=["Vs=Vz-Vbe"], texte=["donc"]),
    dict(nom="suite-apres-pause", frappe=["Ie = IC + IB", P, " = IC(1 + 1/beta) avec β >> 1", ("key", "Enter")],
         blocs=["Ie=IC+IB=IC(1+1/β)", "β≫1"], texte=["avec"]),
    dict(nom="corr-bs-tard", frappe=["On a Vs = Vz - Vbb donc", ("key", "Backspace", 6), "e donc", ("key", "Enter")],
         blocs=["Vs=Vz-Vbe"], texte=["On a", "donc"]),
    dict(nom="corr-bs-tard-pause", frappe=["On a Vs = Vz - Vbb ", ("key", "Backspace", 2), P, "e donc", ("key", "Enter")],
         blocs=["Vs=Vz-Vbe"], texte=["On a", "donc"]),
    dict(nom="corr-refus-suite", frappe=["On a Vs = Vz ", ("key", "Backspace"), " - Vbe donc", ("key", "Enter")],
         blocs=["Vs=Vz-Vbe"], texte=["On a", "donc"]),
    dict(nom="corr-barre", frappe=["Vs = Vz/R", ("key", "Backspace", 3), " - Vbe donc", ("key", "Enter")],
         blocs=["Vs=Vz-Vbe"], texte=["donc"]),
    dict(nom="mot-apres-nombre", frappe=["alpha = ton/T", P, " < 1 ok", ("key", "Enter")], blocs=["α=ton/T<1"], texte=["ok"]),
    dict(nom="url", frappe=["(src: https://eepower.com/industry-articles/why-lithium-ion-batteries-last-longer-at", P, "-2080-soc/) vu", ("key", "Enter")],
         blocs=[], texte=["https://eepower.com/industry-articles/why-lithium-ion-batteries-last-longer-at-2080-soc/"]),
    dict(nom="date", frappe=["Seance du 12/1", P, "0 : on reprend", ("key", "Enter")], blocs=[], texte=["Seance du 12/10", "on reprend"]),
    dict(nom="date-2", frappe=["TD du 03/10", ("key", "Enter")], blocs=[], texte=["TD du 03/10"]),
    # --- Frappe rapide, sans espaces ---
    dict(nom="ns-is-ie", frappe=["Is=Ie=Vs/Ru=(Vz-VBE)/Ru=Ie>0 avec Vz>VBE", ("key", "Enter")],
         blocs=["Is=Ie=Vs/Ru=(Vz-VBE)/Ru=Ie>0", "Vz>VBE"], texte=["avec"]),
    dict(nom="ns-id", frappe=["Id=Vz/(beta Ru)-Vbe/(beta Ru)-Vbatt/R+Vz/R<0", ("key", "Enter")],
         blocs=["Id=Vz/(βRu)-Vbe/(βRu)-Vbatt/R+Vz/R<0"], texte=[]),
    dict(nom="ns-i-soit", frappe=["Il faut que i=(Vbatt-Vb)/R soit negligeable devant Ie", ("key", "Enter")],
         blocs=["i=(Vbatt-Vb)/R"], texte=["Il faut que", "soit negligeable devant"]),
    dict(nom="ns-pu", frappe=["Pu=Vs.Is=VsIe≈Vs.IC", ("key", "Enter")], blocs=["Pu=Vs.Is=VsIe≈Vs.IC"], texte=[]),
    dict(nom="ns-moy", frappe=["<UL>T=0", ("key", "Enter")], blocs=["<UL>T=0"], texte=[]),
    dict(nom="ns-buck", frappe=["(E-S)ton/T-S/T(T-ton)=0", ("key", "Enter")], blocs=["(E-S)ton/T-S/T(T-ton)=0"], texte=[]),
    dict(nom="ns-alpha", frappe=["donc S=α.E et α=ton/T<1", ("key", "Enter")], blocs=["S=α.E", "α=ton/T<1"], texte=["donc", "et"]),
    dict(nom="ns-feq", frappe=["Donc Feq(p)=G(p)/(1+G(p)H(p)) en boucle fermee", ("key", "Enter")],
         blocs=["Feq(p)=G(p)/(1+G(p)H(p))"], texte=["Donc", "en boucle fermee"]),
    dict(nom="ns-e0", frappe=["En Laplace E(p)=E0/p soit 5/p", ("key", "Enter")], blocs=["E(p)=E0/p", "5/p"], texte=["En Laplace", "soit"]),
    dict(nom="ns-gfrac", frappe=["(10/(p+2))/(1+10/(p+2)) = (p+12)/(p+2)", ("key", "Enter")],
         blocs=["(10/(p+2))/(1+10/(p+2))=(p+12)/(p+2)"], texte=[]),
    dict(nom="ns-pole", frappe=["Pole : RCp+1=0 donc p=-1/(RC)", ("key", "Enter")], blocs=["RCp+1=0", "p=-1/(RC)"], texte=["Pole", "donc"]),
    dict(nom="ns-lim", frappe=["lim p->0 pS(p)=5", ("key", "Enter")], blocs=["limp→0pS(p)=5"], texte=[]),
]


def relire_ligne(page, n):
    """Ligne n du texte (0 = premiere), texte + $latex$ + source des formules."""
    return page.evaluate(
        """(n) => {
        const root = document.querySelector('.text-doc');
        const lines = [[]];
        const walk = (node) => {
          for (const c of node.childNodes) {
            if (c.nodeType === 3) {
              const parts = c.data.replace(/\\u200b/g, '').split('\\n');
              parts.forEach((p, i) => { if (i) lines.push([]); if (p) lines[lines.length - 1].push({ t: p }); });
            } else if (c.nodeType === 1) {
              if (c.classList.contains('eq')) lines[lines.length - 1].push({ eq: c.dataset.latex || '', src: c.dataset.src || '', live: c.classList.contains('live') });
              else if (c.tagName === 'BR') lines.push([]);
              else if (c.classList.contains('dl') || c.tagName === 'DIV') { if (lines[lines.length - 1].length) lines.push([]); walk(c); lines.push([]); }
              else if (!c.classList.contains('text-ghost')) walk(c);
            }
          }
        };
        walk(root);
        const ne = lines.filter((l) => l.length);
        return ne[n] || [];
      }""",
        n,
    )


GRECS = {"alpha": "α", "beta": "β", "eta": "η", "Delta": "Δ", "inf": "∞"}
# Blocs sans source tapee (faits a l'editeur) : pas comparables, juste signales.


def plat(s):
    """Source comparable : sans blancs, ~= -> ≈, >> -> ≫, -> -> →, produit = « . », grec en lettre."""
    for a, b in GRECS.items():
        s = re.sub(rf"(?<![A-Za-z]){a}(?![A-Za-z])", b, s)
    s = re.sub(r"\s+", "", s)
    for a, b in (("~=", "≈"), (">>", "≫"), ("->", "→"), ("·", "."), ("*", ".")):
        s = s.replace(a, b)
    for a, b in GRECS.items():
        s = re.sub(rf"(?<![A-Za-z]){a}(?![A-Za-z])", b, s)
    return s


def tex_plain(page, latex):
    return page.evaluate("(l) => window.__texToPlain ? window.__texToPlain(l) : null", latex)


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
        page.locator(".text-doc").first.click()
        n = 0
        for cas in CAS:
            if FILTRE and FILTRE not in cas["nom"]:
                continue
            # Page vide pour chaque cas : tout selectionner, effacer.
            page.locator(".text-doc").first.click()
            page.keyboard.press("Control+a")
            page.keyboard.press("Delete")
            page.wait_for_timeout(150)
            for etape in cas["frappe"]:
                if isinstance(etape, str):
                    page.keyboard.type(etape, delay=60)
                elif etape[0] == "pause":
                    page.wait_for_timeout(etape[1])
                elif etape[0] == "key":
                    for _ in range(etape[2] if len(etape) > 2 else 1):
                        page.keyboard.press(etape[1])
                        page.wait_for_timeout(60)
            page.wait_for_timeout(250)
            ligne = relire_ligne(page, 0)
            rendu = "".join(p["t"] if "t" in p else f"⟦{p['src'] or '·'}⟧" for p in ligne)
            eqs = [p for p in ligne if "eq" in p]
            textes = "".join(p["t"] if "t" in p else " ¤ " for p in ligne)
            # Formule faite a l'editeur (sans source) : relue grossierement depuis son LaTeX.
            srcs = [plat(p["src"]) if p["src"] else plat(re.sub(r"\\[,;: ]|[{}_]", "", p["eq"])) for p in eqs]
            ok = True
            pb = []
            for b in cas["blocs"]:
                if plat(b) not in srcs:
                    ok = False
                    pb.append(f"bloc {b!r} absent")
            for t in cas["texte"]:
                if t not in textes:
                    ok = False
                    pb.append(f"texte {t!r} pas en texte")
            if not ok:
                rates += 1
            print(("OK   " if ok else "RATE ") + f"{cas['nom']:<18} {rendu}")
            for e in eqs:
                print(f"         $ {e['eq']}$   src={e['src']!r}")
            for p in pb:
                print("         -> " + p)
        if erreurs:
            print("ERREURS JS :", erreurs[:5])
        nav.close()
    print(f"\n{rates} cas rates")
    return 1 if rates else 0


if __name__ == "__main__":
    sys.exit(main())
