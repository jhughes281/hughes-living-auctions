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

  /* ---------- lot state, read the same way everywhere ----------
     The engine owns status, but the page still has to draw a lot whose clock
     ran out before the sweeper marked it, and one that is listed but has not
     opened yet. Three answers: 'open', 'upcoming', 'closed'. */
  function stateOf(lot) {
    if (lot.status !== 'open') return 'closed';
    var now = API.serverNow().getTime();
    if (new Date(lot.ends_at).getTime() <= now) return 'closed';
    if (lot.opens_at && new Date(lot.opens_at).getTime() > now) return 'upcoming';
    return 'open';
  }
  function isOpen(lot)   { return stateOf(lot) === 'open'; }
  /* `sold` is the engine's word (0007): false when a reserve was not met even
     though bids were placed. Older rows and the demo backend do not carry it,
     so fall back to the bid count there. */
  function hasHammer(lot){
    if (stateOf(lot) !== 'closed') return false;
    return typeof lot.sold === 'boolean' ? lot.sold : lot.bid_count > 0;
  }

  function stubLabels(lot) {
    var st = stateOf(lot);
    return {
      price: st === 'closed'
        ? (hasHammer(lot) ? 'Hammer' : lot.bid_count > 0 ? 'Closed, reserve not met' : 'Closed, no bids')
        : 'Current bid',
      clock: st === 'closed' ? 'Closed' : st === 'upcoming' ? 'Opens in' : 'Closes in',
      button: st === 'closed' ? 'Closed' : st === 'upcoming' ? 'Not open yet' : 'Place bid',
      disabled: st !== 'open'
    };
  }

  /* One card template for the grid and the hero. The hero gets the live badge
     where the grid card names its pallet, and an h2 because it is the page's
     first real heading after the title. */
  function cardHTML(lot, opts) {
    opts = opts || {};
    var on = watching.indexOf(lot.lot_no) !== -1;
    var st = stateOf(lot);
    var L = stubLabels(lot);
    var mine = !!(window.HLA_AUTH && window.HLA_AUTH.isLeading(lot.lot_no));
    var H = opts.feature ? 'h2' : 'h3';
    var badge = opts.feature
      ? (st === 'open' ? '<span class="live">Bidding now</span>'
         : st === 'upcoming' ? '<span class="live live--soon">Opens soon</span>'
         : '<span class="live live--done">Last to close</span>')
      : '<span class="tag__src">Pallet ' + esc(lot.pallet) + '</span>';
    return '' +
    '<article class="tag' + (opts.feature ? ' tag--feature' : '') + (mine ? ' is-mine' : '') +
             '" data-lot="' + lot.lot_no + '" data-state="' + st + '">' +
      '<span class="tag__punch" aria-hidden="true"></span>' +
      '<div class="tag__head">' +
        '<span class="tag__id">LOT ' + lot.lot_no + '</span>' +
        badge +
        '<button class="watch" type="button" aria-pressed="' + (on ? 'true' : 'false') +
                '" aria-label="Watch lot ' + lot.lot_no + '">' + starSVG(on) + '</button>' +
      '</div>' +
      '<div class="tag__photo">' +
        '<a href="lot.html?lot=' + lot.lot_no + '" aria-label="Open lot ' + lot.lot_no + '">' +
        '<img src="' + esc(lot.image_path) + '" alt="' + esc(lot.alt_text) + '"' +
             (opts.feature ? ' fetchpriority="high"' : ' loading="lazy"') +
             ' width="800" height="600">' +
        '</a>' +
        '<span class="grade grade--' + esc(lot.grade) + '">Grade ' + esc(lot.grade).toUpperCase() + '</span>' +
      '</div>' +
      '<div class="tag__body">' +
        '<p class="tag__cat">' + esc(lot.category) +
          (opts.feature && lot.pallet ? ' &middot; Pallet ' + esc(lot.pallet) : '') + '</p>' +
        '<' + H + ' class="tag__title"><a href="lot.html?lot=' + lot.lot_no + '">' + esc(lot.title) + '</a></' + H + '>' +
        (lot.retail_cents ? '<p class="tag__retail">Retail <s>' + money(lot.retail_cents) + '</s></p>' : '') +
        '<dl class="ledger">' +
          '<div class="ledger__row"><dt>Found</dt><dd>' + esc(lot.found) + '</dd></div>' +
          '<div class="ledger__row is-fixed"><dt>Fixed</dt><dd>' + esc(lot.fixed) + '</dd></div>' +
          '<div class="ledger__row is-flaw"><dt>Still</dt><dd>' + esc(lot.still) + '</dd></div>' +
        '</dl>' +
      '</div>' +
      '<div class="stub">' +
        '<div class="stub__bid">' +
          '<span class="lbl">' + L.price + '</span>' +
          '<span class="amt">' + money(priceOf(lot)) + '</span>' +
          '<span class="meta">' + lot.bid_count + (lot.bid_count === 1 ? ' bid' : ' bids') + '</span>' +
        '</div>' +
        '<div class="stub__clock"><span class="lbl">' + L.clock + '</span>' +
          '<time datetime="' + esc(lot.ends_at) + '">—</time></div>' +
        '<p class="mine-flag">' + (opts.feature ? 'You hold this lot' : 'You are the high bidder') + '</p>' +
        '<div class="stub__acts">' +
          '<button class="btn btn--bid" type="button"' + (L.disabled ? ' disabled' : '') + '>' + L.button + '</button>' +
          (lot.buy_now_cents && st === 'open'
            ? '<button class="btn btn--buy" type="button">Buy ' + money(lot.buy_now_cents) + '</button>'
            : '') +
        '</div>' +
      '</div>' +
    '</article>';
  }

  /* Nothing to feature: say what the schedule is instead of showing a dead lot. */
  function quietFeatureHTML(upcoming) {
    var when = upcoming
      ? 'The next lots open ' + esc(dateWords(upcoming.opens_at)) + '.'
      : 'Pallets come in Tuesday, lots open Friday, everything closes Sunday night.';
    return '' +
    '<article class="tag tag--feature tag--quiet">' +
      '<span class="tag__punch" aria-hidden="true"></span>' +
      '<div class="tag__body">' +
        '<p class="tag__cat">Between sales</p>' +
        '<h2 class="tag__title">Nothing is open right now.</h2>' +
        '<p class="tag__retail">' + when +
          (LOTS.some(hasHammer) ? ' Results from the last sale are <a href="#closed">below</a>.' : '') + '</p>' +
      '</div>' +
    '</article>';
  }

  function dateWords(iso) {
    var d = new Date(iso);
    return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' }) +
           ' at ' + d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
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
  var lotsLede   = document.getElementById('lotsLede');
  var eyebrow    = document.getElementById('heroEyebrow');
  var closedBody = document.getElementById('closedBody');
  var closedTbl  = document.getElementById('closedTable');
  var closedEmpty= document.getElementById('closedEmpty');
  var closedLede = document.getElementById('closedLede');

  function paintClock(lot) {
    var els = document.querySelectorAll('.tag[data-lot="' + lot.lot_no + '"] .stub__clock');
    var st = stateOf(lot);
    var now = API.serverNow().getTime();
    var left = st === 'upcoming'
      ? new Date(lot.opens_at).getTime() - now
      : new Date(lot.ends_at).getTime() - now;
    for (var i = 0; i < els.length; i++) {
      var box = els[i], t = box.querySelector('time');
      if (!t) continue;
      t.textContent = formatLeft(left);
      t.setAttribute('datetime', st === 'upcoming' ? lot.opens_at : lot.ends_at);
      box.classList.toggle('is-final', st === 'open' && left < 15 * 60 * 1000);
      box.classList.toggle('is-done', st === 'closed');
    }
    /* A clock that just ran out changes the lot's state; the card and the
       grid it sits in need to follow, even before the sweeper's row arrives. */
    var card = document.querySelector('.tag[data-lot="' + lot.lot_no + '"]');
    if (card && card.dataset.state !== st) render();
  }

  function paintLot(lot) {
    var cards = document.querySelectorAll('.tag[data-lot="' + lot.lot_no + '"]');
    var L = stubLabels(lot);
    var st = stateOf(lot);
    for (var i = 0; i < cards.length; i++) {
      var card = cards[i];
      card.dataset.state = st;
      var lbl = card.querySelector('.stub__bid .lbl');
      if (lbl) lbl.textContent = L.price;
      var amt = card.querySelector('.stub__bid .amt');
      if (amt) amt.textContent = money(priceOf(lot));
      var meta = card.querySelector('.stub__bid .meta');
      if (meta) meta.textContent = lot.bid_count + (lot.bid_count === 1 ? ' bid' : ' bids');
      var clk = card.querySelector('.stub__clock .lbl');
      if (clk) clk.textContent = L.clock;
      card.classList.toggle('is-mine', !!(window.HLA_AUTH && window.HLA_AUTH.isLeading(lot.lot_no)));

      var bidBtn = card.querySelector('.btn--bid');
      if (bidBtn) { bidBtn.disabled = L.disabled; bidBtn.textContent = L.button; }
      var buyBtn = card.querySelector('.btn--buy');
      if (buyBtn && (!lot.buy_now_cents || st !== 'open')) buyBtn.remove();
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
      case 'soon':  return isOpen(lot) && left < 24 * 3600 * 1000;
      case 'buy':   return !!lot.buy_now_cents;
      case 'clean': return lot.grade === 'a';
      case 'watch': return watching.indexOf(lot.lot_no) !== -1;
      default:         return true;
    }
  }

  /* The hero is the open lot with the most action; ties go to the one closing
     soonest. With nothing open, the most recent hammer stands in, and with
     nothing at all the card says when the next sale is. */
  function chooseHero() {
    var open = LOTS.filter(isOpen).sort(function (a, b) {
      return (b.bid_count - a.bid_count) || (new Date(a.ends_at) - new Date(b.ends_at));
    });
    if (open.length) return open[0];
    var upcoming = LOTS.filter(function (l) { return stateOf(l) === 'upcoming'; })
      .sort(function (a, b) { return new Date(a.opens_at) - new Date(b.opens_at); });
    if (upcoming.length) return upcoming[0];
    var hammered = LOTS.filter(hasHammer).sort(function (a, b) {
      return new Date(b.ends_at) - new Date(a.ends_at);
    });
    return hammered[0] || null;
  }

  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }
  function listWords(items) {
    if (items.length <= 1) return items.join('');
    if (items.length === 2) return items[0] + ' & ' + items[1];
    return items.slice(0, -1).join(', ') + ' & ' + items[items.length - 1];
  }

  function paintHeader(hero) {
    var open = LOTS.filter(isOpen);
    var upcoming = LOTS.filter(function (l) { return stateOf(l) === 'upcoming'; });
    var pallets = [];
    open.forEach(function (l) { if (l.pallet && pallets.indexOf(l.pallet) === -1) pallets.push(l.pallet); });
    pallets.sort();

    if (open.length) {
      eyebrow.textContent = 'Bidding open' +
        (pallets.length ? ' · ' + (pallets.length === 1 ? 'Pallet ' : 'Pallets ') + listWords(pallets) : '');
      var rest = open.length - (hero && isOpen(hero) ? 1 : 0);
      lotsLede.textContent = (rest > 0
          ? plural(rest, 'more piece', 'more pieces') +
            (pallets.length === 1 ? ' off pallet ' + pallets[0] : pallets.length ? ' off ' + pallets.length + ' pallets' : '') + '. '
          : 'One lot open. ') +
        'Each opened at a dollar and closes on its own clock. Bid in the last two minutes and the clock pushes out two more.';
    } else if (upcoming.length) {
      eyebrow.textContent = 'Next sale opens ' + dateWords(upcoming[0].opens_at);
      lotsLede.textContent = plural(upcoming.length, 'lot is', 'lots are') +
        ' listed and not open yet. Read the tags now; the clocks start ' + dateWords(upcoming[0].opens_at) + '.';
    } else {
      eyebrow.textContent = 'Between sales · Pallets in Tuesday, lots open Friday';
      lotsLede.textContent = 'Nothing is open right now. Pallets come in Tuesday, lots open Friday and close Sunday night. What hammered last time is further down the page.';
    }
  }

  function render() {
    var hero = chooseHero();
    var live = LOTS.filter(function (l) { return stateOf(l) !== 'closed'; });
    var shown = live.filter(function (l) { return !(hero && l.lot_no === hero.lot_no) && passes(l); });

    feature.innerHTML = hero ? cardHTML(hero, { feature: true })
                             : quietFeatureHTML(null);
    grid.innerHTML = shown.map(function (l) { return cardHTML(l); }).join('');

    var openCount = LOTS.filter(isOpen).length;
    empty.hidden = shown.length > 0;
    empty.textContent = live.length === 0
      ? 'Nothing is open right now. The next pallet’s lots print here the moment they open.'
      : 'No lots match that filter right now.';
    countEl.textContent = filter === 'all'
      ? (openCount ? plural(openCount, 'lot', 'lots') + ' open' : 'Nothing open')
      : plural(shown.length, 'lot', 'lots') + ' shown';

    paintHeader(hero);
    renderClosed();
    if (hero) paintLot(hero);
    shown.forEach(paintClock);
  }

  /* ---------- what closed ---------- */
  function renderClosed() {
    var rows = LOTS.filter(hasHammer).sort(function (a, b) {
      return new Date(b.ends_at) - new Date(a.ends_at);
    }).slice(0, 12);
    closedTbl.hidden = rows.length === 0;
    closedEmpty.hidden = rows.length > 0;
    if (!rows.length) {
      closedLede.textContent = 'Hammer prices print here as lots close, with the reason each piece was on our floor instead of a showroom.';
      closedBody.innerHTML = '';
      return;
    }
    var pallets = [];
    rows.forEach(function (l) { if (l.pallet && pallets.indexOf(l.pallet) === -1) pallets.push(l.pallet); });
    pallets.sort();
    closedLede.textContent = 'Hammer prices from ' +
      (pallets.length ? (pallets.length === 1 ? 'pallet ' : 'pallets ') + listWords(pallets) : 'the last sale') +
      ', with the reason each piece was on our floor instead of a showroom.';
    closedBody.innerHTML = rows.map(function (l) {
      return '<tr>' +
        '<td><a href="lot.html?lot=' + l.lot_no + '">' + esc(l.title) + '</a></td>' +
        '<td>' + (l.retail_cents ? money(l.retail_cents) : '—') + '</td>' +
        '<td>' + money(l.current_price_cents) + '</td>' +
        '<td>' + esc(l.found) + ' ' + esc(l.fixed) + '</td>' +
      '</tr>';
    }).join('');
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
  /* One idempotency key per opening of the sheet, reused across retries. A
     request that timed out after the engine recorded it is replayed, not
     repeated, when the person presses the button again. A fresh key per
     press would defeat the whole mechanism. */
  var bidKey = null;
  function newKey(prefix, lotNo) {
    var rnd = (window.crypto && crypto.getRandomValues)
      ? Array.prototype.map.call(crypto.getRandomValues(new Uint8Array(8)), function (b) {
          return ('0' + b.toString(16)).slice(-2); }).join('')
      : Math.random().toString(16).slice(2);
    return prefix + '-' + lotNo + '-' + rnd;
  }

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
    bidKey = newKey('bid', lot.lot_no);
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
    var key = bidKey || newKey('bid', current.lot_no);

    API.placeBid(current.lot_no, cents, fProtect.checked, key)
      .then(function (r) {
        bidKey = null;                       /* spent; the next opening mints another */
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
    API.buyNow(lot.lot_no, false, newKey('buy', lot.lot_no))
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
  /* Lives in auth.js now, shared with lot.html and paddle.html so the three
     pages cannot drift apart. */
  var AUTH = window.HLA_AUTH;
  function promptSignIn(then) { AUTH.open(then); }
  function refreshMe() {
    return AUTH.refresh().then(function (s) {
      session = { signedIn: s.signedIn, paddle: s.paddle, email: s.email };
      LOTS.forEach(paintLot);
      return s;
    });
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
    var wasExt = lot.extension_count, wasState = stateOf(lot);
    ['status', 'current_price_cents', 'bid_count', 'ends_at', 'extension_count', 'buy_now_cents', 'sold']
      .forEach(function (k) { if (row[k] !== undefined) lot[k] = row[k]; });
    lot.min_next_cents = 0;                      /* force recompute from price */
    /* A lot that just closed leaves the grid and may join the results table;
       a first bid can change which lot is featured. Re-lay the page then. */
    var hero = chooseHero();
    var heroEl = document.querySelector('.tag--feature[data-lot]');
    var heroChanged = !heroEl || !hero || Number(heroEl.dataset.lot) !== hero.lot_no;
    if (stateOf(lot) !== wasState || heroChanged) render();
    else paintLot(lot);
    if (row.extension_count > wasExt) flashExtend(lot);
  }

  /* ---------- boot ---------- */
  AUTH.bindPaddle();
  var hashErr = AUTH.readHashError();

  API.init()
    .then(function (state) {
      absorb(state.lots);
      if (API.canSignIn) return refreshMe();
    })
    .then(function () {
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
      if (hashErr) setTimeout(function () { say(hashErr); }, 400);
    })
    .catch(function (err) {
      grid.innerHTML = '';
      empty.hidden = false;
      empty.textContent = 'The lot list could not be loaded. ' + (err.message || '');
      feature.innerHTML = '<article class="tag tag--feature tag--quiet"><span class="tag__punch" aria-hidden="true"></span>' +
        '<div class="tag__body"><p class="tag__cat">Could not reach the sale</p>' +
        '<h2 class="tag__title">The lots did not load.</h2>' +
        '<p class="tag__retail">' + esc(err.message || 'Try again in a moment.') + '</p></div></article>';
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
