/* Hughes Living Auctions — front end

   This file renders and reacts. It decides nothing about the auction: prices,
   minimums, extensions and who is leading all come from HLA_API, which is
   either the page itself (demo), the local server, or Supabase. See api.js.

   Two rules kept throughout:
     * every clock is drawn against the SERVER's now, never the browser's
     * no rule is reimplemented here that the engine already answers */
(function () {
  'use strict';

  var API = window.HLA_API;
  var LOTS = [];
  var byNo = {};
  var session = { signedIn: false, paddle: null, email: null };

  /* ---------- formatting ---------- */
  function money(cents) {
    return '$' + Math.round(cents / 100).toLocaleString('en-US');
  }
  function money2(cents) {
    return '$' + (cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function formatLeft(ms) {
    if (ms <= 0) return 'closed';
    var s = Math.floor(ms / 1000);
    var d = Math.floor(s / 86400); s -= d * 86400;
    var h = Math.floor(s / 3600);  s -= h * 3600;
    var m = Math.floor(s / 60);    s -= m * 60;
    if (d > 0) return d + 'd ' + pad(h) + 'h ' + pad(m) + 'm';
    return pad(h) + ':' + pad(m) + ':' + pad(s);
  }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /* ---------- watchlist (the one thing that is genuinely local) ---------- */
  function load(key, fallback) {
    try { var v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; }
    catch (e) { return fallback; }
  }
  function save(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) {}
  }
  var watching = load('hla.watch', []);

  /* ---------- card ---------- */
  function starSVG(on) {
    return '<svg viewBox="0 0 24 24" aria-hidden="true">' +
      '<path d="M12 3.6l2.6 5.3 5.8.8-4.2 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8L3.6 9.7l5.8-.8z"' +
      (on ? ' fill="currentColor"' : '') + '/></svg>';
  }

  function cardHTML(lot) {
    var on = watching.indexOf(lot.lot_no) !== -1;
    var closed = lot.status !== 'open';
    return '' +
    '<article class="tag' + (API.isMine && API.isMine(lot) ? ' is-mine' : '') + '" data-lot="' + lot.lot_no + '">' +
      '<span class="tag__punch" aria-hidden="true"></span>' +
      '<div class="tag__head">' +
        '<span class="tag__id">LOT ' + lot.lot_no + '</span>' +
        '<span class="tag__src">Pallet ' + esc(lot.pallet) + '</span>' +
        '<button class="watch" type="button" aria-pressed="' + (on ? 'true' : 'false') +
                '" aria-label="Watch lot ' + lot.lot_no + '">' + starSVG(on) + '</button>' +
      '</div>' +
      '<div class="tag__photo">' +
        '<img src="' + esc(lot.image_path) + '" alt="' + esc(lot.alt_text) + '" loading="lazy" width="800" height="600">' +
        '<span class="grade grade--' + esc(lot.grade) + '">Grade ' + esc(lot.grade).toUpperCase() + '</span>' +
      '</div>' +
      '<div class="tag__body">' +
        '<p class="tag__cat">' + esc(lot.category) + '</p>' +
        '<h3 class="tag__title">' + esc(lot.title) + '</h3>' +
        (lot.retail_cents ? '<p class="tag__retail">Retail <s>' + money(lot.retail_cents) + '</s></p>' : '') +
        '<dl class="ledger">' +
          '<div class="ledger__row"><dt>Found</dt><dd>' + esc(lot.found) + '</dd></div>' +
          '<div class="ledger__row is-fixed"><dt>Fixed</dt><dd>' + esc(lot.fixed) + '</dd></div>' +
          '<div class="ledger__row is-flaw"><dt>Still</dt><dd>' + esc(lot.still) + '</dd></div>' +
        '</dl>' +
      '</div>' +
      '<div class="stub">' +
        '<div class="stub__bid">' +
          '<span class="lbl">' + (closed ? 'Hammer' : 'Current bid') + '</span>' +
          '<span class="amt">' + money(priceOf(lot)) + '</span>' +
          '<span class="meta">' + lot.bid_count + (lot.bid_count === 1 ? ' bid' : ' bids') + '</span>' +
        '</div>' +
        '<div class="stub__clock"><span class="lbl">' + (closed ? 'Closed' : 'Closes in') + '</span>' +
          '<time datetime="' + esc(lot.ends_at) + '">—</time></div>' +
        '<p class="mine-flag">You are the high bidder</p>' +
        '<div class="stub__acts">' +
          '<button class="btn btn--bid" type="button"' + (closed ? ' disabled' : '') + '>' +
            (closed ? 'Closed' : 'Place bid') + '</button>' +
          (lot.buy_now_cents && !closed
            ? '<button class="btn btn--buy" type="button">Buy ' + money(lot.buy_now_cents) + '</button>'
            : '') +
        '</div>' +
      '</div>' +
    '</article>';
  }

  /* A lot with no bids sits at its opening price; the engine reports 0 until
     someone bids, because the opening is not a bid. */
  function priceOf(lot) {
    return lot.bid_count > 0 ? lot.current_price_cents : lot.opening_cents;
  }
  function minNextOf(lot) {
    if (typeof lot.min_next_cents === 'number' && lot.min_next_cents > 0) return lot.min_next_cents;
    return lot.bid_count === 0
      ? lot.opening_cents
      : lot.current_price_cents + API.incrementCents(lot.current_price_cents);
  }

  /* ---------- painting ---------- */
  var grid    = document.getElementById('lotGrid');
  var empty   = document.getElementById('lotEmpty');
  var countEl = document.getElementById('lotCount');
  var feature = document.getElementById('feature');

  function cardFor(lotNo) {
    return document.querySelector('.tag[data-lot="' + lotNo + '"]');
  }

  function paintClock(lot) {
    var els = document.querySelectorAll('.tag[data-lot="' + lot.lot_no + '"] .stub__clock');
    var left = new Date(lot.ends_at).getTime() - API.serverNow().getTime();
    for (var i = 0; i < els.length; i++) {
      var box = els[i], t = box.querySelector('time');
      if (!t) continue;
      t.textContent = formatLeft(left);
      t.setAttribute('datetime', lot.ends_at);
      box.classList.toggle('is-final', left > 0 && left < 15 * 60 * 1000);
      box.classList.toggle('is-done', left <= 0);
    }
  }

  function paintLot(lot) {
    var cards = document.querySelectorAll('.tag[data-lot="' + lot.lot_no + '"]');
    for (var i = 0; i < cards.length; i++) {
      var card = cards[i];
      var amt = card.querySelector('.stub__bid .amt');
      if (amt) amt.textContent = money(priceOf(lot));
      var meta = card.querySelector('.stub__bid .meta');
      if (meta) meta.textContent = lot.bid_count + (lot.bid_count === 1 ? ' bid' : ' bids');
      card.classList.toggle('is-mine', !!(API.isMine && API.isMine(lot)));

      var closed = lot.status !== 'open';
      var bidBtn = card.querySelector('.btn--bid');
      if (bidBtn) { bidBtn.disabled = closed; bidBtn.textContent = closed ? 'Closed' : 'Place bid'; }
      var buyBtn = card.querySelector('.btn--buy');
      if (buyBtn && (!lot.buy_now_cents || closed)) buyBtn.remove();
    }
    paintClock(lot);
  }

  function flashExtend(lot) {
    var cards = document.querySelectorAll('.tag[data-lot="' + lot.lot_no + '"] .stub');
    for (var i = 0; i < cards.length; i++) {
      var stub = cards[i];
      if (stub.querySelector('.extend-flag')) continue;
      var p = document.createElement('p');
      p.className = 'extend-flag';
      p.textContent = 'Bid in the last two minutes — clock extended';
      stub.appendChild(p);
      (function (node) { setTimeout(function () { node.remove(); }, 12000); })(p);
    }
  }

  function tick() { LOTS.forEach(paintClock); paintSheetClock(); }

  /* ---------- filters ---------- */
  var filter = 'all';
  function passes(lot) {
    var left = new Date(lot.ends_at).getTime() - API.serverNow().getTime();
    switch (filter) {
      case 'soon':  return lot.status === 'open' && left > 0 && left < 24 * 3600 * 1000;
      case 'buy':   return !!lot.buy_now_cents;
      case 'clean': return lot.grade === 'a';
      case 'watch': return watching.indexOf(lot.lot_no) !== -1;
      default:         return true;
    }
  }

  function render() {
    var shown = LOTS.filter(function (l) { return l.lot_no !== 118 && passes(l); });
    grid.innerHTML = shown.map(cardHTML).join('');
    empty.hidden = shown.length > 0;
    countEl.textContent = shown.length + (shown.length === 1 ? ' lot' : ' lots') +
                          (filter === 'all' ? ' open' : ' shown');
    shown.forEach(paintClock);
    var f = byNo[118];
    if (f) paintLot(f);
  }

  var rail = document.querySelector('.rail');
  if (rail) {
    rail.addEventListener('click', function (e) {
      var chip = e.target.closest('.chip');
      if (!chip) return;
      var chips = rail.querySelectorAll('.chip');
      for (var i = 0; i < chips.length; i++) chips[i].setAttribute('aria-pressed', 'false');
      chip.setAttribute('aria-pressed', 'true');
      filter = chip.dataset.filter || 'all';
      render();
    });
  }

  /* ---------- watch + bid buttons (delegated, so re-renders keep working) ---------- */
  document.addEventListener('click', function (e) {
    var watchBtn = e.target.closest('.watch');
    if (watchBtn) {
      var card = watchBtn.closest('.tag');
      var no = Number(card.dataset.lot);
      var i = watching.indexOf(no);
      if (i === -1) watching.push(no); else watching.splice(i, 1);
      save('hla.watch', watching);
      var on = watching.indexOf(no) !== -1;
      var all = document.querySelectorAll('.tag[data-lot="' + no + '"] .watch');
      for (var k = 0; k < all.length; k++) {
        all[k].setAttribute('aria-pressed', on ? 'true' : 'false');
        all[k].innerHTML = starSVG(on);
      }
      if (filter === 'watch') render();
      return;
    }
    var bid = e.target.closest('.btn--bid');
    if (bid) { openSheet(byNo[Number(bid.closest('.tag').dataset.lot)], bid); return; }
    var buy = e.target.closest('.btn--buy');
    if (buy) { doBuyNow(byNo[Number(buy.closest('.tag').dataset.lot)]); return; }
  });

  /* ---------- bid sheet ---------- */
  var sheet   = document.getElementById('bidSheet');
  var form    = document.getElementById('bidForm');
  var fMax    = document.getElementById('maxBid');
  var fProtect= document.getElementById('protect');
  var fErr    = document.getElementById('sheetErr');
  var sLot    = document.getElementById('sheetLot');
  var sTitle  = document.getElementById('sheetTitle');
  var sNow    = document.getElementById('sheetNow');
  var sLeft   = document.getElementById('sheetLeft');
  var sHint   = document.getElementById('minHint');
  var sCost   = document.getElementById('protectCost');
  var sTotal  = document.getElementById('sheetTotal');
  var sSubmit = document.getElementById('sheetSubmit');
  var current = null, returnTo = null;

  function paintTotals() {
    if (!current) return;
    var dollars = parseFloat(fMax.value);
    var cents = isNaN(dollars) ? 0 : Math.round(dollars * 100);
    var prot = fProtect.checked && cents > 0 ? API.protectionCents(cents) : 0;
    sCost.textContent = prot ? money2(prot) : '—';
    sTotal.textContent = cents ? money2(cents + prot) : '—';
  }

  function paintSheetNow() {
    if (!current) return;
    var lot = byNo[current.lot_no] || current;
    sNow.textContent = (lot.status === 'open' ? 'Current bid ' : 'Hammer ') + money(priceOf(lot)) +
                       ' · ' + lot.bid_count + (lot.bid_count === 1 ? ' bid' : ' bids');
    sLeft.textContent = formatLeft(new Date(lot.ends_at).getTime() - API.serverNow().getTime());
  }
  function paintSheetClock() {
    if (!sheet.open) return;
    paintSheetNow();
  }

  function openSheet(lot, opener) {
    if (!lot) return;
    current = lot; returnTo = opener || null;
    sLot.textContent = 'Lot ' + lot.lot_no;
    sTitle.textContent = lot.title;
    fErr.textContent = '';
    fProtect.checked = false;
    var min = minNextOf(lot);
    fMax.min = String(min / 100);
    fMax.step = '1';
    fMax.value = String(min / 100);
    sHint.textContent = 'Minimum ' + money(min) + '. Whole dollars. We bid only as much as it takes to keep you in front, up to your maximum.';
    paintTotals(); paintSheetNow();
    sSubmit.disabled = false;
    sSubmit.textContent = session.signedIn || !API.canSignIn ? 'Place bid' : 'Sign in to bid';
    sheet.showModal();
    fMax.focus(); fMax.select();
  }

  function closeSheet() { sheet.close(); }

  fMax.addEventListener('input', paintTotals);
  fProtect.addEventListener('change', paintTotals);
  document.getElementById('sheetClose').addEventListener('click', closeSheet);
  sheet.addEventListener('close', function () {
    if (returnTo && returnTo.focus) returnTo.focus();
  });
  sheet.addEventListener('click', function (e) { if (e.target === sheet) closeSheet(); });

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    if (!current) return;

    if (API.canSignIn && !session.signedIn) {
      promptSignIn(function () { form.requestSubmit(); });
      return;
    }

    var dollars = parseFloat(fMax.value);
    if (isNaN(dollars)) { fErr.textContent = 'Enter the most you are willing to pay.'; fMax.focus(); return; }
    var cents = Math.round(dollars * 100);

    sSubmit.disabled = true;
    fErr.textContent = '';
    /* One key per attempt, so a double-submit or a retry cannot bid twice. */
    var key = 'bid-' + current.lot_no + '-' + cents + '-' + Date.now();

    API.placeBid(current.lot_no, cents, fProtect.checked, key)
      .then(function (r) {
        return refreshOne(current.lot_no).then(function () {
          if (r.extended) flashExtend(byNo[current.lot_no] || current);
          closeSheet();
          say(r.status === 'leading'
            ? 'You are the high bidder on lot ' + r.lot_no + ' at ' + money(r.price_cents) + '.'
            : 'Outbid on lot ' + r.lot_no + '. It stands at ' + money(r.price_cents) + '.');
        });
      })
      .catch(function (err) {
        fErr.textContent = err.message || 'That bid did not go through.';
        return refreshOne(current.lot_no);
      })
      .then(function () { sSubmit.disabled = false; });
  });

  function doBuyNow(lot) {
    if (!lot) return;
    if (API.canSignIn && !session.signedIn) {
      promptSignIn(function () { doBuyNow(lot); });
      return;
    }
    if (!confirm('Buy lot ' + lot.lot_no + ' now for ' + money(lot.buy_now_cents) + '?')) return;
    API.buyNow(lot.lot_no, false, 'buy-' + lot.lot_no + '-' + Date.now())
      .then(function (r) {
        say('Lot ' + r.lot_no + ' is yours at ' + money(r.price_cents) + '.');
        return refreshOne(lot.lot_no);
      })
      .catch(function (err) { say(err.message || 'That did not go through.'); });
  }

  /* ---------- announcements (also the accessible live region) ---------- */
  var live = document.createElement('p');
  live.setAttribute('role', 'status');
  live.setAttribute('aria-live', 'polite');
  live.className = 'live-note';
  document.body.appendChild(live);
  var sayTimer;
  function say(msg) {
    live.textContent = msg;
    live.classList.add('is-up');
    clearTimeout(sayTimer);
    sayTimer = setTimeout(function () { live.classList.remove('is-up'); }, 6000);
  }

  /* ---------- sign in ---------- */
  var authSheet  = document.getElementById('authSheet');
  var authForm   = document.getElementById('authForm');
  var authEmail  = document.getElementById('authEmail');
  var authErr    = document.getElementById('authErr');
  var authSubmit = document.getElementById('authSubmit');
  var authFine   = document.getElementById('authFine');
  var afterAuth  = null;

  function promptSignIn(then) {
    afterAuth = then || null;
    authErr.textContent = '';
    authFine.textContent = API.name === 'local'
      ? 'Local development: no password, and the paddle is issued on first sign-in.'
      : 'We email you a link. No password to remember.';
    authSubmit.disabled = false;
    authSubmit.textContent = 'Continue';
    authSheet.showModal();
    authEmail.focus();
  }

  document.getElementById('authClose').addEventListener('click', function () { authSheet.close(); });
  authSheet.addEventListener('click', function (e) { if (e.target === authSheet) authSheet.close(); });

  authForm.addEventListener('submit', function (e) {
    e.preventDefault();
    var email = (authEmail.value || '').trim();
    if (!email) { authErr.textContent = 'Enter your email address.'; authEmail.focus(); return; }
    authSubmit.disabled = true;
    authErr.textContent = '';
    API.signIn(email)
      .then(function (r) {
        if (r && r.magicLink) {
          authErr.textContent = '';
          authFine.textContent = 'Check ' + r.email + ' for the sign-in link, then come back.';
          authSubmit.textContent = 'Link sent';
          return;
        }
        return refreshMe().then(function () {
          authSheet.close();
          say('Signed in. You are paddle ' + session.paddle + '.');
          var next = afterAuth; afterAuth = null;
          if (next) next();
        });
      })
      .catch(function (err) {
        authErr.textContent = err.message || 'Could not sign in.';
      })
      .then(function () { authSubmit.disabled = false; });
  });

  function onPaddleClick() {
    if (!API.canSignIn) {
      say('This is the demonstration build. There is no paddle to issue.');
      return;
    }
    if (!session.signedIn) { promptSignIn(); return; }
    if (confirm('Sign out of paddle ' + session.paddle + '?')) {
      API.signOut().then(refreshMe).then(function () { say('Signed out.'); });
    }
  }
  ['paddleBtn', 'paddleBtn2'].forEach(function (id) {
    var el = document.getElementById(id);
    if (el) el.addEventListener('click', onPaddleClick);
  });

  function paintPaddle() {
    [['paddleLabel', 'paddleNo'], ['paddleLabel2', 'paddleNo2']].forEach(function (pair) {
      var label = document.getElementById(pair[0]);
      var num   = document.getElementById(pair[1]);
      if (!label || !num) return;
      if (session.signedIn) { label.textContent = 'PADDLE'; num.textContent = session.paddle; }
      else                  { label.textContent = API.canSignIn ? 'Sign in' : 'Demo'; num.textContent = ''; }
    });
  }

  function refreshMe() {
    return API.me().then(function (m) {
      session = { signedIn: !!m.signedIn, paddle: m.paddle, email: m.email };
      paintPaddle();
      LOTS.forEach(paintLot);
      return m;
    }).catch(function () {});
  }

  /* ---------- data ---------- */
  function absorb(rows) {
    LOTS = rows;
    byNo = {};
    LOTS.forEach(function (l) { byNo[l.lot_no] = l; });
  }

  function refreshOne(lotNo) {
    return API.lots().then(function (rows) {
      absorb(rows);
      return API.me ? refreshMe() : null;
    }).then(function () {
      render();
      if (byNo[lotNo]) paintLot(byNo[lotNo]);
    }).catch(function () {});
  }

  /* A realtime row carries only the columns the publication allows. Merge it
     onto what we have rather than replacing the lot wholesale. */
  function onLotChange(row) {
    var lot = byNo[row.lot_no];
    if (!lot) return;
    var wasExt = lot.extension_count;
    ['status', 'current_price_cents', 'bid_count', 'ends_at', 'extension_count', 'buy_now_cents']
      .forEach(function (k) { if (row[k] !== undefined) lot[k] = row[k]; });
    lot.min_next_cents = 0;                      /* force recompute from price */
    paintLot(lot);
    if (row.extension_count > wasExt) flashExtend(lot);
  }

  /* ---------- boot ---------- */
  API.init()
    .then(function (state) {
      absorb(state.lots);
      if (API.canSignIn) return refreshMe();
    })
    .then(function () {
      paintPaddle();          /* demo never calls refreshMe, so label it here */
      render();
      LOTS.forEach(paintLot);
      setInterval(tick, 1000);
      API.subscribe(onLotChange);
      if (API.name === 'demo') {
        var note = document.getElementById('demoNote');
        if (note) note.hidden = false;
      }
      /* positions can change because someone else bid, so re-check periodically */
      if (API.canSignIn) setInterval(function () { if (session.signedIn) refreshMe(); }, 15000);
    })
    .catch(function (err) {
      grid.innerHTML = '';
      empty.hidden = false;
      empty.textContent = 'The lot list could not be loaded. ' + (err.message || '');
    });

  /* ---------- mobile nav ---------- */
  var burger = document.getElementById('burger');
  var mobnav = document.getElementById('mobnav');
  if (burger && mobnav) {
    burger.addEventListener('click', function () {
      var open = mobnav.classList.toggle('is-open');
      burger.setAttribute('aria-expanded', open ? 'true' : 'false');
      burger.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
    });
    mobnav.addEventListener('click', function (e) {
      if (e.target.tagName === 'A') {
        mobnav.classList.remove('is-open');
        burger.setAttribute('aria-expanded', 'false');
      }
    });
  }

  /* ---------- one quiet reveal ---------- */
  if (window.IntersectionObserver && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) { entry.target.classList.add('is-in'); io.unobserve(entry.target); }
      });
    }, { rootMargin: '0px 0px -8% 0px' });
    Array.prototype.forEach.call(document.querySelectorAll('.rise'), function (el) { io.observe(el); });
  } else {
    Array.prototype.forEach.call(document.querySelectorAll('.rise'), function (el) { el.classList.add('is-in'); });
  }
})();
