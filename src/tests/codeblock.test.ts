import { describe, expect, it } from "vitest";
import { docLines, docPlainText, normalizeTokens, parseDoc, serializeDoc, type DocToken } from "../core/text/doc";
import { codeLang, highlight } from "../core/text/codehl";

const T = (text: string): DocToken => ({ kind: "text", text });

describe("blocs de code ``` dans le texte", () => {
  it("ecrit et relit un bloc avec son langage, le texte autour intact", () => {
    const code = "def f(x):\n    return x**2  # carre\n\nprint(f(3))";
    const tokens: DocToken[] = [T("Exemple"), { kind: "br" }, { kind: "codeblock", lang: "python", text: code }, { kind: "br" }, T("Fin")];
    const md = serializeDoc(tokens);
    expect(md).toBe("Exemple\n```python\n" + code + "\n```\nFin");
    expect(parseDoc(md)).toEqual(normalizeTokens(tokens));
    expect(serializeDoc(parseDoc(md))).toBe(md);
  });

  it("rien n'est converti dans le code (formules, gras, |, $)", () => {
    const code = "int a = *p | b; // $x$ **gras**\n| a | b |\n| --- | --- |";
    const toks = parseDoc("```c\n" + code + "\n```");
    expect(toks).toEqual([{ kind: "codeblock", lang: "c", text: code }]);
  });

  it("une ligne ``` dans le code : barriere plus longue", () => {
    const code = "Markdown :\n```js\nlet x\n```";
    const md = serializeDoc([{ kind: "codeblock", lang: "md", text: code }]);
    expect(md.startsWith("````md\n")).toBe(true);
    expect(parseDoc(md)).toEqual([{ kind: "codeblock", lang: "md", text: code }]);
  });

  it("``` sans fin, ou ``` tape dans le texte : reste du texte", () => {
    expect(parseDoc("```python\nprint(1)").some((t) => t.kind === "codeblock")).toBe(false);
    const toks: DocToken[] = [T("```"), { kind: "br" }, T("x"), { kind: "br" }, T("```")];
    const md = serializeDoc(toks);
    expect(md).toBe("\\`\\`\\`\nx\n\\`\\`\\`");
    expect(parseDoc(md)).toEqual(toks);
  });

  it("bloc vide, bloc en fin de texte, seul sur sa ligne", () => {
    const md = serializeDoc([{ kind: "codeblock", lang: "", text: "" }]);
    expect(parseDoc(md)).toEqual([{ kind: "codeblock", lang: "", text: "" }]);
    const lines = docLines(normalizeTokens([T("a"), { kind: "codeblock", lang: "", text: "x" }, T("b")]));
    expect(lines.map((l) => l.tokens.map((t) => t.kind))).toEqual([["text"], ["codeblock"], ["text"]]);
  });

  it("recherche : le code compte comme du texte", () => {
    expect(docPlainText("Voir\n```c\nmalloc(n)\n```")).toBe("Voir\nmalloc(n)");
  });
});

describe("coloration du code", () => {
  const kinds = (code: string, lang: string) => highlight(code, lang).filter((p) => p.kind).map((p) => `${p.kind}:${p.text}`);

  it("python : mots-cles, chaines, nombres, commentaires, appels", () => {
    const k = kinds("def f(x):\n    return 'a' + 3  # fin", "py");
    expect(k).toEqual(["kw:def", "fn:f", "kw:return", "str:'a'", "num:3", "com:# fin"]);
  });

  it("C : types, commentaires de bloc, #include", () => {
    const k = kinds("#include <stdio.h>\n/* x */ int main(void) { return 0; }", "c");
    expect(k).toContain("kw:include");
    expect(k).toContain("com:/* x */");
    expect(k).toContain("type:int");
    expect(k).toContain("fn:main");
    expect(k).toContain("num:0");
  });

  it("MATLAB : % commentaire, A' transposee (pas une chaine), 'texte' chaine", () => {
    const k = kinds("B = A' * 2; disp('ok') % fin", "matlab");
    expect(k).not.toContain("str:' * 2; disp(");
    expect(k).toContain("str:'ok'");
    expect(k).toContain("com:% fin");
  });

  it("le texte n'est jamais modifie par la coloration", () => {
    for (const [code, lang] of [["x = \"non fermé\nsuite", "python"], ["/* sans fin", "c"], ["a1b2 0x1F 1e-3", ""]]) {
      expect(highlight(code, lang).map((p) => p.text).join("")).toBe(code);
    }
  });

  it("langages : alias et inconnus", () => {
    expect(codeLang("Py")).toBe("python");
    expect(codeLang("c++")).toBe("cpp");
    expect(codeLang("klingon")).toBeNull();
  });
});
