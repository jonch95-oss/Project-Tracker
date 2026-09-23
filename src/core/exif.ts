/**
 * When a JPEG photo was taken, from its EXIF DateTimeOriginal (falling back
 * to DateTime). EXIF has no time zone; site photos are taken in New York, so
 * the wall-clock time is read as New York time. Returns null when absent or
 * unreadable — never guesses from the file's modified time.
 */
import { TZDate } from "@date-fns/tz";
import { APP_TIME_ZONE } from "./time";

const DATE_TIME_ORIGINAL = 0x9003;
const DATE_TIME = 0x0132;
const EXIF_IFD_POINTER = 0x8769;

export function exifTakenAt(buf: ArrayBuffer): Date | null {
  try {
    const v = new DataView(buf);
    if (v.byteLength < 4 || v.getUint16(0) !== 0xffd8) return null;
    let off = 2;
    while (off + 4 <= v.byteLength) {
      if (v.getUint8(off) !== 0xff) return null;
      const marker = v.getUint8(off + 1);
      const len = v.getUint16(off + 2);
      if (marker === 0xe1 && off + 10 <= v.byteLength && v.getUint32(off + 4) === 0x45786966) return fromTiff(v, off + 10, off + 2 + len);
      if (marker === 0xda || marker === 0xd9) return null; // image data starts; no EXIF
      off += 2 + len;
    }
  } catch {
    // Truncated or malformed: treat as no date.
  }
  return null;
}

function fromTiff(v: DataView, start: number, end: number): Date | null {
  const little = v.getUint16(start) === 0x4949;
  if (!little && v.getUint16(start) !== 0x4d4d) return null;
  const u16 = (o: number) => v.getUint16(start + o, little);
  const u32 = (o: number) => v.getUint32(start + o, little);
  const readIfd = (ifd: number): Map<number, number> => {
    const tags = new Map<number, number>();
    if (start + ifd + 2 > end) return tags;
    const n = u16(ifd);
    for (let i = 0; i < n; i++) {
      const e = ifd + 2 + i * 12;
      if (start + e + 12 > end) break;
      tags.set(u16(e), e);
    }
    return tags;
  };
  const ascii = (entry: number): string | null => {
    const count = u32(entry + 4);
    if (count < 19) return null;
    const at = count > 4 ? u32(entry + 8) : entry + 8;
    if (start + at + 19 > end) return null;
    let s = "";
    for (let i = 0; i < 19; i++) s += String.fromCharCode(v.getUint8(start + at + i));
    return s;
  };
  const ifd0 = readIfd(u32(4));
  let raw: string | null = null;
  const exifPtr = ifd0.get(EXIF_IFD_POINTER);
  if (exifPtr !== undefined) {
    const exif = readIfd(u32(exifPtr + 8));
    const e = exif.get(DATE_TIME_ORIGINAL);
    if (e !== undefined) raw = ascii(e);
  }
  if (!raw) {
    const e = ifd0.get(DATE_TIME);
    if (e !== undefined) raw = ascii(e);
  }
  return raw ? parseExifDate(raw) : null;
}

/** "2026:09:23 14:05:09" in New York wall-clock time → instant. */
export function parseExifDate(s: string): Date | null {
  const m = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(s);
  if (!m) return null;
  const [y, mo, d, h, mi, se] = m.slice(1).map(Number) as [number, number, number, number, number, number];
  if (y < 1990 || mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || se > 59) return null;
  return new Date(new TZDate(y, mo - 1, d, h, mi, se, 0, APP_TIME_ZONE).getTime());
}
