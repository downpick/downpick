import { ObjectId, Decimal128, Long, Int32, Double, Timestamp } from 'mongodb';

export interface ParsedCall {
  method: string;
  args: unknown[];
}

export interface ParsedShellQuery {
  collection: string;
  calls: ParsedCall[];
}

// Hand-written recursive-descent parser for MongoDB shell-style query text, e.g.
//   db.users.find({age:{$gt:18}}).sort({name:1}).limit(20)
// Deliberately does NOT use eval/Function — the grammar below is a relaxed-JSON
// superset (unquoted keys, single-quoted strings, and a handful of BSON
// constructors) rather than arbitrary JavaScript.
class ShellParser {
  private pos = 0;

  constructor(private readonly text: string) {}

  parse(): ParsedShellQuery {
    this.skipWs();
    this.expectLiteral('db');
    const collection = this.parseCollectionRef();

    const calls: ParsedCall[] = [];
    this.skipWs();
    while (this.peek() === '.') {
      this.pos++;
      const method = this.parseIdentifier();
      this.skipWs();
      this.expectChar('(');
      const args = this.parseArgList(')');
      this.expectChar(')');
      calls.push({ method, args });
      this.skipWs();
    }

    // Allow a single trailing semicolon and trailing whitespace.
    if (this.peek() === ';') this.pos++;
    this.skipWs();
    if (this.pos < this.text.length) {
      this.fail(`Unexpected trailing text: ${this.text.slice(this.pos, this.pos + 30)}`);
    }
    if (calls.length === 0) {
      this.fail('Expected at least one method call, e.g. db.<collection>.find({...})');
    }

    return { collection, calls };
  }

  // Parses the collection reference right after "db":
  //   .name              .getCollection("name")            ["name"]
  private parseCollectionRef(): string {
    this.skipWs();
    if (this.peek() === '[') {
      this.pos++;
      this.skipWs();
      const name = this.parseString();
      this.skipWs();
      this.expectChar(']');
      return name;
    }
    this.expectChar('.');
    const first = this.parseIdentifier();
    if (first === 'getCollection') {
      this.skipWs();
      this.expectChar('(');
      this.skipWs();
      const name = this.parseString();
      this.skipWs();
      this.expectChar(')');
      return name;
    }
    return first;
  }

  private parseArgList(endChar: string): unknown[] {
    const args: unknown[] = [];
    this.skipWs();
    if (this.peek() === endChar) return args;
    args.push(this.parseValue());
    this.skipWs();
    while (this.peek() === ',') {
      this.pos++;
      this.skipWs();
      args.push(this.parseValue());
      this.skipWs();
    }
    return args;
  }

  private parseValue(): unknown {
    this.skipWs();
    const c = this.peek();
    if (c === '{') return this.parseObject();
    if (c === '[') return this.parseArray();
    if (c === '"' || c === "'") return this.parseString();
    if (c === '/') return this.parseRegex();
    if (this.matchLiteralAhead('true')) { this.pos += 4; return true; }
    if (this.matchLiteralAhead('false')) { this.pos += 5; return false; }
    if (this.matchLiteralAhead('null')) { this.pos += 4; return null; }
    if (this.matchLiteralAhead('undefined')) { this.pos += 9; return undefined; }
    if (this.matchLiteralAhead('new ')) {
      this.pos += 4;
      return this.parseConstructorCall();
    }
    if (/[A-Za-z_$]/.test(c)) return this.parseConstructorCall();
    if (/[-\d.]/.test(c)) return this.parseNumber();
    this.fail(`Unexpected character '${c}'`);
  }

  private parseObject(): Record<string, unknown> {
    this.expectChar('{');
    const obj: Record<string, unknown> = {};
    this.skipWs();
    if (this.peek() === '}') {
      this.pos++;
      return obj;
    }
    for (;;) {
      this.skipWs();
      const key = this.peek() === '"' || this.peek() === "'"
        ? this.parseString()
        : this.parseObjectKey();
      this.skipWs();
      this.expectChar(':');
      const value = this.parseValue();
      obj[key] = value;
      this.skipWs();
      if (this.peek() === ',') {
        this.pos++;
        this.skipWs();
        // Allow a trailing comma before the closing brace.
        if (this.peek() === '}') break;
        continue;
      }
      break;
    }
    this.skipWs();
    this.expectChar('}');
    return obj;
  }

  private parseArray(): unknown[] {
    this.expectChar('[');
    const arr: unknown[] = [];
    this.skipWs();
    if (this.peek() === ']') {
      this.pos++;
      return arr;
    }
    for (;;) {
      arr.push(this.parseValue());
      this.skipWs();
      if (this.peek() === ',') {
        this.pos++;
        this.skipWs();
        if (this.peek() === ']') break;
        continue;
      }
      break;
    }
    this.skipWs();
    this.expectChar(']');
    return arr;
  }

