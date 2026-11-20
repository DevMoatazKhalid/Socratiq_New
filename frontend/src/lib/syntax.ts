/**
 * A tiny, dependency-free Python tokenizer for display only (the editor and read-only code views). It returns plain tokens; components render
 * them as React text nodes (never HTML), so code can never inject markup. Unknown languages come back as one plain token.
 */
export type TokenKind = "keyword" | "string" | "comment" | "number" | "builtin" | "def" | "decorator" | "plain"
export interface Token { text: string; kind: TokenKind }

const PY_KEYWORDS = new Set(("False None True and as assert async await break class continue def del elif else except finally for from global if import " +
  "in is lambda nonlocal not or pass raise return try while with yield match case").split(" "))
const PY_BUILTINS = new Set(("print len range int float str bool list dict set tuple input open enumerate zip map filter sorted reversed sum min max abs " +
  "round isinstance type super object Exception ValueError TypeError KeyError IndexError ZeroDivisionError any all iter next repr format chr ord self").split(" "))

// order matters: strings (incl. triple-quoted and prefixed) and comments before everything else
const PY = new RegExp(
  [
    String.raw`(?<comment>#[^\n]*)`,
    String.raw`(?<string>(?:[rRbBuUfF]{1,2})?(?:"""[\s\S]*?(?:"""|$)|'''[\s\S]*?(?:'''|$)|"(?:\\.|[^"\\\n])*"?|'(?:\\.|[^'\\\n])*'?))`,
    String.raw`(?<decorator>@[A-Za-z_][\w.]*)`,
    String.raw`(?<number>\b(?:0[xX][0-9a-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?j?|\.\d+(?:[eE][+-]?\d+)?j?)\b)`,
    String.raw`(?<word>[A-Za-z_][A-Za-z0-9_]*)`,
  ].join("|"),
  "g",
)

export function tokenize(code: string, language: string): Token[] {
  const lang = language.trim().toLowerCase()
  if (!["python", "py", "python3"].includes(lang)) return code ? [{ text: code, kind: "plain" }] : []
  const out: Token[] = []
  const push = (text: string, kind: TokenKind) => {
    if (!text) return
    const last = out[out.length - 1]
    if (last && last.kind === kind && kind === "plain") last.text += text
    else out.push({ text, kind })
  }
  let i = 0
  let afterDef = false
  PY.lastIndex = 0
  for (let m = PY.exec(code); m; m = PY.exec(code)) {
    if (m[0] === "") { PY.lastIndex++; continue }
    push(code.slice(i, m.index), "plain")
    const g = m.groups ?? {}
    if (g.comment) push(m[0], "comment")
    else if (g.string) push(m[0], "string")
    else if (g.decorator) push(m[0], "decorator")
    else if (g.number) push(m[0], "number")
    else if (afterDef) push(m[0], "def")
    else if (PY_KEYWORDS.has(m[0])) push(m[0], "keyword")
    else if (PY_BUILTINS.has(m[0])) push(m[0], "builtin")
    else push(m[0], "plain")
    afterDef = !!g.word && (m[0] === "def" || m[0] === "class")
    i = m.index + m[0].length
  }
  push(code.slice(i), "plain")
  return out
}
