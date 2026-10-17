// Publication (GitHub Actions, .github/workflows/build.yml). Node 22 :
//   node --experimental-strip-types scripts/release.ts check v0.2.1
//     -> les trois numeros de version disent bien 0.2.1 (sinon echec) ;
//   node --experimental-strip-types scripts/release.ts plan v0.2.1 <artefacts> <sortie>
//     -> copie les fichiers a publier dans <sortie> + latest.json.
// La logique est dans src/core/release.ts (testee par vitest).
import { copyFileSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { planRelease, versionMismatch, versionOfTag } from "../src/core/release.ts";

const RELEASES = "https://github.com/Maxencedlff/cahiers-releases/releases/download";

function versions(): Record<string, string> {
  const pkg = JSON.parse(readFileSync("package.json", "utf8")).version as string;
  const conf = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8")).version as string;
  const cargo = /^version\s*=\s*"([^"]+)"/m.exec(readFileSync("src-tauri/Cargo.toml", "utf8"))?.[1] ?? "?";
  return { "package.json": pkg, "src-tauri/tauri.conf.json": conf, "src-tauri/Cargo.toml": cargo };
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

const [mode, tag, from, out] = process.argv.slice(2);
const wrong = versionMismatch(tag ?? "", versions());
if (wrong) {
  console.error(`::error::${wrong}. Changer la version aux trois endroits (docs/PUBLIER.md).`);
  process.exit(1);
}
if (mode === "plan") {
  const version = versionOfTag(tag)!;
  const plan = planRelease(walk(from), version, `${RELEASES}/v${version}`, (p) => readFileSync(p, "utf8"));
  mkdirSync(out, { recursive: true });
  for (const a of plan.assets) copyFileSync(a.path, join(out, a.name));
  writeFileSync(join(out, "latest.json"), `${JSON.stringify(plan.latest, null, 2)}\n`);
  console.log(plan.assets.map((a) => a.name).concat("latest.json").join("\n"));
} else if (mode !== "check") {
  console.error("usage : release.ts check <tag> | plan <tag> <artefacts> <sortie>");
  process.exit(2);
}
