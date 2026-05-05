// Subset JSONLogic evaluator for the BranchSimulator preview.
// Supported ops: var (dot-path), + - * /, == != > >= < <=, cat, if, regex_match.
// Throws UnsupportedOpError on anything else; caller catches and renders an error pill.

export class UnsupportedOpError extends Error {
  constructor(op: string) {
    super(`unsupported jsonlogic op: ${op}`);
    this.name = 'UnsupportedOpError';
  }
}

type Ctx = Record<string, unknown>;

export function evaluateRule(rule: unknown, ctx: Ctx): unknown {
  if (rule === null || rule === undefined) return rule;
  if (typeof rule !== 'object') return rule;
  if (Array.isArray(rule)) return rule.map((r) => evaluateRule(r, ctx));

  const obj = rule as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (keys.length !== 1) {
    return obj;
  }
  const op = keys[0];
  const args = obj[op];

  if (op === 'var') {
    const path = typeof args === 'string' ? args : (Array.isArray(args) ? String(args[0] ?? '') : '');
    return resolveVar(path, ctx);
  }

  const list = Array.isArray(args) ? args.map((a) => evaluateRule(a, ctx)) : [evaluateRule(args, ctx)];

  switch (op) {
    case '+': return list.reduce((a, b) => toNum(a) + toNum(b), 0);
    case '-': return list.length === 1 ? -toNum(list[0]) : list.slice(1).reduce((a: number, b) => a - toNum(b), toNum(list[0]));
    case '*': return list.reduce((a, b) => toNum(a) * toNum(b), 1);
    case '/': return list.slice(1).reduce((a: number, b) => a / toNum(b), toNum(list[0]));
    case '==': return list[0] == list[1];
    case '!=': return list[0] != list[1];
    case '>': return toNum(list[0]) > toNum(list[1]);
    case '>=': return toNum(list[0]) >= toNum(list[1]);
    case '<': return toNum(list[0]) < toNum(list[1]);
    case '<=': return toNum(list[0]) <= toNum(list[1]);
    case 'cat': return list.map((v) => v == null ? '' : String(v)).join('');
    case 'if': {
      // Pairs of (cond, then), final fallback. Re-evaluate from raw rule so unmatched branches stay lazy.
      const raw = Array.isArray(args) ? args : [];
      let i = 0;
      while (i + 1 < raw.length) {
        const cond = evaluateRule(raw[i], ctx);
        if (truthy(cond)) return evaluateRule(raw[i + 1], ctx);
        i += 2;
      }
      return i < raw.length ? evaluateRule(raw[i], ctx) : null;
    }
    case 'regex_match': {
      const pattern = String(list[0] ?? '');
      const target = String(list[1] ?? '');
      try { return new RegExp(pattern).test(target); }
      catch { return false; }
    }
    default:
      throw new UnsupportedOpError(op);
  }
}

function resolveVar(path: string, ctx: Ctx): unknown {
  if (!path) return ctx;
  const segs = path.split('.');
  let cur: unknown = ctx;
  for (const seg of segs) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

function toNum(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  if (typeof v === 'boolean') return v ? 1 : 0;
  return 0;
}

function truthy(v: unknown): boolean {
  if (Array.isArray(v)) return v.length > 0;
  return Boolean(v);
}
