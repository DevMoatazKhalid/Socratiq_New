import { describe, expect, it } from "vitest"
import { hasMath, isMostlyTex, mathToSpeech, parseMath, repairLatexEscapes, speakMath, splitMath } from "./mathText"

const math = (input: string) => splitMath(input).filter((s) => s.kind === "math").map((s) => (s.kind === "math" ? [s.tex, s.display] : []))
const text = (input: string) => splitMath(input).map((s) => (s.kind === "text" ? s.text : `<${s.kind === "math" ? s.tex : ""}>`)).join("")

describe("splitMath: the delimiters models actually write", () => {
  it("finds inline $…$ and \\(…\\) inside a sentence", () => {
    expect(math("The slope is $m = \\frac{\\Delta y}{\\Delta x}$, so \\(m > 0\\) means rising.")).toEqual([
      ["m = \\frac{\\Delta y}{\\Delta x}", false], ["m > 0", false],
    ])
    expect(text("so $x^2$ grows")).toBe("so <x^2> grows")
  })
  it("finds display $$…$$ and \\[…\\], including across lines", () => {
    expect(math("Then\n$$\n\\int_0^1 x^2\\,dx = \\tfrac13\n$$\nand \\[ e^{i\\pi} + 1 = 0 \\]")).toEqual([
      ["\\int_0^1 x^2\\,dx = \\tfrac13", true], ["e^{i\\pi} + 1 = 0", true],
    ])
  })
  it("treats a bare \\begin{aligned}… block as one display formula (multi-line derivations)", () => {
    const src = "Expand:\n\\begin{aligned}\n(a+b)^2 &= (a+b)(a+b) \\\\\n&= a^2 + 2ab + b^2\n\\end{aligned}\nDone."
    const [seg] = splitMath(src).filter((s) => s.kind === "math")
    expect(seg).toMatchObject({ kind: "math", display: true })
    expect(seg.kind === "math" && seg.tex.startsWith("\\begin{aligned}") && seg.tex.endsWith("\\end{aligned}")).toBe(true)
    expect(text(src).startsWith("Expand:\n<")).toBe(true)
  })
  it("ignores \\begin of environments that are not maths", () => {
    expect(math("\\begin{itemize} x \\end{itemize}")).toEqual([])
  })
})

describe("splitMath: ordinary text stays text", () => {
  it("money is not maths", () => {
    expect(math("It costs $5 and the deluxe one $10.")).toEqual([])
    expect(math("Pay $3.50 now, or $4 later")).toEqual([])
    expect(math("I have $ 20 and you have 30$")).toEqual([])
  })
  it("an escaped \\$ is a literal dollar sign", () => {
    expect(splitMath("The fee is \\$20.")).toEqual([{ kind: "text", text: "The fee is $20." }])
    expect(math("\\$5 and $x$")).toEqual([["x", false]])
  })
  it("an unfinished formula (still streaming) stays as typed", () => {
    expect(splitMath("So $$x^")).toEqual([{ kind: "text", text: "So $$x^" }])
    expect(splitMath("and $y = ")).toEqual([{ kind: "text", text: "and $y = " }])
    expect(splitMath("\\[ a + ")).toEqual([{ kind: "text", text: "\\[ a + " }])
  })
  it("inline maths never spans a paragraph break, and empty delimiters are text", () => {
    expect(math("$a\n\nb$")).toEqual([])
    expect(math("$$  $$")).toEqual([])
  })
  it("round-trips: joining text and raw formulas gives back the input", () => {
    const src = "Let $f(x)=x^2$. Then $$f'(x)=2x$$ and \\(f''=2\\); price \\$3."
    const back = splitMath(src).map((s) => (s.kind === "text" ? s.text : s.raw)).join("")
    expect(back).toBe(src.replace("\\$", "$"))
  })
  it("hasMath is a cheap, exact pre-check", () => {
    expect(hasMath("plain words")).toBe(false)
    expect(hasMath("$5 and $10")).toBe(false)
    expect(hasMath("so $x$")).toBe(true)
  })
})

