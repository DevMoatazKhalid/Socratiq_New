/** Four genuinely different simulations (different subject, different mechanism), used as model-generated output. Each exposes DOM readouts the tests measure. */
const wrap = (body, script) => `<div class="w-full h-full p-2 bg-white text-slate-900 flex flex-col gap-1">${body}</div><script>${script}</script>`

// 1. PHYSICS - projectile motion, requestAnimationFrame with dt, angle slider. #hmax is the analytic apex height for the chosen angle.
const PROJECTILE = wrap(`<canvas id="c" class="w-full flex-1" width="460" height="240"></canvas>
<label>Angle <input id="angle" type="range" min="10" max="80" value="45"> <span id="deg">45</span>&deg;</label>
<div>t=<span id="t">0</span>s &nbsp; apex=<span id="hmax">0</span>m</div>`, `
const c=document.getElementById('c'),g=c.getContext('2d'),A=document.getElementById('angle');let t=0,last=null;const v0=30,G=9.81;
function hmax(){const th=A.value*Math.PI/180;return Math.pow(v0*Math.sin(th),2)/(2*G)}
function draw(){const th=A.value*Math.PI/180,T=2*v0*Math.sin(th)/G,tt=t%T;g.clearRect(0,0,460,240);
 const x=v0*Math.cos(th)*tt*3,y=240-(v0*Math.sin(th)*tt-0.5*G*tt*tt)*3;g.beginPath();g.arc(10+x,y-5,6,0,7);g.fill();
 document.getElementById('t').textContent=t.toFixed(2);document.getElementById('hmax').textContent=hmax().toFixed(2);document.getElementById('deg').textContent=A.value}
A.addEventListener('input',()=>{t=0;draw()});
function f(ts){if(last!==null)t+=(ts-last)/1000;last=ts;draw();requestAnimationFrame(f)}requestAnimationFrame(f);`)

// 2. MATHEMATICS - y = sin(f*x - phase) with a travelling phase; #freq readout; canvas plot.
const SINE = wrap(`<canvas id="c" class="w-full flex-1" width="460" height="240"></canvas>
<label>Frequency <input id="freq" type="range" min="1" max="8" value="2"> <span id="freqv">2</span></label>
<div>t=<span id="t">0</span> &nbsp; period=<span id="per">0</span></div>`, `
const c=document.getElementById('c'),g=c.getContext('2d'),F=document.getElementById('freq');let t=0,last=null;
function draw(){const f=+F.value;g.clearRect(0,0,460,240);g.beginPath();for(let x=0;x<=460;x+=2){const y=120-80*Math.sin(f*x/460*6.283-t*2);x?g.lineTo(x,y):g.moveTo(x,y)}g.stroke();
 document.getElementById('t').textContent=t.toFixed(2);document.getElementById('freqv').textContent=f;document.getElementById('per').textContent=(1/f).toFixed(3)}
F.addEventListener('input',draw);
function f(ts){if(last!==null)t+=(ts-last)/1000;last=ts;draw();requestAnimationFrame(f)}requestAnimationFrame(f);`)

// 3. SCIENCE - Brownian particles advanced by setInterval (a different mechanism from rAF); temperature slider; #ms = mean speed.
const PARTICLES = wrap(`<canvas id="c" class="w-full flex-1" width="460" height="240"></canvas>
<label>Temperature <input id="temp" type="range" min="1" max="10" value="2"></label>
<div>ticks=<span id="t">0</span> &nbsp; mean speed=<span id="ms">0</span></div>`, `
const c=document.getElementById('c'),g=c.getContext('2d'),T=document.getElementById('temp');let n=0;
const P=Array.from({length:60},()=>({x:Math.random()*460,y:Math.random()*240,vx:0,vy:0}));
setInterval(()=>{n++;const k=+T.value;let s=0;g.clearRect(0,0,460,240);for(const p of P){p.vx=(Math.random()-.5)*k*2;p.vy=(Math.random()-.5)*k*2;p.x=(p.x+p.vx+460)%460;p.y=(p.y+p.vy+240)%240;s+=Math.hypot(p.vx,p.vy);g.fillRect(p.x,p.y,3,3)}
 document.getElementById('t').textContent=n;document.getElementById('ms').textContent=(s/P.length).toFixed(2)},30);`)

// 4. INTERACTIVE MODEL - logistic growth stepped by a button; no continuous animation at all. #pop changes only through user input.
const LOGISTIC = wrap(`<div>Population: <b id="pop">10</b> &nbsp; generation <span id="t">0</span></div>
<label>Growth rate <input id="r" type="range" min="1" max="30" value="10"></label>
<button id="step" class="border px-2 py-1 w-24">Step</button>`, `
let p=10,gen=0;const K=100;
document.getElementById('step').addEventListener('click',()=>{const r=document.getElementById('r').value/10;p=p+r*p*(1-p/K);gen++;
 document.getElementById('pop').textContent=p.toFixed(1);document.getElementById('t').textContent=gen});`)

const BROKEN = wrap(`<div id="t">0</div>`, `requestAnimationFrame(function f(){requestAnimationFrame(f)}); setTimeout(function(){ undefinedFunction() },100)`)
module.exports = { PROJECTILE, SINE, PARTICLES, LOGISTIC, BROKEN }
