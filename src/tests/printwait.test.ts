import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { printAndWait, PRINT_WAIT_MAX_MS } from "../core/printwait";

/** Fenetre simulee : ses evenements et le nombre d'ecouteurs restants. */
function fakeWindow() {
  const target = new EventTarget();
  let listeners = 0;
  return {
    addEventListener(type: string, fn: () => void) { listeners++; target.addEventListener(type, fn); },
    removeEventListener(type: string, fn: () => void) { listeners--; target.removeEventListener(type, fn); },
    fire(type: string) { target.dispatchEvent(new Event(type)); },
    get listeners() { return listeners; },
  };
}

/** Etat d'une promesse apres les microtaches en attente. */
async function settled(p: Promise<unknown>): Promise<"pending" | "done" | "failed"> {
  let state: "pending" | "done" | "failed" = "pending";
  p.then(() => { state = "done"; }, () => { state = "failed"; });
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  return state;
}

describe("fin d'impression (export PDF)", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("afterprint termine l'attente (WebView2)", async () => {
    const win = fakeWindow();
    const p = printAndWait(win, () => undefined);
    expect(await settled(p)).toBe("pending");
    win.fire("afterprint");
    expect(await settled(p)).toBe("done");
    expect(win.listeners).toBe(0);
  });

  it("commande d'impression refusee (Mac sans permission) : erreur, ecouteurs retires", async () => {
    const win = fakeWindow();
    const p = printAndWait(win, () => Promise.reject(new Error("print not allowed")));
    await expect(p).rejects.toThrow("print not allowed");
    expect(win.listeners).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("exception de print : erreur", async () => {
    const win = fakeWindow();
    await expect(printAndWait(win, () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(win.listeners).toBe(0);
  });

  it("promesse tenue des l'ouverture de la boite (Mac) : on attend encore la fin", async () => {
    const win = fakeWindow();
    const p = printAndWait(win, () => Promise.resolve());
    expect(await settled(p)).toBe("pending");
    win.fire("blur");
    win.fire("focus");
    expect(await settled(p)).toBe("done");
  });

  it("le focus ne compte qu'apres avoir ete perdu", async () => {
    const win = fakeWindow();
    const p = printAndWait(win, () => undefined);
    win.fire("focus");
    expect(await settled(p)).toBe("pending");
    win.fire("blur");
    expect(await settled(p)).toBe("pending");
    win.fire("focus");
    expect(await settled(p)).toBe("done");
  });

  it("sans aucun signal, la vue revient au bout du delai maximal", async () => {
    const win = fakeWindow();
    const p = printAndWait(win, () => undefined);
    vi.advanceTimersByTime(PRINT_WAIT_MAX_MS - 1);
    expect(await settled(p)).toBe("pending");
    vi.advanceTimersByTime(1);
    expect(await settled(p)).toBe("done");
    expect(win.listeners).toBe(0);
  });
});
