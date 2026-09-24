import { describe, expect, it } from 'vitest';
import { collectRefs, parseCellInput, parseExpr, ParseError } from './parser';

describe('解析器：运算优先级', () => {
  it('乘除优先于加减', () => {
    // 2+3*4 = 14，而不是 20
    const ast = parseExpr('2+3*4');
    expect(ast).toMatchObject({
      kind: 'binary',
      op: '+',
      right: { kind: 'binary', op: '*' },
    });
  });

  it('括号改变优先级', () => {
    const ast = parseExpr('(2+3)*4');
    expect(ast).toMatchObject({
      kind: 'binary',
      op: '*',
      left: { kind: 'binary', op: '+' },
    });
  });

  it('同级从左到右', () => {
    const ast = parseExpr('10-2-3');
    expect(ast).toMatchObject({
      kind: 'binary',
      op: '-',
      left: { kind: 'binary', op: '-' },
      right: { kind: 'int', value: 3n },
    });
    expect(parseExpr('8/4/2')).toMatchObject({
      kind: 'binary',
      op: '/',
      right: { kind: 'int', value: 2n },
    });
  });

  it('复杂混合表达式 AST 结构', () => {
    expect(parseExpr('A1*B2+C3/(D4-E5)')).toBeDefined();
  });
});

describe('解析器：一元负号', () => {
  it('一元负号优先级高于乘除：-2*3', () => {
    const ast = parseExpr('-2*3');
    expect(ast).toMatchObject({
      kind: 'binary',
      op: '*',
      left: { kind: 'unary', operand: { kind: 'int', value: 2n } },
    });
  });

  it('双重负号', () => {
    const ast = parseExpr('--5');
    expect(ast).toMatchObject({
      kind: 'unary',
      operand: { kind: 'unary', operand: { kind: 'int', value: 5n } },
    });
  });

  it('括号前的负号', () => {
    expect(parseExpr('-(2+3)')).toMatchObject({ kind: 'unary' });
  });

  it('负引用 -A1', () => {
    expect(parseExpr('-A1')).toMatchObject({
      kind: 'unary',
      operand: { kind: 'ref', addr: 'A1' },
    });
  });

  it('不支持一元正号', () => {
    expect(() => parseExpr('+1')).toThrow(ParseError);
  });
});

describe('解析器：引用与范围', () => {
  it('接受 A1..T20，小写归一为大写', () => {
    const ast = parseExpr('a1+t20');
    expect(collectRefs(ast)).toEqual(['A1', 'T20']);
  });

  it('拒绝超出范围的引用', () => {
    expect(() => parseExpr('U1')).toThrow(/A1..T20/);
    expect(() => parseExpr('A21')).toThrow(/A1..T20/);
    expect(() => parseExpr('A0')).toThrow();
    expect(() => parseExpr('AA1')).toThrow();
  });
});

describe('解析器：拒绝函数、范围和非法字符', () => {
  it('SUM 函数被拒绝', () => {
    expect(() => parseExpr('SUM(A1:A3)')).toThrow();
  });
  it('冒号范围被拒绝', () => {
    expect(() => parseExpr('A1:A3')).toThrow();
  });
  it('小数被拒绝', () => {
    expect(() => parseExpr('1.5')).toThrow(/整数/);
  });
  it('非法字符', () => {
    expect(() => parseExpr('2 ^ 3')).toThrow(/非法字符/);
  });
  it('空公式与括号不匹配', () => {
    expect(() => parseExpr('')).toThrow();
    expect(() => parseExpr('(1+2')).toThrow(/括号/);
    expect(() => parseExpr('1+2)')).toThrow(/括号/);
  });
});

describe('parseCellInput', () => {
  it('空、整数、公式', () => {
    expect(parseCellInput('   ').kind).toBe('empty');
    expect(parseCellInput('42')).toMatchObject({ kind: 'number', value: 42n });
    expect(parseCellInput('-7')).toMatchObject({ kind: 'number', value: -7n });
    expect(parseCellInput('=A1+1').kind).toBe('formula');
  });
  it('拒绝小数、文字和错误公式', () => {
    expect(() => parseCellInput('3.14')).toThrow();
    expect(() => parseCellInput('hello')).toThrow();
    expect(() => parseCellInput('=')).toThrow();
  });
});
