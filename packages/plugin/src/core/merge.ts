/**
 * Line-based diff (Myers) and three-way merge (diff3), dependency-free.
 *
 * merge3(base, ours, theirs):
 *   - hunks changed on one side only are taken from that side,
 *   - identical changes on both sides are taken once,
 *   - overlapping different changes are a conflict -> null (caller keeps both files).
 */

/** Split keeping line endings, so a merge reproduces the exact bytes. */
export const splitLines = (text: string): string[] => (text === "" ? [] : text.match(/[^\n]*\n|[^\n]+$/g) ?? []);

/** Pairs [i, j] where a[i] === b[j], forming a longest common subsequence. Null if the diff is too large. */
export const lcsPairs = (a: ReadonlyArray<string>, b: ReadonlyArray<string>, maxD = 4000): Array<[number, number]> | null => {
  // Trim the common prefix and suffix: cheap, and usually most of a note.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const prefix: Array<[number, number]> = Array.from({ length: start }, (_, i) => [i, i]);
  const suffix: Array<[number, number]> = Array.from({ length: a.length - endA }, (_, k) => [endA + k, endB + k]);

  const A = a.slice(start, endA);
  const B = b.slice(start, endB);
  const n = A.length;
  const m = B.length;
  if (n === 0 || m === 0) return [...prefix, ...suffix];

  // Myers' O((N+M)D) greedy algorithm with a trace for backtracking.
  const max = n + m;
  const offset = max;
  const v = new Int32Array(2 * max + 2);
  const trace: Int32Array[] = [];
  let found = -1;
  for (let d = 0; d <= Math.min(max, maxD); d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x =
        k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!) ? v[offset + k + 1]! : v[offset + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && A[x] === B[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        found = d;
        break;
      }
    }
    if (found >= 0) break;
  }
  if (found < 0) return null;

  const pairs: Array<[number, number]> = [];
  let x = n;
  let y = m;
  for (let d = found; d > 0; d--) {
    const vd = trace[d]!;
    const k = x - y;
    const prevK = k === -d || (k !== d && vd[offset + k - 1]! < vd[offset + k + 1]!) ? k + 1 : k - 1;
    const prevX = vd[offset + prevK]!;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      x--;
      y--;
      pairs.push([x + start, y + start]);
    }
    x = prevX;
    y = prevY;
  }
  while (x > 0 && y > 0) {
    x--;
    y--;
    pairs.push([x + start, y + start]);
  }
  return [...prefix, ...pairs.reverse(), ...suffix];
};

export type DiffLine = { readonly kind: "same" | "add" | "del"; readonly text: string };

/** Line diff for display (version history). */
export const diffLines = (before: string, after: string): DiffLine[] | null => {
  const a = splitLines(before);
  const b = splitLines(after);
  const pairs = lcsPairs(a, b);
  if (pairs === null) return null;
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  for (const [pi, pj] of [...pairs, [a.length, b.length] as [number, number]]) {
    while (i < pi) out.push({ kind: "del", text: a[i++]! });
    while (j < pj) out.push({ kind: "add", text: b[j++]! });
    if (pi < a.length) out.push({ kind: "same", text: a[pi]! });
    i = pi + 1;
    j = pj + 1;
  }
  return out;
};

const same = (x: ReadonlyArray<string>, y: ReadonlyArray<string>) => x.length === y.length && x.every((v, i) => v === y[i]);

/** Three-way merge of texts; null when both sides changed the same region differently. */
export const merge3 = (base: string, ours: string, theirs: string): string | null => {
  if (ours === theirs) return ours;
  if (ours === base) return theirs;
  if (theirs === base) return ours;

  const o = splitLines(base);
  const a = splitLines(ours);
  const b = splitLines(theirs);
  const pa = lcsPairs(o, a);
  const pb = lcsPairs(o, b);
  if (pa === null || pb === null) return null;
  const toA = new Map(pa);
  const toB = new Map(pb);

  const out: string[] = [];
  let i = 0;
  let ia = 0;
  let ib = 0;
  const resolve = (oc: string[], ac: string[], bc: string[]) => {
    if (same(ac, oc)) out.push(...bc);
    else if (same(bc, oc)) out.push(...ac);
    else if (same(ac, bc)) out.push(...ac);
    else return false;
    return true;
  };

  for (;;) {
    // Next base line kept by both sides, after the current positions: a stable anchor.
    let k = i;
    while (k < o.length && !(toA.has(k) && toB.has(k) && toA.get(k)! >= ia && toB.get(k)! >= ib)) k++;
    if (k >= o.length) {
      if (!resolve(o.slice(i), a.slice(ia), b.slice(ib))) return null;
      return out.join("");
    }
    const ka = toA.get(k)!;
    const kb = toB.get(k)!;
    if (!resolve(o.slice(i, k), a.slice(ia, ka), b.slice(ib, kb))) return null;
    out.push(o[k]!);
    i = k + 1;
    ia = ka + 1;
    ib = kb + 1;
  }
};

// ---------------------------------------------------------------- engine hook

const TEXT_EXTENSIONS = new Set(["md", "txt"]);
const strict = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

const asText = (bytes: Uint8Array) => {
  try {
    return strict.decode(bytes);
  } catch {
    return null;
  }
};

/** Engine `merge` option: three-way merge for Markdown/plain text. */
export const mergeText = ({
  path,
  base,
  ours,
  theirs,
}: {
  path: string;
  base: Uint8Array | null;
  ours: Uint8Array;
  theirs: Uint8Array;
}): Uint8Array | null => {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  if (!TEXT_EXTENSIONS.has(ext) || base === null) return null;
  const [o, a, b] = [asText(base), asText(ours), asText(theirs)];
  if (o === null || a === null || b === null) return null;
  const merged = merge3(o, a, b);
  return merged === null ? null : new TextEncoder().encode(merged);
};
