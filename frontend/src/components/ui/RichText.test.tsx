// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

afterEach(cleanup)
import { RichText } from "./RichText"
import { looksLikeCode } from "@/lib/richText"
import { setKatexForTests } from "@/lib/katex"
import katex from "katex"
import { act } from "react"

describe("RichText", () => {
  it("renders inline code without the backticks", () => {
    render(<RichText text="Check `i` and `arr`." />)
    expect(screen.getByText("i").tagName).toBe("CODE")
    expect(document.body.textContent).not.toContain("`")
  })
  it("renders fenced blocks as pre/code", () => {
    const { container } = render(<RichText text={"Try:\n```py\nx = 1\n```\nthen run it"} />)
    expect(container.querySelector("pre code")?.textContent).toBe("x = 1")
    expect(container.textContent).toContain("then run it")
  })
  it("never turns markup into elements", () => {
    const { container } = render(<RichText text={'<img src=x onerror=alert(1)> <b>hi</b>'} />)
    expect(container.querySelector("img")).toBeNull()
    expect(container.querySelector("b")).toBeNull()
  })
  it("detects pasted indented code only", () => {
    expect(looksLikeCode("def f():\n    return 1")).toBe(true)
    expect(looksLikeCode("just a sentence\nand another")).toBe(false)
  })
})

describe("RichText direction (Arabic learning content inside an English LTR app)", () => {
  it("gives every prose paragraph dir=auto so Arabic and English each resolve their own base direction", () => {
    const { container } = render(<RichText text={"معدل التعلّم هو الخطوة\n\nThe learning rate is the step"} />)
    const ps = container.querySelectorAll("p")
    expect(ps.length).toBeGreaterThan(0)
    ps.forEach((p) => expect(p.getAttribute("dir")).toBe("auto"))
    expect(container.textContent).toContain("معدل التعلّم هو الخطوة")      // text and combining marks preserved byte-for-byte
  })
  it("keeps code blocks LTR even when the surrounding text is Arabic", () => {
    const { container } = render(<RichText text={"اشرح\n```py\nx=1\n```"} />)
    expect(container.querySelector("pre")!.getAttribute("dir")).toBe("ltr")
  })
})

describe("RichText code-block renderer (in-chat code runner hook)", () => {
  it("passes each fenced block's code, fence tag and index to the renderer and keeps the prose around it", () => {
    const seen: [string, string, number][] = []
    const { container } = render(
      <RichText text={"Try:\n```Python\nprint(1)\n```\nthen\n```\nplain\n```\nend"} renderCodeBlock={(code, lang, i) => { seen.push([code, lang, i]); return <div data-testid={`blk${i}`}>{code}</div> }} />,
    )
    expect(seen).toEqual([["print(1)", "python", 0], ["plain", "", 1]])
    expect(container.querySelector("pre")).toBeNull()
    expect(container.textContent).toContain("Try:")
    expect(container.textContent).toContain("then")
    expect(container.textContent).toContain("end")
  })
  it("without a renderer, fenced blocks render exactly as before", () => {
    const { container } = render(<RichText text={"a\n```js\nx()\n```"} />)
    expect(container.querySelector("pre code")?.textContent).toBe("x()")
  })
  it("an unfinished fence (still streaming) stays text and never reaches the renderer", () => {
    const fn = vi.fn()
    render(<RichText text={"```py\nprint(1)"} renderCodeBlock={fn} />)
    expect(fn).not.toHaveBeenCalled()
  })
})

describe("RichText mathematics (AI Coach formulas)", () => {
  afterEach(() => { cleanup(); setKatexForTests(null) })

  it("typesets inline and display formulas with KaTeX inside the explanation", () => {
    setKatexForTests(katex)
    const { container } = render(<RichText text={"The slope is $\\frac{\\Delta y}{\\Delta x}$.\n\n$$\\int_0^1 x^2\\,dx = \\frac{1}{3}$$\nSo the area is a third."} />)
    const inline = container.querySelector(".sq-math-inline")
    expect(inline?.querySelector(".katex")).not.toBeNull()
    expect(inline?.closest("p")).not.toBeNull()                              // inline maths stays in the sentence
    const display = container.querySelector(".sq-math-display")
    expect(display?.querySelector(".katex-display")).not.toBeNull()
    expect(display?.closest("p")).toBeNull()                                 // a display formula is its own block, never inside <p>
    expect(display?.getAttribute("dir")).toBe("ltr")
    expect(container.querySelector("math")).not.toBeNull()                   // MathML for screen readers
    expect(container.textContent).toContain("So the area is a third.")
  })
  it("renders multi-line derivations (aligned) as one display block", () => {
    setKatexForTests(katex)
    const { container } = render(<RichText text={"\\begin{aligned}(a+b)^2 &= a^2 + 2ab + b^2 \\\\ &= 9\\end{aligned}"} />)
    expect(container.querySelectorAll(".sq-math-display").length).toBe(1)
    expect(container.querySelector(".sq-math-display .katex")).not.toBeNull()
  })
  it("never treats money or code as maths", () => {
    setKatexForTests(katex)
    const { container } = render(<RichText text={"It costs $5 and $10. Run `echo $HOME$` now."} />)
    expect(container.querySelector(".katex")).toBeNull()
    expect(container.querySelector("code")?.textContent).toBe("echo $HOME$")
    expect(container.textContent).toContain("It costs $5 and $10.")
  })
  it("shows the TeX source in place until KaTeX has loaded, and for formulas it cannot parse", () => {
    const { container, rerender } = render(<RichText text={"Before $x^2$ after"} />)
    expect(container.querySelector(".sq-math-src")?.textContent).toBe("$x^2$")
    act(() => setKatexForTests(katex))          // KaTeX arriving re-renders the formulas already on screen
    expect(container.querySelector(".sq-math-inline .katex")).not.toBeNull()
    rerender(<RichText text={"Bad $\\frac{1}{$ but fine $x^2$"} />)
    expect(container.querySelectorAll(".sq-math-inline").length).toBe(1)
    expect(container.textContent).toContain("but fine")
  })
  it("formula HTML cannot carry links or scripts (trust is off)", () => {
    setKatexForTests(katex)
    const { container } = render(<RichText text={"$\\href{javascript:alert(1)}{x}$ and $\\htmlId{a}{y}$"} />)
    expect(container.querySelector("a")).toBeNull()
    expect(container.querySelector("#a")).toBeNull()
  })
})
