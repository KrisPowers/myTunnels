// The small puzzle a browser solves before a sign-in: a number that, hashed with
// the server's one-time challenge, starts with enough zero bits. Solved while the
// person types, so they never wait; a bot guessing passwords pays it every try.

export interface Challenge { seed: string; bits: number }
export interface Proof { seed: string; nonce: string }

function zeroBits(hash: Uint8Array) {
  let bits = 0;
  for (const byte of hash) {
    if (byte === 0) {
      bits += 8;
      continue;
    }
    return bits + Math.clz32(byte) - 24;
  }
  return bits;
}

export async function solve(c: Challenge): Promise<Proof> {
  const text = new TextEncoder();
  for (let start = 0; ; start += 1024) {
    const hashes = await Promise.all(
      Array.from({ length: 1024 }, (_, i) => crypto.subtle.digest("SHA-256", text.encode(`${c.seed}:${start + i}`))),
    );
    const found = hashes.findIndex((h) => zeroBits(new Uint8Array(h)) >= c.bits);
    if (found >= 0) return { seed: c.seed, nonce: String(start + found) };
  }
}
