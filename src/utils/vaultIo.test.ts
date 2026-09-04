/**
 * Tests for the vault's byte handling.
 *
 * Only the pure half is testable here — the rest of `vaultIo` talks to six
 * IndexedDB databases that do not exist in node. That is fine, because the pure
 * half is where the interesting bug lives:
 *
 *     btoa(String.fromCharCode(...new Uint8Array(buf)))
 *
 * is the one-liner every base64 helper starts as, and it throws
 * `RangeError: Maximum call stack size exceeded` somewhere around 100KB,
 * because every byte becomes an argument and arguments are stack slots. Scene
 * art is measured in megabytes. A backup feature that crashes on the first
 * image in the library is worse than not having one, and it would pass every
 * test written with a short string.
 *
 * So the tests here run real megabyte-scale buffers through it.
 *
 * Run: npx tsx src/utils/vaultIo.test.ts
 */

import { base64ToBytes, bytesToBase64 } from './vaultIo';

let passed = 0;
let failed = 0;

const eq = (got: unknown, want: unknown, what: string) => {
  const a = JSON.stringify(got);
  const b = JSON.stringify(want);
  if (a === b) { passed++; return; }
  failed++;
  console.error(`✗ ${what}\n    got  ${a}\n    want ${b}`);
};
const ok = (cond: boolean, what: string) => eq(!!cond, true, what);

const bytes = (...n: number[]) => new Uint8Array(n).buffer;
const same = (a: ArrayBuffer, b: ArrayBuffer) => {
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  if (x.length !== y.length) return false;
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
};

/* ------------------------------------------------------------------ */
/* The round trip                                                      */
/* ------------------------------------------------------------------ */

{
  const buf = bytes(0, 1, 2, 250, 255, 128, 64);
  ok(same(base64ToBytes(bytesToBase64(buf)), buf), 'a short buffer round-trips');
}

{
  // Every byte value, so no single value is mishandled.
  const all = new Uint8Array(256);
  for (let i = 0; i < 256; i++) all[i] = i;
  ok(same(base64ToBytes(bytesToBase64(all.buffer)), all.buffer),
    'all 256 byte values round-trip');
}

{
  eq(bytesToBase64(new ArrayBuffer(0)), '', 'an empty buffer encodes to an empty string');
  eq(base64ToBytes('').byteLength, 0, 'and back to an empty buffer');
}

{
  // base64 pads in threes; the boundaries are where an off-by-one shows up.
  for (const n of [1, 2, 3, 4, 5, 6, 7]) {
    const buf = new Uint8Array(n).map((_, i) => (i * 37) % 256).buffer;
    ok(same(base64ToBytes(bytesToBase64(buf)), buf), `${n} byte(s) round-trip`);
  }
}

/* ------------------------------------------------------------------ */
/* The size that breaks the naive version                              */
/* ------------------------------------------------------------------ */

{
  /**
   * The reason this helper is chunked.
   *
   * 100KB is roughly where `String.fromCharCode(...bytes)` starts throwing.
   * These sizes bracket that and go well past it, at exactly the scale a real
   * scene image sits.
   */
  for (const size of [64 * 1024, 100 * 1024, 128 * 1024, 1024 * 1024]) {
    const src = new Uint8Array(size);
    for (let i = 0; i < size; i++) src[i] = (i * 31 + (i >> 8)) % 256;

    let threw = '';
    let round: ArrayBuffer | null = null;
    try {
      round = base64ToBytes(bytesToBase64(src.buffer));
    } catch (e: any) {
      threw = String(e?.message ?? e);
    }

    eq(threw, '', `${size / 1024}KB encodes without blowing the stack`);
    ok(!!round && same(round, src.buffer), `${size / 1024}KB round-trips byte for byte`);
  }
}

{
  // One buffer bigger than any single scene image, to be sure the chunk loop
  // has no boundary problem when it runs many times.
  const size = 4 * 1024 * 1024;
  const src = new Uint8Array(size);
  for (let i = 0; i < size; i += 1024) src[i] = 0xAB;
  src[size - 1] = 0xCD;

  const round = base64ToBytes(bytesToBase64(src.buffer));
  eq(round.byteLength, size, '4MB survives with its length intact');
  eq(new Uint8Array(round)[size - 1], 0xCD, 'and its very last byte, where a chunk loop would drop one');
}

{
  /**
   * A buffer whose length is an exact multiple of the chunk size.
   *
   * The classic chunking bug: a loop that stops one chunk early, or emits an
   * empty final chunk, is invisible at every other length.
   */
  const CHUNK = 0x8000;
  for (const size of [CHUNK, CHUNK * 2, CHUNK * 3]) {
    const src = new Uint8Array(size);
    src[0] = 1;
    src[size - 1] = 2;
    const round = base64ToBytes(bytesToBase64(src.buffer));
    eq(round.byteLength, size, `an exact multiple of the chunk size (${size}) keeps its length`);
    eq(new Uint8Array(round)[size - 1], 2, 'and its final byte');
  }
}

/* ------------------------------------------------------------------ */
/* The encoding itself                                                 */
/* ------------------------------------------------------------------ */

{
  // Against known values, so this is checked against base64 and not just
  // against its own inverse — a symmetric pair of bugs would pass every
  // round-trip test above.
  eq(bytesToBase64(bytes(77, 97, 110)), 'TWFu', '"Man" encodes to the canonical TWFu');
  eq(bytesToBase64(bytes(0)), 'AA==', 'a single zero byte pads correctly');
  eq(bytesToBase64(bytes(255, 255, 255)), '////', 'high bytes encode correctly');
  ok(same(base64ToBytes('TWFu'), bytes(77, 97, 110)), 'and decoding matches');
}

{
  // No data: prefix — the format stores raw base64 and adds the prefix only
  // where an <img> needs one. A prefix leaking in would corrupt every image.
  const encoded = bytesToBase64(bytes(1, 2, 3));
  ok(!encoded.includes(','), 'the encoding carries no data: prefix');
  ok(!encoded.startsWith('data:'), 'nor any scheme at all');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
