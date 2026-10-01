import { el } from "./dom";

/**
 * Sonde stylet (section 14).
 *
 * "Une page blanche qui capture les traits et affiche en direct pointerType,
 * pressure, et le nombre de points par trait." C'est la premiere etape du
 * projet : elle repond a la seule question qui conditionne tout le reste,
 * ce que renvoie reellement cet ecran.
 *
 * Elle reste accessible en permanence : le jour ou l'ecriture se comporte
 * bizarrement, c'est ici qu'on regarde d'abord.
 */
export function buildProbe(onClose: () => void): HTMLElement {
  const canvas = el("canvas", { class: "probe-canvas" });
  const out = {
    type: el("b", {}, "-"),
    pressure: el("b", {}, "-"),
    points: el("b", {}, "-"),
    rate: el("b", {}, "-"),
    tilt: el("b", {}, "-"),
    buttons: el("b", {}, "-"),
    coalesced: el("b", {}, "-"),
    seen: el("b", {}, "aucun"),
  };

  const readout = el("div", { class: "probe-readout" },
    el("div", {}, "pointerType ", out.type),
    el("div", {}, "pressure ", out.pressure),
    el("div", {}, "points du trait ", out.points),
    el("div", {}, "points/seconde ", out.rate),
    el("div", {}, "tiltX / tiltY ", out.tilt),
    el("div", {}, "boutons ", out.buttons),
    el("div", {}, "coalesces/frame ", out.coalesced),
    el("div", {}, "types vus ", out.seen),
  );

  const root = el("div", { class: "probe" },
    el("div", { class: "toolbar" },
      el("button", { onclick: onClose }, "Retour"),
      el("strong", {}, "Sonde stylet"),
      el("span", { class: "muted small" },
        "Écris sur la zone blanche. Tout ce que l'écran renvoie est affiché en direct."),
      el("div", { class: "spacer" }),
      el("button", { onclick: () => { strokes.length = 0; lastCount = 0; lastRate = "-"; paint(); } }, "Effacer"),
    ),
    canvas,
    readout,
  );

  const ctx = canvas.getContext("2d")!;
  type P = { x: number; y: number; p: number };
  const strokes: P[][] = [];
  let current: P[] | null = null;
  const typesSeen = new Set<string>();
  let firstTime = 0;
  let dpr = 1;
  let lastCount = 0;
  let lastRate = "-";

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    const r = canvas.getBoundingClientRect();
    canvas.width = Math.max(1, Math.round(r.width * dpr));
    canvas.height = Math.max(1, Math.round(r.height * dpr));
    paint();
  }

  function paint() {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.lineCap = ctx.lineJoin = "round";
    ctx.strokeStyle = "#16181d";
    for (const s of strokes) {
      for (let i = 1; i < s.length; i++) {
        ctx.lineWidth = 1 + 5 * s[i].p;
        ctx.beginPath();
        ctx.moveTo(s[i - 1].x, s[i - 1].y);
        ctx.lineTo(s[i].x, s[i].y);
        ctx.stroke();
      }
      // Un point par echantillon : on voit la densite reelle du digitizer.
      ctx.fillStyle = "rgba(37,99,235,.55)";
      for (const p of s) ctx.fillRect(p.x - .8, p.y - .8, 1.6, 1.6);
    }
  }

  const pos = (e: PointerEvent) => {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top, p: e.pressure };
  };

  canvas.addEventListener("pointerdown", (e) => {
    canvas.setPointerCapture(e.pointerId);
    current = [pos(e)];
    strokes.push(current);
    firstTime = e.timeStamp;
    typesSeen.add(e.pointerType);
    show(e, 1);
  });

  canvas.addEventListener("pointermove", (e) => {
    if (!current) { show(e, 0); return; }
    typesSeen.add(e.pointerType);
    const events = "getCoalescedEvents" in e ? e.getCoalescedEvents() : [e];
    const list = events.length ? events : [e];
    for (const ev of list) current.push(pos(ev as PointerEvent));
    paint();
    show(e, list.length);
  });

  const end = (e: PointerEvent) => { current = null; show(e, 0); };
  canvas.addEventListener("pointerup", end);
  canvas.addEventListener("pointercancel", end);

  function show(e: PointerEvent, coalesced: number) {
    if (current) {
      lastCount = current.length;
      const dt = (e.timeStamp - firstTime) / 1000;
      if (dt > 0.05) lastRate = String(Math.round(current.length / dt));
    }
    out.type.textContent = e.pointerType;
    out.pressure.textContent = e.pressure.toFixed(3);
    // On garde le compte du dernier trait : c'est le chiffre qu'on vient lire.
    out.points.textContent = String(lastCount);
    out.tilt.textContent = `${e.tiltX ?? 0} / ${e.tiltY ?? 0}`;
    out.buttons.textContent = String(e.buttons);
    out.coalesced.textContent = String(coalesced);
    out.seen.textContent = [...typesSeen].join(", ") || "aucun";
    out.rate.textContent = lastRate;
  }

  const ro = new ResizeObserver(resize);
  queueMicrotask(() => { ro.observe(canvas); resize(); });
  return root;
}
