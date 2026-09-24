import { normalizeRef, type Addr } from './cells';

/* ------------------------------- AST ------------------------------- */

export type Expr =
  | { kind: 'int'; value: bigint }
  | { kind: 'ref'; addr: Addr }
  | { kind: 'unary'; op: '-'; operand: Expr }
  | { kind: 'binary'; op: '+' | '-' | '*' | '/'; left: Expr; right: Expr };

/* ----------------------------- 词法单元 ----------------------------- */

type TokenType = 'int' | 'ref' | 'op' | 'lparen' | 'rparen';
interface Token {
  type: TokenType;
  text: string;
  pos: number;
}

/* ------------------------------ 错误 ------------------------------ */

export class ParseError extends Error {
  /** 0 起的字符位置（面向用户时 +1） */
  readonly pos: number;
  constructor(message: string, pos: number) {
    super(message);
    this.name = 'ParseError';
    this.pos = pos;
  }
}

/* ----------------------------- 词法分析 ----------------------------- */

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const c = input[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i++;
      continue;
    }
    if (c >= '0' && c <= '9') {
      const start = i;
      while (i < input.length && input[i] >= '0' && input[i] <= '9') i++;
      tokens.push({ type: 'int', text: input.slice(start, i), pos: start });
      continue;
    }
    if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z')) {
      const start = i;
      i++;
      while (i < input.length && input[i] >= '0' && input[i] <= '9') i++;
      const text = input.slice(start, i);
      const addr = normalizeRef(text);
      if (!addr) {
        throw new ParseError(
          /^[A-Ta-t]/.test(text)
            ? `引用 ${text.toUpperCase()} 超出 A1..T20 范围`
            : `不允许的名称或函数 “${text}”（仅支持 A1..T20 引用，不支持函数）`,
          start,
        );
      }
      tokens.push({ type: 'ref', text: addr, pos: start });
      continue;
    }
    if (c === '+' || c === '-' || c === '*' || c === '/') {
      tokens.push({ type: 'op', text: c, pos: i });
      i++;
      continue;
    }
    if (c === '(') {
      tokens.push({ type: 'lparen', text: c, pos: i });
      i++;
      continue;
    }
    if (c === ')') {
      tokens.push({ type: 'rparen', text: c, pos: i });
      i++;
      continue;
    }
    if (c === '.') {
      throw new ParseError('只允许整数，不允许小数', i);
    }
    throw new ParseError(`非法字符 “${c}”`, i);
  }
  return tokens;
}

/* --------------------------- 递归下降解析 --------------------------- */
/*
 * 文法（一元负号优先级高于乘除）：
 *   expr   := term (('+'|'-') term)*
 *   term   := factor (('*'|'/') factor)*
 *   factor := '-' factor | atom
 *   atom   := INT | REF | '(' expr ')'
 */

class Parser {
  private pos = 0;
  constructor(private readonly tokens: Token[]) {}

  parse(): Expr {
    const e = this.expr();
    if (this.pos < this.tokens.length) {
      const t = this.tokens[this.pos];
      throw new ParseError(
        t.type === 'rparen' ? '括号不匹配：多余的 “)”' : `表达式后存在多余内容 “${t.text}”`,
        t.pos,
      );
    }
    return e;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private expr(): Expr {
    let left = this.term();
    for (;;) {
      const t = this.peek();
      if (t && t.type === 'op' && (t.text === '+' || t.text === '-')) {
        this.pos++;
        const right = this.term();
        left = { kind: 'binary', op: t.text as '+' | '-', left, right };
      } else {
        return left;
      }
    }
  }

  private term(): Expr {
    let left = this.factor();
    for (;;) {
      const t = this.peek();
      if (t && t.type === 'op' && (t.text === '*' || t.text === '/')) {
        this.pos++;
        const right = this.factor();
        left = { kind: 'binary', op: t.text as '*' | '/', left, right };
      } else {
        return left;
      }
    }
  }

  private factor(): Expr {
    const t = this.peek();
    if (!t) throw new ParseError('公式不完整：此处应有数字或引用', 0);
    if (t.type === 'op' && t.text === '-') {
      this.pos++;
      return { kind: 'unary', op: '-', operand: this.factor() };
    }
    if (t.type === 'op' && t.text === '+') {
      throw new ParseError('不支持一元正号 “+”，数字直接书写即可', t.pos);
    }
    if (t.type === 'op') {
      throw new ParseError(`运算符 “${t.text}” 前缺少操作数`, t.pos);
    }
    return this.atom();
  }

  private atom(): Expr {
    const t = this.peek();
    if (!t) throw new ParseError('公式不完整：此处应有数字或引用', 0);
    if (t.type === 'int') {
      this.pos++;
      return { kind: 'int', value: BigInt(t.text) };
    }
    if (t.type === 'ref') {
      this.pos++;
      return { kind: 'ref', addr: t.text as Addr };
    }
    if (t.type === 'lparen') {
      this.pos++;
      const inner = this.expr();
      const close = this.peek();
      if (!close || close.type !== 'rparen') {
        throw new ParseError('括号不匹配：缺少 “)”', t.pos);
      }
      this.pos++;
      return inner;
    }
    if (t.type === 'rparen') {
      throw new ParseError('括号不匹配：多余的 “)”', t.pos);
    }
    throw new ParseError(`此处不应出现 “${t.text}”`, t.pos);
  }
}

/* ------------------------------ 单元格输入 ------------------------------ */

export type ParsedCell =
  | { kind: 'empty' }
  | { kind: 'number'; value: bigint; expr: Expr }
  | { kind: 'formula'; expr: Expr };

/**
 * 解析一格的原始输入文本。
 * 空（或纯空白）=> empty；“=” 开头 => 公式；否则必须是整数（可带一元负号）。
 */
export function parseCellInput(raw: string): ParsedCell {
  if (raw.trim() === '') return { kind: 'empty' };
  if (raw.startsWith('=')) {
    const body = raw.slice(1);
    if (body.trim() === '') {
      throw new ParseError('“=” 后缺少表达式', 1);
    }
    return { kind: 'formula', expr: parseExpr(body) };
  }
  if (!/^\s*-?\d+\s*$/.test(raw)) {
    throw new ParseError('单元格必须为空、整数或以 = 开头的公式', 0);
  }
  const value = BigInt(raw.trim());
  return { kind: 'number', value, expr: { kind: 'int', value } };
}

/** 解析 “=” 之后的表达式 */
export function parseExpr(body: string): Expr {
  const tokens = tokenize(body);
  if (tokens.length === 0) {
    throw new ParseError('公式为空', 0);
  }
  return new Parser(tokens).parse();
}

/** 收集表达式中的直接引用（去重、保持出现顺序） */
export function collectRefs(expr: Expr): Addr[] {
  const out: Addr[] = [];
  const walk = (e: Expr): void => {
    switch (e.kind) {
      case 'int':
        return;
      case 'ref':
        if (!out.includes(e.addr)) out.push(e.addr);
        return;
      case 'unary':
        walk(e.operand);
        return;
      case 'binary':
        walk(e.left);
        walk(e.right);
        return;
    }
  };
  walk(expr);
  return out;
}