describe("read-aloud of formulas", () => {
  it("speaks fractions, powers, roots and Greek letters as words", () => {
    expect(mathToSpeech("\\frac{a}{b}")).toBe("a over b")
    expect(mathToSpeech("x^2 + y^3")).toBe("x squared plus y cubed")
    expect(mathToSpeech("\\sqrt{x}")).toBe("the square root of x")
    expect(mathToSpeech("\\alpha \\leq \\pi")).toBe("alpha less than or equal to pi")
    expect(mathToSpeech("a_{n} = 2^{n}")).toBe("a sub n equals 2 to the power n")
  })
  it("replaces each formula in a message and never says 'dollar' or 'backslash'", () => {
    const spoken = speakMath("The area is $\\pi r^2$ square units.")
    expect(spoken).toContain("pi r squared")
    expect(spoken).not.toMatch(/[$\\]/)
  })
})

describe("parseMath: maths as it really reaches the chat", () => {
  const FF = "\f", CR = "\r", TAB = "\t", BS = "\b"
  const only = (s: string) => parseMath(s).filter((x) => x.kind === "math").map((x) => (x.kind === "math" ? [x.tex, x.display] : []))
  const ODE = "\\left(\\frac{d^{2}y}{dx^{2}}\\right)^{4}=y+\\left(\\frac{dy}{dx}\\right)^{6}"

  it("restores LaTeX that the JSON decoder turned into control characters (\\frac -> form feed, \\right -> CR, ...)", () => {
    const mangled = `\\[\n\\left(${FF}rac{d^{2}y}{dx^{2}}${CR}ight)^{4}=y+\\left(${FF}rac{dy}{dx}${CR}ight)^{6}\n\\]`
    expect(only(mangled)).toEqual([[ODE, true]])
    expect(repairLatexEscapes(`$${TAB}heta ${TAB}imes ${BS}eta$`)).toBe("$\\theta \\times \\beta$")
    expect(repairLatexEscapes("$$a \neq b$$")).toBe("$$a \\neq b$$")
  })
  it("never touches ordinary newlines, CRLF or a display formula that starts with e or u", () => {
    const s = "Line one\nnot maths\r\nnext\n$$\ne^{i\\pi}+1=0\n$$"
    expect(repairLatexEscapes(s)).toBe(s)
  })
  it("understands the bracket form left when a Markdown renderer ate the backslashes", () => {
    expect(only(`المعادلة:\n[\n${ODE}\n]\nرتبتها 2`)).toEqual([[ODE, true]])
    expect(only("[ \\frac{a}{b} = c ]")).toEqual([["\\frac{a}{b} = c", true]])
    expect(only("The derivative ( \\frac{dy}{dx} ) is the slope (see notes).")).toEqual([["\\frac{dy}{dx}", false]])
    expect(only("[see the notes]")).toEqual([])
  })
  it("understands double-escaped delimiters", () => {
    expect(only("Then \\\\( x^2 \\\\) and \\\\[ \\\\frac{a}{b} \\\\]")).toEqual([["x^2", false], ["\\frac{a}{b}", true]])
  })
  it("typesets a line that is nothing but LaTeX, but never a sentence that mentions a command", () => {
    expect(only("So we have\n\\int_0^1 x^2\\,dx = \\frac{1}{3}\nwhich is a third.")).toEqual([["\\int_0^1 x^2\\,dx = \\frac{1}{3}", true]])
    expect(only("Use \\frac to write fractions")).toEqual([])
    expect(isMostlyTex("\\text{speed} = \\frac{d}{t}")).toBe(true)
    expect(isMostlyTex("\\frac الكسر")).toBe(false)
  })
  it("marks an unfinished display formula as pending while streaming", () => {
    expect(parseMath("Let me write it:\n$$\\int_0^", { streaming: true }).map((s) => s.kind)).toEqual(["text", "pending"])
    expect(parseMath("So $$x^").map((s) => s.kind)).toEqual(["text"])
  })
})
