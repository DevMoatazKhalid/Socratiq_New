/**
 * The host runtime that is injected into every simulation frame, BEFORE any generated code, plus the message protocol it speaks.
 *
 * Why it exists. A sandboxed iframe gives isolation but no control: the board could neither pause a generated animation, nor change its speed,
 * nor learn that it crashed (the frame has an opaque origin, and errors only reached a console nobody reads). The runtime fixes all three
 * without asking the model to cooperate:
 *
 *  1. A virtual clock. `requestAnimationFrame`, `setTimeout`, `setInterval`, `performance.now()` and `Date.now()` are replaced by versions that
 *     run on virtual time. While paused (or while the card is off screen) virtual time stands still and NO callback runs and NO animation frame is
 *     scheduled (timers re-check at 10 Hz so they can resume), so a paused simulation costs almost no CPU. Resuming re-arms exactly one frame: a loop can never be duplicated. Speed scales virtual
 *     time, so simulations that integrate with the elapsed time (dt) speed up and slow down faithfully.
 *  2. Reporting. Script errors, unhandled rejections, failed resource loads and CSP violations are posted to the host so the board can show a
 *     clear message instead of a blank card.
 *  3. Lifecycle. `loaded` (document parsed, scripts ran) and `ready` (first animation frame executed) let the host detect a simulation that
 *     never started.
 *
 * Known limits (documented, not hidden): `new Date()` without arguments and CSS animations/transitions keep real time; a simulation that
 * advances by a fixed step per frame ignores Speed (the generation prompt asks for dt-based integration); the clock cannot stop a synchronous
 * infinite loop (loopGuard.ts handles that).
 *
 * Security: the runtime only ever posts to `window.parent` (the one thing an opaque-origin frame can do to its parent) and only ever acts on
 * messages whose `source` is that parent window and whose payload passes the checks below. The generated code cannot use `parent.postMessage`
 * (deny-listed) and could not impersonate the host anyway: control messages are accepted only from `window.parent`.
 */

export const SIM_PROTOCOL_TAG = 1
export const SIM_SPEEDS = [0.25, 0.5, 1, 2, 4] as const
export const SIM_MAX_SPEED = 8

export type SimFrameMessage =
  | { type: "loaded" }
  | { type: "ready" }
  | { type: "error"; message: string }
  | { type: "violation"; message: string }

export interface SimControlMessage { __sq: 1; type: "control"; paused?: boolean; speed?: number; hidden?: boolean }

const MAX_TEXT = 300

/** Validate an untrusted `message` event payload coming from a simulation frame. Returns null for anything that is not exactly our protocol. */
export function parseSimMessage(data: unknown): SimFrameMessage | null {
  if (!data || typeof data !== "object") return null
  const d = data as Record<string, unknown>
  if (d.__sq !== SIM_PROTOCOL_TAG) return null
  if (d.type === "loaded" || d.type === "ready") return { type: d.type }
  if ((d.type === "error" || d.type === "violation") && typeof d.message === "string") return { type: d.type, message: d.message.slice(0, MAX_TEXT) }
  return null
}

export function controlMessage(c: { paused?: boolean; speed?: number; hidden?: boolean }): SimControlMessage {
  const m: SimControlMessage = { __sq: SIM_PROTOCOL_TAG, type: "control" }
  if (typeof c.paused === "boolean") m.paused = c.paused
  if (typeof c.hidden === "boolean") m.hidden = c.hidden
  if (typeof c.speed === "number" && Number.isFinite(c.speed) && c.speed > 0 && c.speed <= SIM_MAX_SPEED) m.speed = c.speed
  return m
}

