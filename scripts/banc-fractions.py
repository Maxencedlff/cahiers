#!/usr/bin/env python3
"""
Banc de frappe des fractions : rejoue la frappe touche par touche dans la
vraie interface (Playwright), sur une page de test du mode navigateur
(localStorage, jamais les cahiers reels), puis relit la ligne telle qu'elle
serait enregistree : le texte, et chaque formule en $LaTeX$.

Prerequis : l'appli servie SANS le serveur de dev (d'autres editent les
sources : HMR). Cote Windows :
  npx vite build --outDir C:\\Users\\maxde\\AppData\\Local\\Temp\\cahiers-frac
  npx vite preview --outDir C:\\Users\\maxde\\AppData\\Local\\Temp\\cahiers-frac --port 1437 --host 0.0.0.0
puis depuis WSL :
  CAHIERS_URL=http://$(ip route show default | awk '{print $3}'):1437/ python3 scripts/banc-fractions.py [filtre]

Notation des frappes : texte tape tel quel, et entre accolades {BS} Retour
arriere, {LEFT} {RIGHT} {END} {HOME} fleches, {ENTER}, {PAUSE} une pause de
frappe (la mise en forme a la pause passe), {ESC}.

Chaque cas donne la ligne attendue ; un « ~ » en tete = comparaison sans
blancs. Code de sortie 1 si un cas echoue.
"""
import os
import re
import sys

from playwright.sync_api import sync_playwright

URL = os.environ.get("CAHIERS_URL", "http://127.0.0.1:1437/")
DELAI = int(os.environ.get("DELAI", "25"))

