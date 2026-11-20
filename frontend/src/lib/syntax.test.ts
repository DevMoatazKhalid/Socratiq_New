import { describe, expect, it } from "vitest"
import { tokenize } from "./syntax"

describe("tokenize (display-only Python highlighting)", () => {
  const src = '@dec\ndef f(x):\n    # note\n    s = f"a{x}\\n" + \'b\'\n    return len([1, 2.5e3, 0x1F]) if x else None\n"""doc\nstring"""\nclass Foo: pass'
  it("is lossless: joining tokens gives back the exact source", () => {
    expect(tokenize(src, "py").map((t) => t.text).join("")).toBe(src)
  })
  it("classifies keywords, names, strings, comments, numbers and decorators", () => {
    const kinds = Object.fromEntries(tokenize(src, "python").filter((t) => t.kind !== "plain").map((t) => [t.text, t.kind]))
    expect(kinds).toMatchObject({ "@dec": "decorator", def: "keyword", f: "def", "# note": "comment", "'b'": "string", len: "builtin", "2.5e3": "number", "0x1F": "number", None: "keyword", Foo: "def" })
    expect(kinds['"""doc\nstring"""']).toBe("string")
  })
  it("returns unknown languages as one plain token", () => {
    expect(tokenize("echo <b>hi</b>", "bash")).toEqual([{ text: "echo <b>hi</b>", kind: "plain" }])
  })
})