  // Object keys in shell syntax are frequently unquoted identifiers, but may also be
  // operator-style tokens like $gt or numeric-looking keys — accept anything up to
  // the next ':' (outside of the quoted-string case handled by the caller).
  private parseObjectKey(): string {
    const start = this.pos;
    while (this.pos < this.text.length && /[^\s:]/.test(this.text[this.pos])) {
      this.pos++;
    }
    if (this.pos === start) this.fail('Expected an object key');
    return this.text.slice(start, this.pos);
  }

  private parseIdentifier(): string {
    const start = this.pos;
    while (this.pos < this.text.length && /[A-Za-z0-9_$]/.test(this.text[this.pos])) {
      this.pos++;
    }
    if (this.pos === start) this.fail('Expected an identifier');
    return this.text.slice(start, this.pos);
  }

  private parseString(): string {
    const quote = this.text[this.pos];
    if (quote !== '"' && quote !== "'") this.fail('Expected a string literal');
    this.pos++;
    let out = '';
    while (this.pos < this.text.length && this.text[this.pos] !== quote) {
      const ch = this.text[this.pos];
      if (ch === '\\' && this.pos + 1 < this.text.length) {
        const next = this.text[this.pos + 1];
        const escapes: Record<string, string> = {
          n: '\n', t: '\t', r: '\r', '"': '"', "'": "'", '\\': '\\', '/': '/',
        };
        out += escapes[next] ?? next;
        this.pos += 2;
      } else {
        out += ch;
        this.pos++;
      }
    }
    this.expectChar(quote);
    return out;
  }

  private parseNumber(): number {
    const start = this.pos;
    if (this.peek() === '-') this.pos++;
    while (this.pos < this.text.length && /[\d.eE+-]/.test(this.text[this.pos])) {
      this.pos++;
    }
    const raw = this.text.slice(start, this.pos);
    const num = Number(raw);
    if (Number.isNaN(num)) this.fail(`Invalid number literal '${raw}'`);
    return num;
  }

  private parseRegex(): RegExp {
    this.expectChar('/');
    let pattern = '';
    while (this.pos < this.text.length && this.text[this.pos] !== '/') {
      if (this.text[this.pos] === '\\' && this.pos + 1 < this.text.length) {
        pattern += this.text[this.pos] + this.text[this.pos + 1];
        this.pos += 2;
      } else {
        pattern += this.text[this.pos];
        this.pos++;
      }
    }
    this.expectChar('/');
    const flagsStart = this.pos;
    while (this.pos < this.text.length && /[a-z]/i.test(this.text[this.pos])) this.pos++;
    const flags = this.text.slice(flagsStart, this.pos);
    return new RegExp(pattern, flags);
  }

  // Handles ObjectId("..."), ISODate("..."), new Date("..."), NumberLong(...), NumberInt(...),
  // NumberDecimal("..."), Timestamp(t, i), and bare identifiers used as constructors.
  private parseConstructorCall(): unknown {
    const name = this.parseIdentifier();
    this.skipWs();
    let args: unknown[] = [];
    if (this.peek() === '(') {
      this.pos++;
      args = this.parseArgList(')');
      this.skipWs();
      this.expectChar(')');
    }

    switch (name) {
      case 'ObjectId':
        return args.length > 0 ? new ObjectId(String(args[0])) : new ObjectId();
      case 'ISODate':
      case 'Date':
        return args.length > 0 ? new Date(String(args[0])) : new Date();
      case 'NumberLong':
        return Long.fromString(String(args[0]));
      case 'NumberInt':
        return new Int32(Number(args[0]));
      case 'NumberDecimal':
        return Decimal128.fromString(String(args[0]));
      case 'NumberDouble':
        return new Double(Number(args[0]));
      case 'Timestamp':
        return new Timestamp({ t: Number(args[0]), i: Number(args[1]) });
      default:
        this.fail(`Unsupported constructor '${name}(...)'`);
    }
  }

  private peek(): string {
    return this.pos < this.text.length ? this.text[this.pos] : '';
  }

  private matchLiteralAhead(literal: string): boolean {
    return this.text.startsWith(literal, this.pos) &&
      // Ensure we're not matching a prefix of a longer identifier (e.g. "nullable").
      !/[A-Za-z0-9_$]/.test(this.text[this.pos + literal.length] ?? '');
  }

  private expectLiteral(literal: string) {
    if (!this.text.startsWith(literal, this.pos)) {
      this.fail(`Expected '${literal}'`);
    }
    this.pos += literal.length;
  }

  private expectChar(char: string) {
    if (this.peek() !== char) {
      this.fail(`Expected '${char}' but found '${this.peek() || 'end of input'}'`);
    }
    this.pos++;
  }

  private skipWs() {
    while (this.pos < this.text.length && /\s/.test(this.text[this.pos])) this.pos++;
  }

  private fail(message: string): never {
    throw new Error(`${message} (at position ${this.pos})`);
  }
}

export function parseShellQuery(text: string): ParsedShellQuery {
  const trimmed = text.trim();
  if (!trimmed) throw new Error('Query is empty');
  if (!trimmed.startsWith('db')) {
    throw new Error("MongoDB queries must start with 'db', e.g. db.users.find({})");
  }
  return new ShellParser(trimmed).parse();
}