F = r"\frac"
# (frappe, attendu). Attendu = ligne relue : texte + $LaTeX$.
CAS: list[tuple[str, str]] = [
    # --- Feq, fraction de fraction (Signaux & systemes 14-15/10) ---
    ("Feq(p) = (K/(p(p+3)))/(1+K/(p(p+3))) ",
     r"$F_{eq}\left(p\right) = \frac{\frac{K}{p\left(p + 3\right)}}{1 + \frac{K}{p\left(p + 3\right)}}$ "),
    ("K/(p(p+3)) / (1 + K/(p(p+3))) ",
     r"$\frac{\frac{K}{p\left(p + 3\right)}}{1 + \frac{K}{p\left(p + 3\right)}}$ "),
    ("Feq = (10/(p+2))/(1+(10/(p+2))) ",
     r"$F_{eq} = \frac{\frac{10}{p + 2}}{1 + \frac{10}{p + 2}}$ "),
    ("Donc Feq(p) = G(p)/(1 + G(p)H(p)) ",
     r"Donc $F_{eq}\left(p\right) = \frac{G\left(p\right)}{1 + G\left(p\right)\,H\left(p\right)}$ "),
    ("G(p)/(1 + G(p)H(p)) ",
     r"$\frac{G\left(p\right)}{1 + G\left(p\right)\,H\left(p\right)}$ "),
    ("(4/(p+1))/(1+(4/(p+1)).0,2) ",
     r"$\frac{\frac{4}{p + 1}}{1 + \frac{4}{p + 1} \times 0{,}2}$ "),
    ("(4/(p+1))/(1-4/(p+1).0,2) ",
     r"$\frac{\frac{4}{p + 1}}{1 - \frac{4}{p + 1} \times 0{,}2}$ "),
    ("1/(1+1/(1+x)) ", r"$\frac{1}{1 + \frac{1}{1 + x}}$ "),
    ("(a/b)/(c/d) ", r"$\frac{\frac{a}{b}}{\frac{c}{d}}$ "),
    ("a/b/c ", r"$\frac{\frac{a}{b}}{c}$ "),
    # --- texte francais apres la fraction ---
    ("En Laplace E(p) = E0/p soit 5/p ",
     r"En Laplace $E\left(p\right) = \frac{E_0}{p}$ soit $\frac{5}{p}$ "),
    ("(Vbatt - Vz)/R soit négligeable ",
     r"$\frac{V_{batt} - V_z}{R}$ soit négligeable "),
    ("(Vbatt-Vb)/R soit ", r"$\frac{V_{batt}-V_b}{R}$ soit "),
    # --- produits, signes, parentheses ---
    ("Vs = Ru/(R+Ru).Vbatt ", r"$V_s = \frac{R_u}{R + R_u}\,V_{batt}$ "),
    ("H = 1/R.C ", r"$H = \frac{1}{R\,C}$ "),
    ("p = -1/R.C donc ", r"$p = \frac{-1}{R\,C}$ donc "),
    ("tau = R.C = 10.10^3.100.10^-6 ", r"$\tau = R\,C = 10 \times 10^{3} \times 100 \times 10^{-6}$ "),
    ("x = 2.5.10^3 ", r"$x = 2.5 \times 10^{3}$ "),
    ("on a H = 1/p. Puis ", r"on a $H = \frac{1}{p}$. Puis "),
    ("Vs = Vz{PAUSE}(1+R/Ru) ", r"$V_s = V_z\left(1 + \frac{R}{R_u}\right)$ "),
    ("H = 1/(R.C.p+1) ", r"$H = \frac{1}{R\,C\,p + 1}$ "),
    ("p = -1/(RC) ", r"$p = \frac{-1}{R\,C}$ "),
    ("p = -1/(R.C) ", r"$p = \frac{-1}{R\,C}$ "),
    ("Ic(1+1/beta) ", r"$I_c\left(1 + \frac{1}{\beta}\right)$ "),
    ("Vz(1+R/Ru) ", r"$V_z\left(1 + \frac{R}{R_u}\right)$ "),
    ("Vs = Vz(1+R/Ru) ", r"$V_s = V_z\left(1 + \frac{R}{R_u}\right)$ "),
    ("2/(p^2+3p+2) ", r"$\frac{2}{p^{2} + 3\,p + 2}$ "),
    ("A/p + B/(p+1) ", r"$\frac{A}{p} + \frac{B}{p + 1}$ "),
    ("e^(-t/RC) ", r"$e^{\frac{-t}{R\,C}}$ "),
    ("10^5/(1+10^5.0,1) ", r"$\frac{10^{5}}{1 + 10^{5} \times 0{,}1}$ "),
    ("-1/(10.10^3.100.10^-6) = -1 ", r"$\frac{-1}{10 \times 10^{3} \times 100 \times 10^{-6}} = -1$ "),
    ("H(p) = K/(1+tau p) ", r"$H\left(p\right) = \frac{K}{1 + \tau\,p}$ "),
    ("F(p) = 1/(p(p+1)(p+2)) ", r"$F\left(p\right) = \frac{1}{p\left(p + 1\right)\left(p + 2\right)}$ "),
    ("S(p) = E0/p . 1/(1+tau p) ", r"$S\left(p\right) = \frac{E_0}{p} \times \frac{1}{1 + \tau\,p}$ "),
    ("y = (1-x)/(1+x) ", r"$y = \frac{1 - x}{1 + x}$ "),
    ("1/(1/R1+1/R2) ", r"$\frac{1}{\frac{1}{R_1} + \frac{1}{R_2}}$ "),
    ("Req = R1R2/(R1+R2) ", r"$R_{eq} = \frac{R_1\,R_2}{R_1 + R_2}$ "),
    # --- electronique, Laplace, maths ---
    ("1/(p+1)(p+2) ", r"$\frac{1}{\left(p + 1\right)\left(p + 2\right)}$ "),
    ("u(t) = E(1-e^(-t/tau)) ", r"$u\left(t\right) = E\left(1 - e^{\frac{-t}{\tau}}\right)$ "),
    ("Te = 1/Fe ", r"$T_e = \frac{1}{F_e}$ "),
    ("fc = 1/(2piRC) ", r"$f_c = \frac{1}{2\,\pi\,R\,C}$ "),
    ("Z = R + 1/(jCw) ", r"$Z = R + \frac{1}{j\,C\,\omega}$ "),
    ("H(jw) = 1/(1+jRCw) ", r"$H\left(j\omega\right) = \frac{1}{1 + j\,R\,C\,\omega}$ "),
    ("|H| = 1/sqrt(1+(RCw)^2) ", r"$\left|H\right| = \frac{1}{\sqrt{1 + \left(R\,C\,\omega\right)^{2}}}$ "),
    ("x = (-b+sqrt(delta))/(2a) ", r"$x = \frac{-b + \sqrt{\delta}}{2\,a}$ "),
    ("I = (E - Vd)/R = 5/1000 ", r"$I = \frac{E - V_d}{R} = \frac{5}{1000}$ "),
    ("F(p) = (p+1)/((p+2)(p+3)) ", r"$F\left(p\right) = \frac{p + 1}{\left(p + 2\right)\left(p + 3\right)}$ "),
    ("Y(p) = 1/(p+1) - 1/(p+2) ", r"$Y\left(p\right) = \frac{1}{p + 1} - \frac{1}{p + 2}$ "),
    ("1/2 + 1/3 = 5/6 ", r"$\frac{1}{2} + \frac{1}{3} = \frac{5}{6}$ "),
    ("Vs/Ve = -R2/R1 ", r"$\frac{V_s}{V_e} = \frac{-R_2}{R_1}$ "),
    ("A = Vs/Ve = 1 + R2/R1 ", r"$A = \frac{V_s}{V_e} = 1 + \frac{R_2}{R_1}$ "),
    ("dv/dt = -v/(RC) ", r"$\frac{\mathrm{d}v}{\mathrm{d}t} = \frac{-v}{R\,C}$ "),
    ("f'(x) = 1/x^2 ", r"$f'\left(x\right) = \frac{1}{x^{2}}$ "),
    ("H(p) = (1/(RC))/(p+1/(RC)) ", r"$H\left(p\right) = \frac{\frac{1}{R\,C}}{p + \frac{1}{R\,C}}$ "),
    ("Vs = Vz (1+R/Ru) ", r"$V_s = V_z\,\left(1 + \frac{R}{R_u}\right)$ "),
    ("Vs = Vz{PAUSE} (1+R/Ru) ", r"$V_s = V_z\,\left(1 + \frac{R}{R_u}\right)$ "),
    ("on a Ic = beta Ib donc Ie = Ic(1+1/beta) ", r"on a $I_c = \beta\,I_b$ donc $I_e = I_c\left(1 + \frac{1}{\beta}\right)$ "),
    ("T = 2pi/w0 ", r"$T = \frac{2\,\pi}{\omega_0}$ "),
    ("K/p(p+3) ", r"$\frac{K}{p\left(p + 3\right)}$ "),
    ("Feq = K/(p^2+3p+K) ", r"$F_{eq} = \frac{K}{p^{2} + 3\,p + K}$ "),
    # --- sortir de la fraction : fleche, Echap ---
    ("H = K/p{RIGHT}+1 ", r"$H = \frac{K}{p} + 1$ "),
    ("H = K/p{ESC}+1 ", r"$H = \frac{K}{p} + 1$ "),
    ("H = K/(p+1){ENTER}", r"$H = \frac{K}{p + 1}$"),
    ("K/(p + 1) soit ", r"$\frac{K}{p + 1}$ soit "),
    ("H = 1/R.C{ENTER}", r"$H = \frac{1}{R\,C}$"),
    ("1/(1+K/(p+3{BS}2)) ", r"$\frac{1}{1 + \frac{K}{p + 2}}$ "),
    ("Vs = R/{BS}{BS} I ", r"$V_s = R\,I$ "),
    # --- avec des pauses de frappe (mise en forme a la pause) ---
    ("Donc Feq(p) = G(p){PAUSE}/(1 + G(p)H(p)) ",
     r"Donc $F_{eq}\left(p\right) = \frac{G\left(p\right)}{1 + G\left(p\right)\,H\left(p\right)}$ "),
    ("Feq(p) = (K/(p(p+3))){PAUSE}/(1+K/(p(p+3))) ",
     r"$F_{eq}\left(p\right) = \frac{\frac{K}{p\left(p + 3\right)}}{1 + \frac{K}{p\left(p + 3\right)}}$ "),
    ("Feq = K/(p(p+3)) {PAUSE}/ (1 + K/(p(p+3))) ",
     r"$F_{eq} = \frac{\frac{K}{p\left(p + 3\right)}}{1 + \frac{K}{p\left(p + 3\right)}}$ "),
    ("Feq = (K/(p(p+3)){PAUSE})/(1{PAUSE}+K/(p(p+3){PAUSE})) ",
     r"$F_{eq} = \frac{\frac{K}{p\left(p + 3\right)}}{1 + \frac{K}{p\left(p + 3\right)}}$ "),
    ("Feq = (10/(p+2))/(1+(10/(p+2){PAUSE})) ",
     r"$F_{eq} = \frac{\frac{10}{p + 2}}{1 + \frac{10}{p + 2}}$ "),
    ("E(p) = E0/{PAUSE}p ", r"$E\left(p\right) = \frac{E_0}{p}$ "),
    ("E(p) = E0{PAUSE}/p ", r"$E\left(p\right) = \frac{E_0}{p}$ "),
    ("p = -{PAUSE}1/(RC) ", r"$p = \frac{-1}{R\,C}$ "),
    ("Ic(1+1/beta{PAUSE}) ", r"$I_c\left(1 + \frac{1}{\beta}\right)$ "),
    ("Vz (1+R/Ru{PAUSE}) ", r"$V_z\,\left(1 + \frac{R}{R_u}\right)$ "),
    ("(Vbatt - Vz)/R {PAUSE}soit ", r"$\frac{V_{batt} - V_z}{R}$ soit "),
    # --- corrections naturelles ---
    ("1/(p+3{BS}2) ", r"$\frac{1}{p + 2}$ "),
    ("K/(p+1{BS}{BS}(p+1)) ", r"$\frac{K}{p\left(p + 1\right)}$ "),
    ("a/b{BS}{BS}{BS}{BS}x + 1 ", r"$x + 1$ "),
]