/** Plain ES5-style script (it is embedded in a document string). No backticks or template placeholders inside. */
export const SIM_HOST_RUNTIME = `<script>(function(){
var P=window.parent,TAG=${SIM_PROTOCOL_TAG},MAXS=${SIM_MAX_SPEED};
var post=function(m){try{m.__sq=TAG;P.postMessage(m,'*')}catch(e){}};
var rn=performance.now.bind(performance),rd=Date.now.bind(Date),rAF=window.requestAnimationFrame.bind(window);
var rST=window.setTimeout.bind(window),rCT=window.clearTimeout.bind(window),rSI=window.setInterval.bind(window),rCI=window.clearInterval.bind(window);
var st={paused:false,hidden:false,speed:1},virt=0,last=rn(),base=rd(),frames=0,sent=0;
function stopped(){return st.paused||st.hidden}
function adv(){var n=rn(),d=n-last;last=n;if(!stopped())virt+=d*st.speed;return virt}
performance.now=function(){return adv()};
Date.now=function(){return base+adv()};
var q=new Map(),rid=0,armed=false;
function arm(){if(armed||stopped()||!q.size)return;armed=true;rAF(pump)}
function pump(){armed=false;if(stopped())return;var t=adv(),cbs=q;q=new Map();
cbs.forEach(function(cb){try{cb(t)}catch(e){fail(e)}});
frames++;if(frames===1)post({type:'ready'});arm()}
window.requestAnimationFrame=function(cb){if(typeof cb!=='function')throw new TypeError('requestAnimationFrame needs a function');var id=++rid;q.set(id,cb);arm();return id};
window.cancelAnimationFrame=function(id){q.delete(id)};
var tm=new Map(),tid=0;
function gated(fn,ms,args,repeat){var id=++tid;
function run(){if(!tm.has(id))return;if(stopped()){tm.set(id,rST(run,100));return}
if(repeat){tm.set(id,rST(run,Math.max(4,ms/st.speed)))}else{tm.delete(id)}
try{fn.apply(window,args)}catch(e){fail(e)}}
tm.set(id,rST(run,Math.max(0,ms/st.speed)));return id}
window.setTimeout=function(fn,ms){if(typeof fn!=='function')return 0;return gated(fn,+ms||0,[].slice.call(arguments,2),false)};
window.setInterval=function(fn,ms){if(typeof fn!=='function')return 0;return gated(fn,Math.max(4,+ms||0),[].slice.call(arguments,2),true)};
window.clearTimeout=window.clearInterval=function(id){var h=tm.get(id);if(h!==undefined){rCT(h);tm.delete(id)}};
function say(type,msg){if(sent>=8)return;sent++;post({type:type,message:String(msg).slice(0,${MAX_TEXT})})}
function fail(e){say('error',e&&e.message?e.message:e)}
window.addEventListener('error',function(e){if(e.target&&e.target!==window&&(e.target.src||e.target.href)){say('error','Could not load '+(e.target.src||e.target.href))}else{say('error',e.message||'Script error')}},true);
window.addEventListener('unhandledrejection',function(e){say('error',e.reason&&e.reason.message?e.reason.message:'Unhandled promise rejection')});
document.addEventListener('securitypolicyviolation',function(e){say('violation',(e.violatedDirective||'policy')+' blocked '+(e.blockedURI||'a resource'))});
window.addEventListener('message',function(e){if(e.source!==P)return;var d=e.data;if(!d||d.__sq!==TAG||d.type!=='control')return;
if(typeof d.speed==='number'&&d.speed>0&&d.speed<=MAXS){adv();st.speed=d.speed}
if(typeof d.paused==='boolean'&&d.paused!==st.paused){adv();st.paused=d.paused;if(!d.paused){last=rn();arm()}}
if(typeof d.hidden==='boolean'&&d.hidden!==st.hidden){adv();st.hidden=d.hidden;if(!d.hidden){last=rn();arm()}}});
document.addEventListener('DOMContentLoaded',function(){post({type:'loaded'})});
Object.defineProperty(window,'__sq',{value:{get frames(){return frames},get paused(){return st.paused},get speed(){return st.speed},get clock(){return virt},get pending(){return q.size+tm.size}}});
})()</script>`
