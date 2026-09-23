(() => {
  'use strict';

  const tg = window.Telegram?.WebApp;
  if (tg) {
    tg.ready();
    tg.expand();
    try {
      tg.setHeaderColor('#fffdf8');
      tg.setBackgroundColor('#f7f1e7');
      if (typeof tg.disableVerticalSwipes === 'function') tg.disableVerticalSwipes();
    } catch {}
  }

  const params = new URLSearchParams(location.search);
  const session = params.get('s') || '';
  const mode = params.get('mode') === 'seller' ? 'seller' : 'buyer';
  const sellerName = params.get('seller') || '';
  const sellerPayAvailable = params.get('sellerpay') === '1';
  let lang = normalizeLang(params.get('lang') || localStorage.getItem('finote_lang') || 'am');

  const prizeNames = {
    am: {
      200: params.get('p200am') || 'የእምቤታችን ምስለ ሰዕል',
      100: params.get('p100am') || 'በእንጨት የተሰራ መጽሐፍ ቅዱስ',
      50: params.get('p50am') || 'ነጠላ፣ በኢፖክሲ የተሰራ 4:3 የእመቤታችን ምስለ ሰዕል እና የዝማሬ ኄራን ቁልፍ መያዣ'
    },
    en: {
      200: params.get('p200en') || 'Icon of Our Lady',
      100: params.get('p100en') || 'Handcrafted Wooden Bible',
      50: params.get('p50en') || 'Netela, 4:3 epoxy icon of Our Lady and Zemare Heran keychain'
    }
  };

  const T = {
    am: {
      brandKicker:'ፍኖተ ብርሃን ሰ/ት/ቤት', brandTitle:'ዕጣ ትኬት', chooseTicket:'ትኬት ይምረጡ',
      chooseTicketHint:'ሽልማቱን ይመልከቱ እና ትኬቱን ይጫኑ።', discount:'ቅናሽ',
      bundleTitle:'ሶስቱም ዕጣዎች በአንድ', bundlePrize:'በ200፣ 100 እና 50 ብር ዕጣ አንድ አንድ ቁጥር — ዕድልዎን ይጨምራል',
      birr:'ብር', tapToChoose:'ቁጥር ለመምረጥ ይጫኑ', chooseNumber:'ቁጥር ይምረጡ', back:'ተመለስ',
      available:'ያለ', selected:'የተመረጠ', taken:'የተወሰደ', reserveContinue:'ያስይዙ እና ይቀጥሉ',
      newSale:'አዲስ ትኬት ሽያጭ', buyerInfo:'የገዢውን መረጃ ያስገቡ', buyerFullName:'የገዢው ሙሉ ስም',
      phone:'ስልክ ቁጥር', paymentDestination:'ክፍያ የት ይገባ?', finoteBirhan:'ፍኖተ ብርሃን', sellerAccount:'የእኔ አካውንት',
      chooseTicketArrow:'ትኬት ይምረጡ →', edit:'ቀይር', expiredTitle:'ሊንኩ አልፎታል',
      expiredText:'ወደ ቦቱ ይመለሱ እና “ትኬት ይግዙ” በመጫን እንደገና ይክፈቱ።',
      sellerPayNote:'ገዢው ወደ እርስዎ አካውንት ይከፍላል። ገንዘቡን ካዩ በኋላ “ተሽጧል” ይጫኑ።',
      finotePayNote:'ገዢው ወደ ፍኖተ ብርሃን አካውንት ይከፍላል። ክፍያውን ካረጋገጡ በኋላ “ተሽጧል” ይጫኑ።',
      chooseOne:'ከ001–200 አንድ ያልተወሰደ ቁጥር ይምረጡ።',
      chooseBundle:'ከ200፣ 100 እና 50 ብር ዕጣ እያንዳንዱ አንድ ቁጥር ይምረጡ።',
      chooseNumberShort:'ቁጥር ይምረጡ', sending:'በመላክ ላይ…', sellerMode:'የትኬት ሻጭ',
      sellerUnconfigured:'የእኔ አካውንት · አልተዘጋጀም', fullNamePlaceholder:'ሙሉ ስም'
    },
    en: {
      brandKicker:'FinoteBirhan Sunday School', brandTitle:'Digital Ticket', chooseTicket:'Choose a ticket',
      chooseTicketHint:'See the prize, then tap the ticket you want.', discount:'SAVE',
      bundleTitle:'All 3 draws in one', bundlePrize:'One number in each 200, 100 and 50 ETB draw — increases your chances',
      birr:'ETB', tapToChoose:'Tap to choose a number', chooseNumber:'Choose a number', back:'Back',
      available:'Available', selected:'Selected', taken:'Taken', reserveContinue:'Reserve & continue',
      newSale:'New ticket sale', buyerInfo:'Enter the buyer information', buyerFullName:'Buyer full name', phone:'Phone number',
      paymentDestination:'Where will the buyer pay?', finoteBirhan:'FinoteBirhan', sellerAccount:'My account',
      chooseTicketArrow:'Choose ticket →', edit:'Edit', expiredTitle:'This link expired',
      expiredText:'Return to the bot and tap “Buy Ticket” to open a fresh page.',
      sellerPayNote:'The buyer pays your account. After you see the money, tap SOLD.',
      finotePayNote:'The buyer pays the FinoteBirhan account. After payment is confirmed, tap SOLD.',
      chooseOne:'Choose one available number from 001–200.', chooseBundle:'Choose one number in each 200, 100 and 50 ETB draw.',
      chooseNumberShort:'Choose a number', sending:'Sending…', sellerMode:'Ticket Seller',
      sellerUnconfigured:'My account · Not configured', fullNamePlaceholder:'Full name'
    }
  };

  const unavailable = {
    200: decodeBitset(params.get('a200')),
    100: decodeBitset(params.get('a100')),
    50: decodeBitset(params.get('a50'))
  };
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

  syncViewportHeight();
  if (tg?.onEvent) tg.onEvent('viewportChanged', syncViewportHeight);
  window.addEventListener('resize', syncViewportHeight, { passive:true });
  document.addEventListener('touchmove', (event) => {
    if (!event.target.closest('.number-grid') && !event.target.closest('.ticket-scroll') && !event.target.closest('input') && !event.target.closest('.seller-note')) event.preventDefault();
  }, { passive:false });

  document.querySelectorAll('[data-lang-control],#langToggle').forEach((button) => button.addEventListener('click', toggleLanguage));
  paySeller.disabled = !sellerPayAvailable;
  loadTicketImages();
  applyLanguage();

  if (!session || !tg?.sendData) show('error');
  else show(mode === 'seller' ? 'sellerCustomer' : 'ticket');

  document.getElementById('sellerContinue').addEventListener('click', () => {
    const name = String(buyerNameInput.value || '').trim().replace(/\s+/g, ' ');
    const phone = String(buyerPhoneInput.value || '').trim().replace(/[\s()-]/g, '');
    if (name.length < 3) return alertMini(lang === 'am' ? 'የገዢውን ሙሉ ስም ያስገቡ።' : 'Enter the buyer full name.');
    if (!/^(?:\+2519|2519|09|9)\d{8}$/.test(phone)) return alertMini(lang === 'am' ? 'ትክክለኛ የኢትዮጵያ ስልክ ቁጥር ያስገቡ።' : 'Enter a valid Ethiopian phone number.');
    state.buyerName = name;
    state.buyerPhone = phone;
    document.getElementById('sellerBuyerLabel').textContent = name;
    updateSellerBuyerMeta();
    sellerBuyerBar.classList.remove('hidden');
    show('ticket');
  });

  document.getElementById('editBuyer').addEventListener('click', () => { if (mode === 'seller') show('sellerCustomer'); });
  [payFinote,paySeller].forEach((button) => button.addEventListener('click', () => {
    if (button.disabled) return;
    state.paymentTarget = button.dataset.pay;
    payFinote.classList.toggle('active', state.paymentTarget === 'finote');
    paySeller.classList.toggle('active', state.paymentTarget === 'seller');
    updatePaymentNote();
    updateSellerBuyerMeta();
  }));

  ticketGrid.addEventListener('click', (event) => {
    const card = event.target.closest('[data-ticket]');
    if (!card) return;
    if (mode === 'seller' && (!state.buyerName || !state.buyerPhone)) return show('sellerCustomer');
    state.ticket = card.dataset.ticket;
    state.numbers = {200:null,100:null,50:null};
    state.activePool = state.ticket === 'bundle' ? 200 : Number(state.ticket);
    tabs.classList.toggle('hidden', state.ticket !== 'bundle');
    numberHelp.textContent = state.ticket === 'bundle' ? T[lang].chooseBundle : T[lang].chooseOne;
    render();
    show('numbers');
  });

  tabs.addEventListener('click', (event) => {
    const tab = event.target.closest('[data-pool]');
    if (!tab) return;
    state.activePool = Number(tab.dataset.pool);
    render();
  });

  numberGrid.addEventListener('click', (event) => {
    const button = event.target.closest('[data-number]');
    if (!button || button.disabled) return;
    state.numbers[state.activePool] = Number(button.dataset.number);
    if (state.ticket === 'bundle') {
      const next = [200,100,50].find((pool) => !state.numbers[pool]);
      if (next) state.activePool = next;
    }
    render();
  });

  document.getElementById('backBtn').addEventListener('click', () => show('ticket'));

  confirmBtn.addEventListener('click', () => {
    if (!complete()) return;
    const payload = { type: mode === 'seller' ? 'seller_sale_selection' : 'ticket_selection', session, package:state.ticket, numbers:{}, lang };
    if (mode === 'seller') {
      payload.buyer_name = state.buyerName;
      payload.buyer_phone = state.buyerPhone;
      payload.payment_target = state.paymentTarget;
    }
    const pools = state.ticket === 'bundle' ? [200,100,50] : [Number(state.ticket)];
    for (const pool of pools) payload.numbers[String(pool)] = state.numbers[pool];
    confirmBtn.disabled = true;
    confirmBtn.textContent = T[lang].sending;
    try { tg.sendData(JSON.stringify(payload)); }
    catch {
      confirmBtn.disabled = false;
      confirmBtn.textContent = T[lang].reserveContinue;
      show('error');
    }
  });

  async function loadTicketImages() {
    const definitions = [
      { id:'ticket100Image', parts:['./assets/ticket-100-1.txt','./assets/ticket-100-2.txt'] },
      { id:'ticket50Image', parts:['./assets/ticket-50-1.txt','./assets/ticket-50-2.txt'] }
    ];
    await Promise.all(definitions.map(async ({id,parts}) => {
      const image = document.getElementById(id);
      if (!image) return;
      try {
        const chunks = await Promise.all(parts.map(async (path) => {
          const response = await fetch(path, { cache:'force-cache' });
          if (!response.ok) throw new Error(path);
          return response.text();
        }));
        image.src = `data:image/webp;base64,${chunks.join('')}`;
      } catch { image.src = './logo.svg'; }
    }));
  }

  function syncViewportHeight() {
    const height = tg?.viewportStableHeight || tg?.viewportHeight || window.innerHeight;
    if (height) document.documentElement.style.setProperty('--app-height', `${Math.floor(height)}px`);
  }

  function toggleLanguage() {
    lang = lang === 'am' ? 'en' : 'am';
    localStorage.setItem('finote_lang', lang);
    applyLanguage();
    render();
  }

  function applyLanguage() {
    document.documentElement.lang = lang;
    document.querySelectorAll('[data-i18n]').forEach((node) => {
      const key = node.dataset.i18n;
      if (T[lang][key]) node.textContent = T[lang][key];
    });
    document.querySelectorAll('[data-lang-control],#langToggle').forEach((button) => { button.textContent = lang === 'am' ? 'EN' : 'አማ'; });
    buyerNameInput.placeholder = T[lang].fullNamePlaceholder;
    sellerLine.textContent = mode === 'seller' ? `${sellerName || T[lang].sellerMode} · ${T[lang].sellerMode}` : T[lang].chooseTicket;
    paySeller.textContent = sellerPayAvailable ? T[lang].sellerAccount : T[lang].sellerUnconfigured;
    document.getElementById('prize200').textContent = prizeNames[lang][200];
    document.getElementById('prize100').textContent = prizeNames[lang][100];
    document.getElementById('prize50').textContent = prizeNames[lang][50];
    if (state.ticket) numberHelp.textContent = state.ticket === 'bundle' ? T[lang].chooseBundle : T[lang].chooseOne;
    updatePaymentNote();
    updateSellerBuyerMeta();
  }

  function updatePaymentNote() {
    const note = document.getElementById('sellerPaymentNote');
    if (note) note.textContent = state.paymentTarget === 'seller' ? T[lang].sellerPayNote : T[lang].finotePayNote;
  }

  function updateSellerBuyerMeta() {
    if (!state.buyerPhone) return;
    const destination = state.paymentTarget === 'seller' ? T[lang].sellerAccount : T[lang].finoteBirhan;
    document.getElementById('sellerBuyerMeta').textContent = `${state.buyerPhone} · ${destination}`;
  }

  function show(name) {
    screens.forEach((screen) => screen.classList.toggle('visible', screen.dataset.screen === name));
    document.body.classList.toggle('number-mode', name === 'numbers');
    if (name === 'numbers') numberGrid.scrollTop = 0;
    if (name === 'ticket') document.querySelector('.ticket-scroll')?.scrollTo({top:0,behavior:'instant'});
  }

  function complete() {
    if (!state.ticket) return false;
    return state.ticket === 'bundle'
      ? [200,100,50].every((pool) => Boolean(state.numbers[pool]))
      : Boolean(state.numbers[Number(state.ticket)]);
  }

  function render() {
    document.querySelectorAll('.pool-tab').forEach((button) => {
      const pool = Number(button.dataset.pool);
      button.classList.toggle('active', pool === state.activePool);
      button.classList.toggle('has-value', Boolean(state.numbers[pool]));
      document.getElementById(`v${pool}`).textContent = state.numbers[pool] ? `#${formatNumber(state.numbers[pool])}` : '—';
    });

    const fragment = document.createDocumentFragment();
    for (let number = 1; number <= 200; number += 1) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'num';
      button.dataset.number = String(number);
      button.textContent = formatNumber(number);
      if (unavailable[state.activePool].has(number)) {
        button.disabled = true;
        button.classList.add('taken');
      } else if (state.numbers[state.activePool] === number) button.classList.add('selected');
      fragment.appendChild(button);
    }
    numberGrid.replaceChildren(fragment);

    if (state.ticket === 'bundle') {
      summary.innerHTML = [200,100,50].map((pool) => `<strong>${pool} ${T[lang].birr}:</strong> ${state.numbers[pool] ? `#${formatNumber(state.numbers[pool])}` : '—'}`).join(' · ');
    } else if (state.ticket) {
      const pool = Number(state.ticket);
      summary.innerHTML = `<strong>${pool} ${T[lang].birr}:</strong> ${state.numbers[pool] ? `#${formatNumber(state.numbers[pool])}` : T[lang].chooseNumberShort}`;
    }
    confirmBtn.disabled = !complete();
    if (confirmBtn.textContent !== T[lang].sending) confirmBtn.textContent = T[lang].reserveContinue;
  }

  function alertMini(text) { if (tg?.showAlert) tg.showAlert(text); else window.alert(text); }
  function formatNumber(number) { return String(number).padStart(3, '0'); }
  function normalizeLang(value) { return String(value || '').toLowerCase().startsWith('en') ? 'en' : 'am'; }

  function decodeBitset(encoded) {
    const output = new Set();
    if (!encoded) return output;
    try {
      const normalized = encoded.replace(/-/g, '+').replace(/_/g, '/');
      const padding = '='.repeat((4 - normalized.length % 4) % 4);
      const raw = atob(normalized + padding);
      for (let index = 0; index < Math.min(200, raw.length * 8); index += 1) {
        const byte = raw.charCodeAt(Math.floor(index / 8));
        if (byte & (1 << (index % 8))) output.add(index + 1);
      }
    } catch {}
    return output;
  }

  render();
})();
