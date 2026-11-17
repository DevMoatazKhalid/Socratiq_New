import { describe, expect, it } from "vitest"
import { guardJs, guardSimulationLoops, LOOP_GUARD_RUNTIME, LOOP_LIMIT_MS } from "./loopGuard"

/** Run instrumented code with a clone of the runtime. Real time by default (runaway loops always exceed any limit); a fake clock for exact assertions. */
function run(js: string, limitMs = 60, clock: () => number = Date.now): unknown {
  const s: Record<number, number> = {}, n: Record<number, number> = {}
  const enter = (i: number) => { s[i] = clock(); n[i] = 0 }
  const tick = (i: number) => { if (((n[i] = (n[i] | 0) + 1) % 128) === 0 && clock() - s[i] > limitMs) throw new Error("loop limit") }
  return new Function("__lgEnter", "__lgTick", guardJs(js).code)(enter, tick)
}
const plain = (js: string) => new Function(js)()

describe("loop guard: runaway code is stopped", () => {
  it.each([
    ["while(true)", "while(true){}"],
    ["for(;;)", "for(;;){}"],
    ["do-while", "do{}while(true)"],
    ["single-statement body", "while(1);"],
    ["nested, inner finite", "for(;;){ for(let i=0;i<3;i++){} }"],
    ["label + continue", "outer: while(true){ continue outer }"],
    ["unbraced for body", "for(;;) x=1;"],
  ])("%s throws instead of hanging", (_n, code) => {
    const t0 = Date.now()
    expect(() => run(code)).toThrow(/loop limit/)
    expect(Date.now() - t0).toBeLessThan(2000)
  })
})

describe("loop guard: behaviour of normal code is unchanged", () => {
  const same = (body: string) => expect(run(body)).toEqual(plain(body))
  it("sums and nested loops", () => { same("let s=0;for(let i=0;i<50;i++){for(let j=0;j<i;j++)s+=j}return s") })
  it("while / do-while", () => { same("let i=0,s=0;while(i<10){s+=i;i++}do{s+=1}while(s<100);return [i,s]") })
  it("for-in and for-of", () => { same("const o={a:1,b:2};let k='';for(const x in o)k+=x;let t=0;for(const v of [1,2,3])t+=v;return [k,t]") })
  it("break and continue, including labels", () => { same("let c=0;outer:for(let i=0;i<10;i++){for(let j=0;j<10;j++){if(j===3)continue outer;if(i===5)break outer;c++}}return c") })
  it("return from inside a loop in a function", () => { same("function f(){for(let i=0;;i++){if(i===7)return i}}return f()") })
  it("closures still capture per-iteration let bindings", () => { same("const fs=[];for(let i=0;i<3;i++)fs.push(()=>i);return fs.map(f=>f())") })
  it("unbraced bodies and a loop as the body of if/else", () => { same("let s=0;if(true)for(let i=0;i<5;i++)s+=i;else while(0);return s") })
  it("statements without semicolons (ASI)", () => { same("let a=1\nwhile(a<5)a++\nlet b=a\nfor(let i=0;i<3;i++)b+=i\nreturn b") })
  it("a loop re-entered by SEPARATE calls (one per animation frame) is never penalised, however long the page runs (deterministic clock)", () => {
    let t = 0
    const s: Record<number, number> = {}, c: Record<number, number> = {}
    const enter = (i: number) => { s[i] = t; c[i] = 0 }
    const tick = (i: number) => { t += 1; if (((c[i] = (c[i] | 0) + 1) % 128) === 0 && t - s[i] > 1000) throw new Error("loop limit") }   // 1 "ms" per iteration
    const frame = new Function("__lgEnter", "__lgTick", guardJs("return function frame(){ let n = 0; for (let i = 0; i < 500; i++) n++; return n }").code)(enter, tick) as () => number
    let total = 0
    for (let f = 0; f < 400; f++) total += frame()           // each call is a fresh entry into the loop, like requestAnimationFrame
    expect(total).toBe(200000)
    expect(t).toBe(200000)                                    // the clock ran 200x past the 1,000 ms limit overall; no single run came close
  })
  it("...whereas ONE run that crosses the limit is stopped promptly (same clock)", () => {
    let t = 0
    const s: Record<number, number> = {}, c: Record<number, number> = {}
    const enter = (i: number) => { s[i] = t; c[i] = 0 }
    const tick = (i: number) => { t += 1; if (((c[i] = (c[i] | 0) + 1) % 128) === 0 && t - s[i] > 1000) throw new Error("loop limit") }
    expect(() => new Function("__lgEnter", "__lgTick", guardJs("for (let i = 0; i < 100000; i++) {}").code)(enter, tick)).toThrow(/loop limit/)
    expect(t).toBeLessThan(1200)
  })
  it("a NESTED loop whose outer run lasts past the limit is stopped, because the outer loop really is one long run (deterministic clock)", () => {
    let t = 0
    const s: Record<number, number> = {}, c: Record<number, number> = {}
    const enter = (i: number) => { s[i] = t; c[i] = 0 }
    const tick = (i: number) => { t += 1; if (((c[i] = (c[i] | 0) + 1) % 128) === 0 && t - s[i] > 1000) throw new Error("loop limit") }
    expect(() => new Function("__lgEnter", "__lgTick", guardJs("for (let f = 0; f < 400; f++) { for (let i = 0; i < 500; i++) {} }").code)(enter, tick)).toThrow(/loop limit/)
  })
  it("leaves unparsable code untouched", () => { expect(guardJs("while(").code).toBe("while(") })
})

describe("loop guard: HTML handling", () => {
  it("instruments inline scripts and on* handlers, and nothing else", () => {
    const out = guardSimulationLoops(`<button onclick="while(true){}">go</button><script>for(;;){}</script><script src="x.js"></script><script type="application/json">{"a":"while(1){}"}</script><p>while(true){}</p>`)
    expect(out).toContain("__lgEnter(")
    expect(out.match(/__lgEnter\(/g)).toHaveLength(2)
    expect(out).toContain('<script src="x.js"></script>')
    expect(out).toContain('{"a":"while(1){}"}')
    expect(out).toContain("<p>while(true){}</p>")
  })
  it("round-trips quotes and ampersands inside handler attributes", () => {
    const out = guardSimulationLoops(`<a onclick="if(a&amp;&amp;b){while(i&lt;3){i++}}; s=&quot;x&quot;">`)
    expect(out).toContain("&amp;&amp;")
    expect(out).toContain("&quot;x&quot;")
    expect(out).toContain("__lgTick(0)")
  })
  it("does not treat JavaScript that merely looks like an attribute as an attribute", () => {
    const out = guardSimulationLoops(`<script>var s = ' onload = "while(1){}" '; for(let i=0;i<2;i++){}</script>`)
    expect(out.match(/__lgEnter\(/g)).toHaveLength(1)
    expect(out).toContain(`' onload = "while(1){}" '`)
  })
  it("runtime is a classic inline script with the documented limit", () => {
    expect(LOOP_GUARD_RUNTIME.startsWith("<script>")).toBe(true)
    expect(LOOP_GUARD_RUNTIME).toContain(`L=${LOOP_LIMIT_MS}`)
  })
})
