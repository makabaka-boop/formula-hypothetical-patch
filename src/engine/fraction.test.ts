import { describe, expect, it } from 'vitest';
import { Fraction, repeatingDecimal } from './fraction';

describe('Fraction 约分与四则', () => {
  it('构造时自动约分并统一分母符号', () => {
    const f = new Fraction(6n, -9n);
    expect(f.numer).toBe(-2n);
    expect(f.den).toBe(3n);
  });

  it('加减乘除保持精确分数', () => {
    const a = new Fraction(1n, 3n);
    const b = new Fraction(1n, 6n);
    expect(a.add(b).toExactString()).toBe('1/2');
    expect(a.sub(b).toExactString()).toBe('1/6');
    expect(a.mul(b).toExactString()).toBe('1/18');
    expect(a.div(b).toExactString()).toBe('2');
  });

  it('除以零分数抛出 ZeroDivision', () => {
    expect(() => new Fraction(1n).div(Fraction.ZERO)).toThrow();
  });

  it('负号', () => {
    expect(new Fraction(3n, 4n).negate().toExactString()).toBe('-3/4');
  });

  it('循环小数表示', () => {
    expect(repeatingDecimal(1n, 3n)).toBe('0.(3)');
    expect(repeatingDecimal(1n, 6n)).toBe('0.1(6)');
    expect(repeatingDecimal(1n, 2n)).toBe('0.5');
    expect(repeatingDecimal(-1n, 7n)).toBe('-0.(142857)');
  });

  it('BigInt 大整数不丢精度', () => {
    const big = new Fraction(123456789012345678901234567890n);
    expect(big.toExactString()).toBe('123456789012345678901234567890');
  });
});
