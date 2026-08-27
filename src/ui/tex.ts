import katex from "katex";
import { el } from "./dom";

/**
 * Rendu des formules. Module a part pour que la vue des pages n'entraine pas
 * toute la calculatrice, et avec elle mathjs, dans le chargement initial.
 */
export function renderTex(latex: string): HTMLElement {
  const span = el("span", {});
  try {
    span.innerHTML = katex.renderToString(latex, { throwOnError: false, displayMode: false });
  } catch {
    span.textContent = latex;
  }
  return span;
}
