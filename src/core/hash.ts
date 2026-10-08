// FNV-1a 64-bit (BigInt-free: two 32-bit halves), hex encoded.

export function fnv1a64(input: string): string {
  // offset basis 0xcbf29ce484222325, prime 0x100000001b3
  let h0 = 0x2325;
  let h1 = 0x8422;
  let h2 = 0x9ce4;
  let h3 = 0xcbf2;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    // xor the low byte(s); handle UTF-16 code units as two bytes when needed
    h0 ^= c & 0xff;
    [h0, h1, h2, h3] = mulPrime(h0, h1, h2, h3);
    if (c > 0xff) {
      h0 ^= c >>> 8;
      [h0, h1, h2, h3] = mulPrime(h0, h1, h2, h3);
    }
  }
  return [h3, h2, h1, h0].map(x => x.toString(16).padStart(4, '0')).join('');
}

// Multiply the 64-bit value (16-bit limbs, little endian) by 0x100000001b3 mod 2^64.
function mulPrime(a0: number, a1: number, a2: number, a3: number): [number, number, number, number] {
  // prime limbs: 0x01b3, 0x0000, 0x0100, 0x0000
  const p0 = 0x01b3;
  const p2 = 0x0100;
  let r0 = a0 * p0;
  let r1 = a1 * p0;
  let r2 = a2 * p0 + a0 * p2;
  let r3 = a3 * p0 + a1 * p2;
  r1 += r0 >>> 16;
  r0 &= 0xffff;
  r2 += r1 >>> 16;
  r1 &= 0xffff;
  r3 += r2 >>> 16;
  r2 &= 0xffff;
  r3 &= 0xffff;
  return [r0, r1, r2, r3];
}

/** Short, URL-safe id for a (position, move) pair. */
export function shortId(posKey: string, move: string): string {
  return fnv1a64(`${posKey}|${move}`).slice(0, 10);
}
