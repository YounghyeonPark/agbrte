/**
 * A sixel image into pixels (DESIGN.md §17 Q24, step 3).
 *
 * Written here rather than taken from xterm's image addon: the owner's rule for
 * this direction is that what can be made here is made here, and a sixel
 * decoder is one loop over the characters of the format:
 *
 *     "Pan;Pad;Ph;Pv     raster attributes: aspect, and the size in pixels
 *     #Pc;Pu;Px;Py;Pz    define colour Pc (Pu 1: HLS, 2: RGB, each 0–100)
 *     #Pc                draw with colour Pc
 *     !Pn c              the sixel c, Pn times
 *     $                  back to the start of this band
 *     -                  the next band, six pixels down
 *     ? … ~              a sixel: six vertical pixels, bit 0 at the top
 *
 * ## Decisions the format leaves open
 *
 *  - **Pixels never drawn are transparent**, whatever the background parameter
 *    asks. A VT340 painted them colour 0, which is black, and on this app's navy
 *    a black rectangle around every plot is a frame nobody asked for; xterm and
 *    foot both show the terminal's own background there by default.
 *  - **The aspect ratio is ignored.** Every sixel producer people still run
 *    writes square pixels and says `"1;1`; honouring a 2:1 from a VT340-era
 *    file would make a modern plot twice as tall.
 *  - **Colours belong to one image.** The registers start from the VT340's
 *    sixteen every time, which is xterm's default (`privateColorRegisters`), so
 *    one program's palette cannot repaint the next one's picture.
 *
 * ## Bounds
 *
 * The size comes from the data, so it is capped (`MAX_SIXEL_SIDE`) before
 * anything is allocated: a sixel string of `!99999~` is a dozen bytes asking
 * for a picture wider than any screen, and the renderer would otherwise try to
 * allocate it.
 */

export const MAX_SIXEL_SIDE = 4096;

export interface Pixels {
  width: number;
  height: number;
  /** RGBA, row-major, `width * height * 4` bytes. */
  rgba: Uint8ClampedArray;
}

/** The VT340's sixteen, which a sixel that defines no colours is drawn in. */
const VT340: ReadonlyArray<readonly [number, number, number]> = [
  [0, 0, 0],
  [20, 20, 80],
  [80, 13, 13],
  [20, 80, 20],
  [80, 20, 80],
  [20, 80, 80],
  [80, 80, 20],
  [53, 53, 53],
  [26, 26, 26],
  [33, 33, 60],
  [60, 26, 26],
  [33, 60, 33],
  [60, 33, 60],
  [33, 60, 60],
  [60, 60, 33],
  [80, 80, 80],
];

const REGISTERS = 1024;

/** Percent (0–100) to a byte. */
const pct = (v: number): number => Math.round((Math.min(100, Math.max(0, v)) * 255) / 100);

/**
 * DEC's HLS to RGB. DEC's hue wheel starts at blue where everyone else's starts
 * at red — 0° blue, 120° red, 240° green — so it is turned by 240° first.
 */
