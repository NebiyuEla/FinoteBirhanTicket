(() => {
  'use strict';
  const tg = window.Telegram?.WebApp;
  if (tg) { tg.ready(); tg.expand(); try { tg.setHeaderColor('#fffdf8'); tg.setBackgroundColor('#f7f1e7'); } catch {} }

  const params = new URLSearchParams(location.search);
  const session = params.get('s') || '';
  const sellerName = params.get('seller') || '';
  const unavailable = {200:decodeBitset(params.get('a200')),100:decodeBitset(params.get('a100')),50:decodeBitset(params.get('a50'))};
  const state = {ticket:null,activePool:200,numbers:{200:null,100:null,50:null}};
  const screens=[...document.querySelectorAll('[data-screen]')];
  const ticketGrid=document.getElementById('ticketGrid');
  const tabs=document.getElementById('tabs');
  const numberGrid=document.getElementById('numberGrid');
  const numberHelp=document.getElementById('numberHelp');
  const summary=document.getElementById('summary');
  const confirmBtn=document.getElementById('confirmBtn');
  document.getElementById('sellerLine').textContent=sellerName?`የሽያጭ ወኪል: ${sellerName}`:'ትኬት ይምረጡ';

  startSlideshow();
  if(!session||!tg?.sendData) show('error');

  ticketGrid.addEventListener('click',e=>{const card=e.target.closest('[data-ticket]');if(!card)return;state.ticket=card.dataset.ticket;state.numbers={200:null,100:null,50:null};state.activePool=state.ticket==='bundle'?200:Number(state.ticket);tabs.classList.toggle('hidden',state.ticket!=='bundle');numberHelp.textContent=state.ticket==='bundle'?'ከእያንዳንዱ ዕጣ አንድ ቁጥር ይምረጡ።':'ከ001–200 ያልተወሰደ ቁጥር ይምረጡ።';render();show('numbers');});
  tabs.addEventListener('click',e=>{const b=e.target.closest('[data-pool]');if(!b)return;state.activePool=Number(b.dataset.pool);render();});
  numberGrid.addEventListener('click',e=>{const b=e.target.closest('[data-number]');if(!b||b.disabled)return;state.numbers[state.activePool]=Number(b.dataset.number);if(state.ticket==='bundle'){const next=[200,100,50].find(p=>!state.numbers[p]);if(next)state.activePool=next;}render();});
  document.getElementById('backBtn').addEventListener('click',()=>show('ticket'));
  confirmBtn.addEventListener('click',()=>{if(!complete())return;const payload={type:'ticket_selection',session,package:state.ticket,numbers:{}};const pools=state.ticket==='bundle'?[200,100,50]:[Number(state.ticket)];for(const p of pools)payload.numbers[String(p)]=state.numbers[p];confirmBtn.disabled=true;confirmBtn.textContent='በመላክ ላይ…';try{tg.sendData(JSON.stringify(payload));}catch{confirmBtn.disabled=false;confirmBtn.textContent='ያስይዙ እና ይቀጥሉ';show('error');}});

  function startSlideshow(){const box=document.getElementById('ticketSlideshow');if(!box)return;const imgs=[...box.querySelectorAll('img')];if(imgs.length<2)return;let i=0;setInterval(()=>{imgs[i].classList.remove('active');i=(i+1)%imgs.length;imgs[i].classList.add('active');},2600);}
  function show(name){screens.forEach(s=>s.classList.toggle('visible',s.dataset.screen===name));}
  function complete(){if(!state.ticket)return false;return state.ticket==='bundle'?[200,100,50].every(p=>state.numbers[p]):Boolean(state.numbers[Number(state.ticket)]);}
  function render(){document.querySelectorAll('.pool-tab').forEach(b=>{const p=Number(b.dataset.pool);b.classList.toggle('active',p===state.activePool);b.classList.toggle('has-value',Boolean(state.numbers[p]));document.getElementById(`v${p}`).textContent=state.numbers[p]?`#${fmt(state.numbers[p])}`:'—';});const frag=document.createDocumentFragment();for(let i=1;i<=200;i++){const b=document.createElement('button');b.type='button';b.className='num';b.dataset.number=String(i);b.textContent=fmt(i);if(unavailable[state.activePool].has(i)){b.disabled=true;b.classList.add('taken');}else if(state.numbers[state.activePool]===i)b.classList.add('selected');frag.appendChild(b);}numberGrid.replaceChildren(frag);if(state.ticket==='bundle')summary.innerHTML=[200,100,50].map(p=>`<strong>${p} ብር:</strong> ${state.numbers[p]?`#${fmt(state.numbers[p])}`:'—'}`).join(' &nbsp;·&nbsp; ');else if(state.ticket){const p=Number(state.ticket);summary.innerHTML=`<strong>${p} ብር:</strong> ${state.numbers[p]?`#${fmt(state.numbers[p])}`:'ቁጥር ይምረጡ'}`;}confirmBtn.disabled=!complete();}
  function fmt(n){return String(n).padStart(3,'0');}
  function decodeBitset(encoded){const out=new Set();if(!encoded)return out;try{const normalized=encoded.replace(/-/g,'+').replace(/_/g,'/');const pad='='.repeat((4-normalized.length%4)%4);const raw=atob(normalized+pad);for(let idx=0;idx<Math.min(200,raw.length*8);idx++){const byte=raw.charCodeAt(Math.floor(idx/8));if(byte&(1<<(idx%8)))out.add(idx+1);}}catch{}return out;}
  render();
})();
