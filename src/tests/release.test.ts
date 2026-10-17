import { describe, it, expect } from "vitest";
import { planRelease, versionMismatch, versionOfTag } from "../core/release";

const BASE = "https://github.com/Maxencedlff/cahiers-releases/releases/download/v0.2.0";
const FILES = [
  "a/cahiers-windows/nsis/Cahiers_0.2.0_x64-setup.exe",
  "a/cahiers-windows/nsis/Cahiers_0.2.0_x64-setup.exe.sig",
  "a/cahiers-mac/macos/Cahiers.app.tar.gz",
  "a/cahiers-mac/macos/Cahiers.app.tar.gz.sig",
  "a/cahiers-mac/dmg/Cahiers_0.2.0_universal.dmg",
  "a/cahiers-linux/appimage/Cahiers_0.2.0_amd64.AppImage",
  "a/cahiers-linux/appimage/Cahiers_0.2.0_amd64.AppImage.sig",
  "a/cahiers-linux/deb/Cahiers_0.2.0_amd64.deb",
];
const sig = (p: string) => `SIG(${p.split("/").pop()})\n`;

describe("version du tag", () => {
  it("vX.Y.Z seulement", () => {
    expect(versionOfTag("v0.2.1")).toBe("0.2.1");
    expect(versionOfTag("0.2.1")).toBe("0.2.1");
    expect(versionOfTag("v0.2")).toBeNull();
    expect(versionOfTag("release")).toBeNull();
  });
  it("les trois fichiers doivent dire la version du tag", () => {
    const ok = { "package.json": "0.2.1", "tauri.conf.json": "0.2.1", "Cargo.toml": "0.2.1" };
    expect(versionMismatch("v0.2.1", ok)).toBeNull();
    expect(versionMismatch("v0.2.1", { ...ok, "Cargo.toml": "0.2.0" })).toContain("Cargo.toml dit 0.2.0");
    expect(versionMismatch("v2", ok)).toContain("vX.Y.Z");
  });
});

describe("latest.json", () => {
  const plan = planRelease(FILES, "0.2.0", BASE, sig, new Date("2026-10-17T12:00:00.123Z"));
  it("quatre plateformes, Mac universel pour les deux processeurs", () => {
    const p = plan.latest.platforms;
    expect(plan.latest.version).toBe("0.2.0");
    expect(plan.latest.pub_date).toBe("2026-10-17T12:00:00Z");
    expect(p["windows-x86_64"]).toEqual({ signature: "SIG(Cahiers_0.2.0_x64-setup.exe.sig)", url: `${BASE}/Cahiers_0.2.0_x64-setup.exe` });
    expect(p["darwin-aarch64"].url).toBe(`${BASE}/Cahiers_0.2.0_universal.app.tar.gz`);
    expect(p["darwin-x86_64"]).toEqual(p["darwin-aarch64"]);
    expect(p["darwin-aarch64"].signature).toBe("SIG(Cahiers.app.tar.gz.sig)");
    expect(p["linux-x86_64"].url).toBe(`${BASE}/Cahiers_0.2.0_amd64.AppImage`);
  });
  it("fichiers publies : installateurs, archive Mac renommee, signatures", () => {
    const names = plan.assets.map((a) => a.name);
    expect(names).toContain("Cahiers_0.2.0_x64-setup.exe");
    expect(names).toContain("Cahiers_0.2.0_universal.dmg");
    expect(names).toContain("Cahiers_0.2.0_universal.app.tar.gz");
    expect(names).toContain("Cahiers_0.2.0_universal.app.tar.gz.sig");
    expect(names).toContain("Cahiers_0.2.0_amd64.deb");
    expect(names).not.toContain("Cahiers.app.tar.gz");
    expect(new Set(names).size).toBe(names.length);
  });
  it("plateforme ou signature manquante : pas de release", () => {
    expect(() => planRelease(FILES.filter((f) => !f.endsWith(".dmg")), "0.2.0", BASE, sig)).toThrow(/Mac/);
    expect(() => planRelease(FILES.filter((f) => !f.endsWith("setup.exe.sig")), "0.2.0", BASE, sig)).toThrow(/signature/);
    expect(() => planRelease(FILES.filter((f) => !f.includes("AppImage")), "0.2.0", BASE, sig)).toThrow(/Linux/);
  });
});
