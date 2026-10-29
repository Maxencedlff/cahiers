// Parcours d utilisateur rejoue sur un Mac de GitHub (mac-impression.yml) :
// nouvelle matiere, une ligne tapee, Partager, Exporter. Journal en jaune
// dans la fenetre, visible sur les captures.
(async () => {
  const log = document.createElement("pre");
  log.style.cssText = "position:fixed;right:8px;top:40px;z-index:99999;background:#ff0;color:#000;font:13px monospace;padding:6px;max-width:420px;white-space:pre-wrap";
  document.documentElement.append(log);
  const say = (m) => { log.textContent += m + "\n"; };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const find = async (fn, what, ms = 8000) => {
    for (let t = 0; t < ms; t += 200) { const n = fn(); if (n) return n; await wait(200); }
    throw new Error("introuvable : " + what);
  };
  const byText = (sel, txt) => [...document.querySelectorAll(sel)].find((b) => b.textContent.trim().includes(txt) && b.offsetParent !== null);
  try {
    say("1 nouvelle matiere");
    (await find(() => byText("button", "Nouvelle matière") || document.querySelector('[aria-label="Nouvelle matière"]'), "bouton Nouvelle matière")).click();
    await wait(800);
    const input = await find(() => [...document.querySelectorAll(".backdrop input")].find((i) => i.offsetParent !== null), "champ du nom");
    input.focus();
    document.execCommand("insertText", false, "Essai " + (Date.now() % 100000));
    if (!input.value) { input.value = "Essai " + (Date.now() % 100000); input.dispatchEvent(new Event("input", { bubbles: true })); }
    say("  nom=" + input.value);
    await wait(300);
    say("2 valider");
    const ok = byText(".backdrop button", "Créer");
    if (ok) ok.click(); else input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await wait(1500);
    if (!document.querySelector(".text-doc")) {
      say("3 ouvrir la matiere");
      (await find(() => byText("button, a, [role=button], .nb-card, li", "Essai"), "matière Essai")).click();
    }
    const doc = await find(() => document.querySelector(".text-doc"), "page (.text-doc)", 15000);
    say("4 page ouverte, frappe");
    doc.focus();
    document.execCommand && document.execCommand("insertText", false, "Bonjour Apple");
    await wait(1500);
    for (const b of document.querySelectorAll(".backdrop button")) if (b.textContent.trim() === "Annuler") { say("  boite en trop fermee"); b.click(); }
    await wait(800);
    say("5 Partager");
    (await find(() => document.querySelector('[aria-label="Partager"]'), "bouton Partager")).click();
    say("6 Exporter");
    (await find(() => byText(".backdrop button", "Exporter"), "bouton Exporter")).click();
    say("7 clic fait " + new Date().toISOString().slice(11, 19));
    window.addEventListener("afterprint", () => say("afterprint"));
    for (let i = 1; i <= 12; i++) { await wait(5000); say("  +" + i * 5 + " s printing=" + document.body.classList.contains("printing")); }
  } catch (e) { say("ERREUR " + (e && e.message || e)); }
})();
