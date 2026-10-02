/**
 * Archive ZIP minimale (methode « stockee », sans compression), suffisante
 * pour un .docx : Word, LibreOffice et l'Explorateur la lisent. Les images
 * (PNG, JPEG) sont deja compressees ; le XML d'un cours pese peu.
 * Logique pure, sans DOM ni dependance.
 */

export interface ZipEntry {
  /** Chemin dans l'archive, separateur « / ». */
  name: string;
  data: Uint8Array | string;
}

let crcTable: Uint32Array | null = null;

/** CRC-32 (polynome 0xEDB88320), celui du format ZIP. */
export function crc32(data: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) crc = crcTable[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

const utf8 = new TextEncoder();

/** Date et heure au format DOS (fixe : l'archive ne depend pas de l'horloge). */
const DOS_TIME = 0;
const DOS_DATE = ((2024 - 1980) << 9) | (1 << 5) | 1;

/** Archive ZIP des entrees, dans l'ordre donne (le [Content_Types].xml d'abord pour un .docx). */
export function zipStore(entries: readonly ZipEntry[]): Uint8Array {
  const files = entries.map((e) => {
    const name = utf8.encode(e.name);
    const data = typeof e.data === "string" ? utf8.encode(e.data) : e.data;
    return { name, data, crc: crc32(data), offset: 0 };
  });
  let size = 0;
  for (const f of files) size += 30 + f.name.length + f.data.length;
  const centralStart = size;
  for (const f of files) size += 46 + f.name.length;
  size += 22;
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  let at = 0;
  const u16 = (v: number) => { view.setUint16(at, v, true); at += 2; };
  const u32 = (v: number) => { view.setUint32(at, v >>> 0, true); at += 4; };
  // Drapeau 0x0800 : noms en UTF-8.
  const FLAGS = 0x0800;
  for (const f of files) {
    f.offset = at;
    u32(0x04034b50); u16(20); u16(FLAGS); u16(0); u16(DOS_TIME); u16(DOS_DATE);
    u32(f.crc); u32(f.data.length); u32(f.data.length);
    u16(f.name.length); u16(0);
    out.set(f.name, at); at += f.name.length;
    out.set(f.data, at); at += f.data.length;
  }
  for (const f of files) {
    u32(0x02014b50); u16(20); u16(20); u16(FLAGS); u16(0); u16(DOS_TIME); u16(DOS_DATE);
    u32(f.crc); u32(f.data.length); u32(f.data.length);
    u16(f.name.length); u16(0); u16(0); u16(0); u16(0); u32(0); u32(f.offset);
    out.set(f.name, at); at += f.name.length;
  }
  u32(0x06054b50); u16(0); u16(0); u16(files.length); u16(files.length);
  u32(size - 22 - centralStart); u32(centralStart); u16(0);
  return out;
}

/** Lecture d'une archive « stockee » (tests, verification) : nom -> contenu. */
export function unzipStore(zip: Uint8Array): Map<string, Uint8Array> {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const out = new Map<string, Uint8Array>();
  const dec = new TextDecoder();
  let at = 0;
  while (at + 30 <= zip.length && view.getUint32(at, true) === 0x04034b50) {
    const method = view.getUint16(at + 8, true);
    const len = view.getUint32(at + 18, true);
    const nameLen = view.getUint16(at + 26, true);
    const extra = view.getUint16(at + 28, true);
    const name = dec.decode(zip.subarray(at + 30, at + 30 + nameLen));
    const start = at + 30 + nameLen + extra;
    if (method !== 0) throw new Error(`methode ${method} non lue`);
    out.set(name, zip.subarray(start, start + len));
    at = start + len;
  }
  return out;
}
