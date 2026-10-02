// Mulberry32 is small, deterministic, and sufficient for reproducible game choices.
export class SeededRandom {
  constructor(seed = Date.now()) {
    this.seed = Number(seed) >>> 0;
    this.state = this.seed;
  }

  next() {
    let t = (this.state += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  int(max) {
    if (!Number.isInteger(max) || max <= 0) throw new Error("max must be positive");
    return Math.floor(this.next() * max);
  }

  pick(items) {
    if (!items.length) return null;
    return items[this.int(items.length)];
  }

  shuffle(items) {
    const result = [...items];
    for (let i = result.length - 1; i > 0; i -= 1) {
      const j = this.int(i + 1);
      [result[i], result[j]] = [result[j], result[i]];
    }
    return result;
  }

  snapshot() { return { seed: this.seed, state: this.state }; }
  restore(snapshot) { this.seed = snapshot.seed; this.state = snapshot.state; }
}