JS_LIGNE = r"""
() => {
  const doc = document.querySelector('.text-doc');
  let out = '';
  const walk = (n) => {
    for (const c of n.childNodes) {
      if (c.nodeType === 3) out += c.data.replace(/\u200b/g, '');
      else if (c.nodeName === 'BR') out += '\n';
      else if (c.classList && c.classList.contains('eq')) out += '$' + (c.dataset.latex ?? '?') + '$';
      else { if (c.classList && c.classList.contains('dl') && out && !out.endsWith('\n')) out += '\n'; walk(c); }
    }
  };
  walk(doc);
  return out;
}
"""


def taper(page, frappe: str) -> None:
    for morceau in re.split(r"(\{[A-Z]+\})", frappe):
        if not morceau:
            continue
        m = re.fullmatch(r"\{([A-Z]+)\}", morceau)
        if not m:
            page.keyboard.type(morceau, delay=DELAI)
            continue
        k = m.group(1)
        if k == "PAUSE":
            page.wait_for_timeout(1300)
            continue
        touche = {"BS": "Backspace", "LEFT": "ArrowLeft", "RIGHT": "ArrowRight", "END": "End",
                  "HOME": "Home", "ENTER": "Enter", "ESC": "Escape"}[k]
        page.keyboard.press(touche)
        page.wait_for_timeout(DELAI)


