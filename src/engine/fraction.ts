/**
 * 约分后的任意精度有理分数。
 * 内部约定：den > 0；numer/den 始终用最大公约数约分。
 */
export class Fraction {
  readonly numer: bigint;
  readonly den: bigint;

  constructor(numer: bigint, den: bigint = 1n) {
    if (den === 0n) throw new Error('零分母不能构造 Fraction');
    let n = numer;
    let d = den;
    if (d < 0n) {
      n = -n;
      d = -d;
    }
    const g = gcd(n < 0n ? -n : n, d);
    this.numer = n / g;
    this.den = d / g;
  }

  static ZERO = new Fraction(0n);
  static ONE = new Fraction(1n);

  add(o: Fraction): Fraction {
    return new Fraction(this.numer * o.den + o.numer * this.den, this.den * o.den);
  }

  sub(o: Fraction): Fraction {
    return new Fraction(this.numer * o.den - o.numer * this.den, this.den * o.den);
  }

  mul(o: Fraction): Fraction {
    return new Fraction(this.numer * o.numer, this.den * o.den);
  }

  div(o: Fraction): Fraction {
    if (o.numer === 0n) throw new ZeroDivision();
    return new Fraction(this.numer * o.den, this.den * o.numer);
  }

  negate(): Fraction {
    return new Fraction(-this.numer, this.den);
  }

  isZero(): boolean {
    return this.numer === 0n;
  }

  isInteger(): boolean {
    return this.den === 1n;
  }

  /** "p/q"（整数则 "p"），BigInt 保证无精度损失 */
  toExactString(): string {
    return this.den === 1n ? this.numer.toString() : `${this.numer}/${this.den}`;
  }

  /**
   * 供网格显示的紧凑十进制：
   * 整除直接显示；否则尝试找循环小数，最长展开 1000 位，
   * 超出预算时退化为 8 位有效小数 + 省略号（精确值仍可在检查器查看）。
   */
  toDisplayString(): string {
    if (this.den === 1n) return this.numer.toString();
    return repeatingDecimal(this.numer, this.den);
  }

  /** 导出用：{ n: 分子字符串, d: 分母字符串 } */
  toJSON(): { n: string; d: string } {
    return { n: this.numer.toString(), d: this.den.toString() };
  }
}

/** 求值阶段除零（分数构造不抛出此异常） */
export class ZeroDivision extends Error {
  constructor() {
    super('#DIV/0!');
    this.name = 'ZeroDivision';
  }
}

function gcd(a: bigint, b: bigint): bigint {
  let x = a;
  let y = b;
  while (y !== 0n) {
    [x, y] = [y, x % y];
  }
  return x === 0n ? 1n : x;
}

/**
 * 长除法求（循环）小数。
 * 余数重复 => 找到循环节；预算用尽 => 截断并标注 ≈。
 */
export function repeatingDecimal(numer: bigint, den: bigint): string {
  const neg = numer < 0n;
  let rem = numer < 0n ? -numer : numer;
  const intPart = rem / den;
  rem %= den;

  if (rem === 0n) return (neg ? '-' : '') + intPart.toString();

  const seen = new Map<bigint, number>(); // 余数 -> 小数位索引
  const digits: number[] = [];
  const MAX_DIGITS = 1000;

  while (rem !== 0n && !seen.has(rem)) {
    if (digits.length >= MAX_DIGITS) {
      const approx = `${neg ? '-' : ''}${intPart}.${digits.slice(0, 8).join('')}…`;
      return approx;
    }
    seen.set(rem, digits.length);
    rem *= 10n;
    digits.push(Number(rem / den));
    rem %= den;
  }

  if (rem === 0n) {
    return `${neg ? '-' : ''}${intPart}.${digits.join('')}`;
  }
  const cycleStart = seen.get(rem)!;
  const nonRep = digits.slice(0, cycleStart).join('');
  const rep = digits.slice(cycleStart).join('');
  return `${neg ? '-' : ''}${intPart}.${nonRep}(${rep})`;
}
