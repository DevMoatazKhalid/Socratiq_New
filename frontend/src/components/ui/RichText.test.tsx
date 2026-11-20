// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

afterEach(cleanup)
import { RichText } from "./RichText"
import { looksLikeCode } from "@/lib/richText"

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
