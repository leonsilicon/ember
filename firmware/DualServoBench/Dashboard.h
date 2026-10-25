#pragma once
const char dashboard[] PROGMEM=R"HTML(<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1,user-scalable=no"><title>Leaf Rover</title><style>
*{box-sizing:border-box}body{margin:0;background:#111a15;color:#eaf3e9;font:17px system-ui;padding:20px;text-align:center}main{max-width:420px;margin:auto}header{display:flex;justify-content:space-between;align-items:center;margin-bottom:24px}h1{font-size:23px;margin:0}#state{font-size:13px;color:#a9bca8}button{font:650 17px system-ui;border:0;border-radius:18px;padding:22px 8px;background:#d5e8ba;color:#152116;touch-action:none;user-select:none;-webkit-user-select:none;-webkit-touch-callout:none}button:disabled{opacity:.35}button.pressed{background:#83b958;transform:scale(.97)}.pad{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}.servo{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:16px 0}.servo button{background:#cad9e7}h2{font-size:15px;font-weight:500;color:#a9bca8;margin:24px 0 10px}.slider{display:flex;justify-content:space-between;font-size:15px;margin-top:24px}input{width:100%;accent-color:#c6e6a4;margin:17px 0;touch-action:pan-y}</style></head><body><main>
<header><h1>Leaf Rover</h1><span id="state">Connecting</span></header>
<div class="pad"><span></span><button data-axis="wheel" data-value="1" disabled>Forward</button><span></span><button data-axis="wheel" data-value="3" disabled>Left</button><span></span><button data-axis="wheel" data-value="4" disabled>Right</button><span></span><button data-axis="wheel" data-value="2" disabled>Back</button></div>
<h2>Pan</h2><div class="servo"><button data-axis="pan" data-value="1" disabled>Forward</button><button data-axis="pan" data-value="-1" disabled>Back</button></div>
<h2>Lift</h2><div class="servo"><button data-axis="lift" data-value="1" disabled>Forward</button><button data-axis="lift" data-value="-1" disabled>Back</button></div>
<label class="slider" for="power">Wheel speed <span id="powerValue">20%</span></label><input id="power" type="range" min="0" max="100" step="1" value="20">
<label class="slider" for="speed">Servo speed <span id="speedValue">10%</span></label><input id="speed" type="range" min="0" max="100" step="1" value="10">
</main><script>
const buttons=[...document.querySelectorAll('button')],state=document.querySelector('#state'),power=document.querySelector('#power'),speed=document.querySelector('#speed');
let token=0,seq=0,connected=false,connecting=false;const pointers=new Map();
function values(){const v={wheel:0,pan:0,lift:0};for(const p of pointers.values())v[p.axis]=p.value;return v;}
function repaint(){for(const b of buttons)b.classList.toggle('pressed',[...pointers.values()].some(p=>p.button===b));}
function clear(){pointers.clear();repaint();}
function enable(v){buttons.forEach(b=>b.disabled=!v);}
async function post(path,data){const r=await fetch(path,{method:'POST',body:new URLSearchParams(data),signal:AbortSignal.timeout(900)});if(!r.ok){const e=Error('HTTP '+r.status);e.status=r.status;throw e;}return r.json();}
async function send(){if(!connected||!token)return;const n=++seq,v=values();try{await post('/control',{token,seq:n,...v,power:power.value,speed:speed.value});}catch(e){if(n!==seq)return;clear();connected=false;enable(false);state.textContent='Disconnected';}}
function stop(){clear();if(token){const n=++seq;fetch('/control',{method:'POST',body:new URLSearchParams({token,seq:n,wheel:0,pan:0,lift:0,power:power.value,speed:speed.value}),keepalive:true}).catch(()=>{});}}
async function connect(){if(connecting||connected)return;connecting=true;try{const r=await post('/session',{});token=r.token;seq=0;clear();connected=true;enable(true);state.textContent='Connected';}catch(e){enable(false);state.textContent='Disconnected';}finally{connecting=false;}}
buttons.forEach(b=>{b.onpointerdown=e=>{e.preventDefault();if(!connected)return;b.setPointerCapture(e.pointerId);pointers.set(e.pointerId,{axis:b.dataset.axis,value:Number(b.dataset.value),button:b});repaint();send();};b.onpointerup=e=>{pointers.delete(e.pointerId);repaint();send();};b.onpointercancel=e=>{pointers.delete(e.pointerId);repaint();send();};b.onlostpointercapture=e=>{if(pointers.delete(e.pointerId)){repaint();send();}};});
power.oninput=()=>{document.querySelector('#powerValue').textContent=power.value+'%';send();};speed.oninput=()=>{document.querySelector('#speedValue').textContent=speed.value+'%';send();};
setInterval(()=>{if(pointers.size)send();},100);
setInterval(async()=>{if(!connected){if(!document.hidden)connect();return;}try{const r=await fetch('/status',{signal:AbortSignal.timeout(900)});if(!r.ok)throw Error();const s=await r.json();if(!s.ready)throw Error();}catch(e){stop();connected=false;enable(false);state.textContent='Disconnected';}},700);
window.addEventListener('blur',stop);window.addEventListener('pagehide',stop);document.addEventListener('visibilitychange',()=>{if(document.hidden)stop();});window.addEventListener('keydown',e=>{if(e.code==='Space'){e.preventDefault();stop();}});connect();
</script></body></html>)HTML";