function hls(h: number, l: number, s: number): [number, number, number] {
  const hue = (((h + 240) % 360) + 360) % 360;
  const light = Math.min(100, Math.max(0, l)) / 100;
  const sat = Math.min(100, Math.max(0, s)) / 100;
  const c = (1 - Math.abs(2 * light - 1)) * sat;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = light - c / 2;
  const [r, g, b] =
    hue < 60 ? [c, x, 0] : hue < 120 ? [x, c, 0] : hue < 180 ? [0, c, x] : hue < 240 ? [0, x, c] : hue < 300 ? [x, 0, c] : [c, 0, x];
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

/** Read a run of digits from `data[i]`; `[value or null, next index]`. */
function number(data: string, i: number): [number | null, number] {
  let v = 0;
  let any = false;
  while (i < data.length) {
    const c = data.charCodeAt(i);
    if (c < 0x30 || c > 0x39) break;
    v = v * 10 + (c - 0x30);
    if (v > 1e7) v = 1e7;
    any = true;
    i += 1;
  }
  return [any ? v : null, i];
}

/** `n;n;n…` from `data[i]`, stopping at the first character that is neither. */
function numbers(data: string, i: number): [Array<number | null>, number] {
  const out: Array<number | null> = [];
  for (;;) {
    const [v, next] = number(data, i);
    out.push(v);
    i = next;
    if (data[i] !== ';') break;
    i += 1;
  }
  return [out, i];
}

/**
 * Walk the data once, calling `put(x, y6, bits, colour)` for every sixel drawn.
 * Shared by the measuring pass and the drawing pass, so the two cannot disagree
 * about where a pixel is.
 */
function walk(
  data: string,
  on: {
    raster?: (width: number, height: number) => void;
    colour?: (register: number, rgb: [number, number, number]) => void;
    put: (x: number, band: number, bits: number, count: number, register: number) => void;
  },
): void {
  let x = 0;
  let band = 0;
  let register = 0;
  let i = 0;
  while (i < data.length) {
    const ch = data[i]!;
    const code = data.charCodeAt(i);
    if (code >= 0x3f && code <= 0x7e) {
      on.put(x, band, code - 0x3f, 1, register);
      x += 1;
      i += 1;
    } else if (ch === '!') {
      const [count, next] = number(data, i + 1);
      i = next;
      const c = data.charCodeAt(i);
      if (c >= 0x3f && c <= 0x7e) {
        const n = Math.max(1, count ?? 1);
        on.put(x, band, c - 0x3f, n, register);
        x += n;
        i += 1;
      }
    } else if (ch === '#') {
      const [params, next] = numbers(data, i + 1);
      i = next;
      const pc = Math.min(REGISTERS - 1, params[0] ?? 0);
      if (params.length >= 5) {
        const [, pu, px, py, pz] = params;
        const rgb = pu === 1 ? hls(px ?? 0, py ?? 0, pz ?? 0) : ([pct(px ?? 0), pct(py ?? 0), pct(pz ?? 0)] as [number, number, number]);
        on.colour?.(pc, rgb);
      }
      register = pc;
    } else if (ch === '"') {
      const [params, next] = numbers(data, i + 1);
      i = next;
      on.raster?.(params[2] ?? 0, params[3] ?? 0);
    } else if (ch === '$') {
      x = 0;
      i += 1;
    } else if (ch === '-') {
      x = 0;
      band += 1;
      i += 1;
    } else {
      // Whitespace, line breaks a producer wrapped the data with, and anything
      // the format does not define: skipped, as a VT340 skipped them.
      i += 1;
    }
  }
}

/** Decode a sixel's data (what followed `q`). `null` for one with nothing drawn. */
export function decodeSixel(data: string): Pixels | null {
  // Pass one: the size. The raster attributes say it, but are optional and
  // sometimes wrong, so what the data actually reaches counts too.
  let width = 0;
  let height = 0;
  walk(data, {
    raster: (w, h) => {
      width = Math.max(width, w);
      height = Math.max(height, h);
    },
    put: (x, band, bits, count) => {
      if (bits === 0) return;
      width = Math.max(width, x + count);
      // The lowest bit set in this sixel is how far down it reaches.
      let bottom = 0;
      for (let b = 5; b >= 0; b -= 1) {
        if ((bits & (1 << b)) !== 0) {
          bottom = b + 1;
          break;
        }
      }
      height = Math.max(height, band * 6 + bottom);
    },
  });
  if (width === 0 || height === 0) return null;
  width = Math.min(width, MAX_SIXEL_SIDE);
  height = Math.min(height, MAX_SIXEL_SIDE);

  const palette = new Uint8Array(REGISTERS * 3);
  for (let k = 0; k < REGISTERS; k += 1) {
    const [r, g, b] = VT340[k % VT340.length]!;
    palette[k * 3] = pct(r);
    palette[k * 3 + 1] = pct(g);
    palette[k * 3 + 2] = pct(b);
  }
  const rgba = new Uint8ClampedArray(width * height * 4);
  walk(data, {
    colour: (register, [r, g, b]) => {
      palette[register * 3] = r;
      palette[register * 3 + 1] = g;
      palette[register * 3 + 2] = b;
    },
    put: (x0, band, bits, count, register) => {
      if (bits === 0) return;
      const r = palette[register * 3]!;
      const g = palette[register * 3 + 1]!;
      const b = palette[register * 3 + 2]!;
      const end = Math.min(width, x0 + count);
      for (let bit = 0; bit < 6; bit += 1) {
        if ((bits & (1 << bit)) === 0) continue;
        const y = band * 6 + bit;
        if (y >= height) break;
        for (let x = x0; x < end; x += 1) {
          const p = (y * width + x) * 4;
          rgba[p] = r;
          rgba[p + 1] = g;
          rgba[p + 2] = b;
          rgba[p + 3] = 255;
        }
      }
    },
  });
  return { width, height, rgba };
}