def norm(s: str) -> str:
    return re.sub(r"\s+", "", s)


def main() -> int:
    filtre = sys.argv[1] if len(sys.argv) > 1 else ""
    echecs = 0
    with sync_playwright() as pw:
        nav = pw.chromium.launch(args=["--mute-audio"])
        page = nav.new_page(viewport={"width": 1500, "height": 940})
        erreurs: list[str] = []
        page.on("pageerror", lambda e: erreurs.append(str(e)))
        page.goto(URL, wait_until="networkidle")
        page.evaluate("localStorage.clear()")
        page.reload(wait_until="networkidle")
        page.wait_for_timeout(1000)
        page.get_by_text("Maths", exact=True).first.click()
        page.wait_for_timeout(900)
        page.keyboard.type("x")
        page.wait_for_timeout(300)
        for frappe, attendu in CAS:
            if filtre and filtre not in frappe:
                continue
            doc = page.locator(".text-doc").first
            doc.focus()
            page.keyboard.press("Control+a")
            page.keyboard.press("Delete")
            page.wait_for_timeout(150)
            taper(page, frappe)
            page.wait_for_timeout(200)
            ligne = page.evaluate(JS_LIGNE).strip("\n")
            exp = attendu
            ok = norm(ligne) == norm(exp)
            if not ok:
                echecs += 1
            print(("OK    " if ok else "RATE  ") + frappe.replace("\n", "⏎"))
            if not ok:
                print("        obtenu : " + ligne)
                print("        voulu  : " + exp)
        if erreurs:
            print("Erreurs JS :", *erreurs, sep="\n  ")
        nav.close()
    print(f"\n{echecs} echec(s)")
    return 1 if echecs else 0


if __name__ == "__main__":
    sys.exit(main())
