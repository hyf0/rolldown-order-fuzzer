const UINT32_RANGE = 0x1_0000_0000;

export class SeededRng {
  readonly #initialSeed: number;
  #state: number;

  constructor(seed: number) {
    if (!Number.isInteger(seed) || seed < 0 || seed >= UINT32_RANGE) {
      throw new Error("seed must be an unsigned 32-bit integer");
    }

    this.#initialSeed = seed;
    this.#state = seed;
  }

  get seed(): number {
    return this.#initialSeed;
  }

  nextUint32(): number {
    this.#state = (this.#state + 0x9e37_79b9) >>> 0;
    let value = this.#state;
    value = Math.imul(value ^ (value >>> 16), 0x21f0_aaad);
    value = Math.imul(value ^ (value >>> 15), 0x735a_2d97);
    return (value ^ (value >>> 15)) >>> 0;
  }

  integer(maxExclusive: number): number {
    if (!Number.isSafeInteger(maxExclusive) || maxExclusive <= 0) {
      throw new Error("maxExclusive must be a positive safe integer");
    }

    return Math.floor((this.nextUint32() / UINT32_RANGE) * maxExclusive);
  }

  boolean(): boolean {
    return (this.nextUint32() & 1) === 1;
  }

  pick<T>(values: readonly T[]): T {
    if (values.length === 0) {
      throw new Error("cannot pick from an empty array");
    }

    return values[this.integer(values.length)] as T;
  }
}
