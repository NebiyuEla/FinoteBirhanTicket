(() => {
  'use strict';
  const tg = window.Telegram?.WebApp;
  if (tg) {
    tg.ready(); tg.expand();
    try { tg.setHeaderColor('#fffdf8'); tg.setBackgroundColor('#f7f1e7'); if (typeof tg.disableVerticalSwipes === 'function') tg.disableVerticalSwipes(); } catch {}
  }

  function syncViewportHeight() {
    const height = tg?.viewportStableHeight || tg?.viewportHeight || window.innerHeight;
    if (height) document.documentElement.style.setProperty('--app-height', `${Math.floor(height)}px`);
  }
  syncViewportHeight();
  if (tg?.onEvent) tg.onEvent('viewportChanged', syncViewportHeight);
  window.addEventListener('resize', syncViewportHeight, { passive: true });
  document.addEventListener('touchmove', (event) => { if (!event.target.closest('.number-grid') && !event.target.closest('input')) event.preventDefault(); }, { passive: false });

  const params = new URLSearchParams(window.location.search);
  const session = params.get('s') || '';
  const mode = params.get('mode') === 'seller' ? 'seller' : 'buyer';
  const sellerName = params.get('seller') || '';
  const sellerPayAvailable = params.get('sellerpay') === '1';
  const unavailable = { 200: decodeBitset(params.get('a200')), 100: decodeBitset(params.get('a100')), 50: decodeBitset(params.get('a50')) };
  const state = { ticket:null, activePool:200, numbers:{200:null,100:null,50:null}, buyerName:'', buyerPhone:'', paymentTarget:'finote' };

  const screens = [...document.querySelectorAll('[data-screen]')];
  const ticketGrid = document.getElementById('ticketGrid');
  const tabs = document.getElementById('tabs');
  const numberGrid = document.getElementById('numberGrid');
  const numberHelp = document.getElementById('numberHelp');
  const summary = document.getElementById('summary');
  const confirmBtn = document.getElementById('confirmBtn');
  const sellerLine = document.getElementById('sellerLine');
  const sellerBuyerBar = document.getElementById('sellerBuyerBar');
  const buyerNameInput = document.getElementById('sellerBuyerName');
  const buyerPhoneInput = document.getElementById('sellerBuyerPhone');
  const payFinote = document.getElementById('payFinote');
  const paySeller = document.getElementById('paySeller');

  sellerLine.textContent = mode === 'seller' ? `${sellerName || 'Ticket Seller'} · ሽያጭ` : 'ትኬት ይምረጡ';
  paySeller.disabled = !sellerPayAvailable;
  if (!sellerPayAvailable) paySeller.textContent = 'የእኔ አካውንት · አልተዘጋጀም';
  loadTicketImages();

  if (!session || !tg?.sendData) show('error');
  else show(mode === 'seller' ? 'sellerCustomer' : 'ticket');

  document.getElementById('sellerContinue').addEventListener('click', () => {
    const name = String(buyerNameInput.value || '').trim().replace(/\s+/g, ' ');
    const phone = String(buyerPhoneInput.value || '').trim().replace(/[\s()-]/g, '');
    if (name.length < 3) return alertMini('የገዢውን ሙሉ ስም ያስገቡ።');
    if (!/^(?:\+2519|2519|09|9)\d{8}$/.test(phone)) return alertMini('ትክክለኛ የኢትዮጵያ ስልክ ቁጥር ያስገቡ።');
    state.buyerName = name; state.buyerPhone = phone;
    document.getElementById('sellerBuyerLabel').textContent = name;
    document.getElementById('sellerBuyerMeta').textContent = `${phone} · ${state.paymentTarget === 'seller' ? 'ወደ ሻጭ አካውንት' : 'ወደ ፍኖተ ብርሃን'}`;
    sellerBuyerBar.classList.remove('hidden');
    show('ticket');
  });

  document.getElementById('editBuyer').addEventListener('click', () => { if (mode === 'seller') show('sellerCustomer'); });
  [payFinote, paySeller].forEach((button) => button.addEventListener('click', () => {
    if (button.disabled) return;
    state.paymentTarget = button.dataset.pay;
    payFinote.classList.toggle('active', state.paymentTarget === 'finote');
    paySeller.classList.toggle('active', state.paymentTarget === 'seller');
    document.getElementById('sellerPaymentNote').textContent = state.paymentTarget === 'seller'
      ? 'ገዢው ወደ እርስዎ አካውንት ይከፍላል። ገንዘቡን ካዩ በኋላ SOLD ይጫኑ።'
      : 'ገዢው ወደ ፍኖተ ብርሃን አካውንት ይከፍላል። ክፍያውን ካረጋገጡ በኋላ SOLD ይጫኑ።';
  }));

  ticketGrid.addEventListener('click', (event) => {
    const card = event.target.closest('[data-ticket]'); if (!card) return;
    if (mode === 'seller' && (!state.buyerName || !state.buyerPhone)) return show('sellerCustomer');
    state.ticket = card.dataset.ticket; state.numbers = {200:null,100:null,50:null}; state.activePool = state.ticket === 'bundle' ? 200 : Number(state.ticket);
    tabs.classList.toggle('hidden', state.ticket !== 'bundle');
    numberHelp.textContent = state.ticket === 'bundle' ? 'ከእያንዳንዱ ዕጣ አንድ ቁጥር ይምረጡ።' : 'ከ001–200 አንድ ያልተወሰደ ቁጥር ይምረጡ።';
    render(); show('numbers');
  });

  tabs.addEventListener('click', (event) => { const tab = event.target.closest('[data-pool]'); if (!tab) return; state.activePool = Number(tab.dataset.pool); render(); });
  numberGrid.addEventListener('click', (event) => {
    const button = event.target.closest('[data-number]'); if (!button || button.disabled) return;
    state.numbers[state.activePool] = Number(button.dataset.number);
    if (state.ticket === 'bundle') { const next = [200,100,50].find((pool) => !state.numbers[pool]); if (next) state.activePool = next; }
    render();
  });
  document.getElementById('backBtn').addEventListener('click', () => show('ticket'));

  confirmBtn.addEventListener('click', () => {
    if (!complete()) return;
    const payload = { type: mode === 'seller' ? 'seller_sale_selection' : 'ticket_selection', session, package: state.ticket, numbers:{} };
    if (mode === 'seller') { payload.buyer_name = state.buyerName; payload.buyer_phone = state.buyerPhone; payload.payment_target = state.paymentTarget; }
    const pools = state.ticket === 'bundle' ? [200,100,50] : [Number(state.ticket)];
    for (const pool of pools) payload.numbers[String(pool)] = state.numbers[pool];
    confirmBtn.disabled = true; confirmBtn.textContent = mode === 'seller' ? 'ለሻጭ ቦት በመላክ ላይ…' : 'በመላክ ላይ…';
    try { tg.sendData(JSON.stringify(payload)); }
    catch { confirmBtn.disabled = false; confirmBtn.textContent = 'ያስይዙ እና ይቀጥሉ'; show('error'); }
  });

  async function loadTicketImages() {
    const definitions = [
      { id:'ticket100Image', parts:['./assets/ticket-100-1.txt','./assets/ticket-100-2.txt'] },
      { id:'ticket50Image', parts:['./assets/ticket-50-1.txt','./assets/ticket-50-2.txt'] }
    ];
    await Promise.all(definitions.map(async ({id,parts}) => {
      const image = document.getElementById(id); if (!image) return;
      try { const chunks = await Promise.all(parts.map(async (path) => { const response = await fetch(path,{cache:'force-cache'}); if (!response.ok) throw new Error(path); return response.text(); })); image.src = `data:image/webp;base64,${chunks.join('')}`; }
      catch { image.src = './logo.svg'; }
    }));
  }

  function show(name) {
    screens.forEach((screen) => screen.classList.toggle('visible', screen.dataset.screen === name));
    document.body.classList.toggle('number-mode', name === 'numbers');
    if (name === 'numbers') numberGrid.scrollTop = 0;
  }
  function complete() { if (!state.ticket) return false; return state.ticket === 'bundle' ? [200,100,50].every((pool) => Boolean(state.numbers[pool])) : Boolean(state.numbers[Number(state.ticket)]); }
  function render() {
    document.querySelectorAll('.pool-tab').forEach((button) => { const pool=Number(button.dataset.pool); button.classList.toggle('active',pool===state.activePool); button.classList.toggle('has-value',Boolean(state.numbers[pool])); document.getElementById(`v${pool}`).textContent=state.numbers[pool]?`#${formatNumber(state.numbers[pool])}`:'—'; });
    const fragment=document.createDocumentFragment();
    for(let number=1;number<=200;number+=1){const button=document.createElement('button');button.type='button';button.className='num';button.dataset.number=String(number);button.textContent=formatNumber(number);if(unavailable[state.activePool].has(number)){button.disabled=true;button.classList.add('taken')}else if(state.numbers[state.activePool]===number){button.classList.add('selected')}fragment.appendChild(button)}
    numberGrid.replaceChildren(fragment);
    if(state.ticket==='bundle'){summary.innerHTML=[200,100,50].map((pool)=>`<strong>${pool} ብር:</strong> ${state.numbers[pool]?`#${formatNumber(state.numbers[pool])}`:'—'}`).join(' · ')}else if(state.ticket){const pool=Number(state.ticket);summary.innerHTML=`<strong>${pool} ብር:</strong> ${state.numbers[pool]?`#${formatNumber(state.numbers[pool])}`:'ቁጥር ይምረጡ'}`}
    confirmBtn.disabled=!complete();
  }
  function formatNumber(number){return String(number).padStart(3,'0')}
  function decodeBitset(encoded){const output=new Set();if(!encoded)return output;try{const normalized=encoded.replace(/-/g,'+').replace(/_/g,'/');const padding='='.repeat((4-normalized.length%4)%4);const raw=atob(normalized+padding);for(let index=0;index<Math.min(200,raw.length*8);index+=1){const byte=raw.charCodeAt(Math.floor(index/8));if(byte&(1<<(index%8)))output.add(index+1)}}catch{}return output}
  function alertMini(message){ if (tg?.showAlert) tg.showAlert(message); else window.alert(message); }
  render();
})();
