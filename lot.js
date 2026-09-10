/* One lot, on its own page, at its own address.

   Everything a bidder needs to decide, and a URL they can send to somebody.
   Prices, minimums and clocks come from the engine exactly as on the list. */
(function () {
  'use strict';

  var API  = window.HLA_API;
  var AUTH = window.HLA_AUTH;
  var host = document.getElementById('lotHost');
  var lotNo = Number(new URLSearchParams(location.search).get('lot'));
  var lot = null;
  var shots = [];
  var showing = 0;

  function money(c) { return '$' + Math.round(c / 100).toLocaleString('en-US'); }
  function money2(c) { return '$' + (c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function left(ms) {
    if (ms <= 0) return 'closed';
    var s = Math.floor(ms / 1000), d = Math.floor(s / 86400); s -= d * 86400;
    var h = Math.floor(s / 3600); s -= h * 3600;
    var m = Math.floor(s / 60); s -= m * 60;
    return d > 0 ? d + 'd ' + pad(h) + 'h ' + pad(m) + 'm' : pad(h) + ':' + pad(m) + ':' + pad(s);
  }
  function esc(v) {
    return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function priceOf(l) { return l.bid_count > 0 ? l.current_price_cents : l.opening_cents; }
  function minNext(l) {
    if (typeof l.min_next_cents === 'number' && l.min_next_cents > 0) return l.min_next_cents;
    return l.bid_count === 0 ? l.opening_cents
      : l.current_price_cents + API.incrementCents(l.current_price_cents);
  }

  var SHOT_LABEL = {
    piece:  'The piece',
    flaw:   'The flaw',
    repair: 'The repair',
    detail: 'Detail'
  };

  var GRADE = {
    a: 'Functionally new. Nothing wrong we could find.',
    b: 'Repaired, and the repair leaves a trace you could point at.',
    c: 'Repaired, with a flaw that stays visible.',
    d: 'Parts or project. Sold as it sits, with no bench protection.'
  };

  /* The most common question about a piece of furniture, answered before it is
     asked. Any axis may be missing — a lamp has no meaningful depth. */
  function dimensionLine(l) {
    var parts = [];
    if (l.width_in)  parts.push(l.width_in  + '"W');
    if (l.depth_in)  parts.push(l.depth_in  + '"D');
    if (l.height_in) parts.push(l.height_in + '"H');
    var facets = [l.room, l.style, l.material].filter(Boolean);
    if (!parts.length && !facets.length && !l.brand) return '';
    return '<p class="lot__spec">' +
      (parts.length ? '<span class="lot__dims">' + parts.join(' &times; ') + '</span>' : '') +
      (l.brand ? '<span class="lot__facet">' + esc(l.brand) + '</span>' : '') +
      facets.map(function (f) { return '<span class="lot__facet">' + esc(f) + '</span>'; }).join('') +
      '</p>';
  }

  function render() {
    if (!lot) return;
    var closed = lot.status !== 'open';
    var mine = AUTH.isLeading(lot.lot_no);
    var myMax = AUTH.myMax(lot.lot_no);

    var hasFlaw = shots.some(function (x) { return x.kind === 'flaw'; });
    var cur = shots[showing] || { path: lot.image_path, alt: lot.alt_text, kind: 'piece' };

    host.innerHTML = '' +
    '<article class="lot' + (mine ? ' is-mine' : '') + '">' +
      '<div class="lot__media">' +
        '<img id="lotShot" src="' + esc(cur.path) + '" alt="' + esc(cur.alt) + '" width="1000" height="750">' +
        '<span class="grade grade--' + esc(lot.grade) + '">Grade ' + esc(lot.grade).toUpperCase() + '</span>' +
        (shots.length > 1
          ? '<ul class="shots" role="list">' + shots.map(function (sh, i) {
              return '<li><button type="button" class="shot' + (i === showing ? ' is-on' : '') +
                     '" data-shot="' + i + '" aria-current="' + (i === showing ? 'true' : 'false') + '">' +
                     '<img src="' + esc(sh.path) + '" alt="" width="120" height="90">' +
                     '<span>' + SHOT_LABEL[sh.kind] + '</span></button></li>';
            }).join('') + '</ul>'
          : '') +
        /* The caption ties the picture to the sentence it is evidence for. */
        (cur.kind === 'flaw'
          ? '<p class="lot__shotnote is-flaw"><b>This is the flaw.</b> ' + esc(lot.still) + '</p>'
          : cur.kind === 'repair'
          ? '<p class="lot__shotnote is-repair"><b>This is the repair.</b> ' + esc(lot.fixed) + '</p>'
          : hasFlaw
          ? ''
          : '<p class="lot__shotnote">One photograph so far. The flaw described below is not ' +
            'pictured — ask before you bid if it matters to you.</p>') +
      '</div>' +

      '<div class="lot__detail">' +
        '<p class="tag__cat">' + esc(lot.category) +
          (lot.pallet ? ' &middot; Pallet ' + esc(lot.pallet) : '') +
          ' &middot; Lot ' + lot.lot_no + '</p>' +
        '<h1 class="lot__title">' + esc(lot.title) + '</h1>' +
        (lot.retail_cents ? '<p class="tag__retail">Retail <s>' + money(lot.retail_cents) + '</s></p>' : '') +
        dimensionLine(lot) +

        '<dl class="ledger">' +
          '<div class="ledger__row"><dt>Found</dt><dd>' + esc(lot.found) + '</dd></div>' +
          '<div class="ledger__row is-fixed"><dt>Fixed</dt><dd>' + esc(lot.fixed) + '</dd></div>' +
          '<div class="ledger__row is-flaw"><dt>Still</dt><dd>' + esc(lot.still) + '</dd></div>' +
        '</dl>' +

        '<p class="lot__grade"><b>Grade ' + esc(lot.grade).toUpperCase() + '</b> — ' +
          GRADE[lot.grade] + ' <a href="index.html#tag">How grading works</a></p>' +

        '<div class="lot__stub">' +
          '<div class="stub__bid">' +
            '<span class="lbl">' + (closed ? 'Hammer' : 'Current bid') + '</span>' +
            '<span class="amt" id="lotPrice">' + money(priceOf(lot)) + '</span>' +
            '<span class="meta" id="lotBids">' + lot.bid_count +
              (lot.bid_count === 1 ? ' bid' : ' bids') + '</span>' +
          '</div>' +
          '<div class="stub__clock" id="lotClockBox">' +
            '<span class="lbl">' + (closed ? 'Closed' : 'Closes in') + '</span>' +
            '<time id="lotClock" datetime="' + esc(lot.ends_at) + '">&mdash;</time>' +
          '</div>' +
          (myMax ? '<p class="lot__mymax">Your maximum on this lot is ' + money(myMax) +
                   '. Only you can see it.</p>' : '') +
          '<p class="mine-flag">You are the high bidder</p>' +
          '<div class="stub__acts">' +
            '<button class="btn btn--bid" type="button"' + (closed ? ' disabled' : '') + '>' +
              (closed ? 'Closed' : 'Place bid') + '</button>' +
            (lot.buy_now_cents && !closed
              ? '<button class="btn btn--buy" type="button">Buy ' + money(lot.buy_now_cents) + '</button>'
              : '') +
          '</div>' +
          (closed ? '' : '<p class="lot__min">Minimum bid ' + money(minNext(lot)) +
                          '. Whole dollars. We bid only as much as it takes to keep you in ' +
                          'front, up to your maximum.</p>') +
        '</div>' +
      '</div>' +
    '</article>';

    tick();
  }

  function tick() {
    if (!lot) return;
    var t = document.getElementById('lotClock');
    if (!t) return;
    var box = document.getElementById('lotClockBox');
    var ms = new Date(lot.ends_at).getTime() - API.serverNow().getTime();
    t.textContent = left(ms);
    box.classList.toggle('is-final', ms > 0 && ms < 15 * 60 * 1000);
    box.classList.toggle('is-done', ms <= 0);
  }

  /* ---------- bidding ---------- */
  document.addEventListener('click', function (e) {
    var thumb = e.target.closest('[data-shot]');
    if (thumb) { showing = Number(thumb.dataset.shot); render(); return; }
    if (e.target.closest('.btn--bid')) { AUTH.require(openBid); return; }
    if (e.target.closest('.btn--buy')) { AUTH.require(doBuy); return; }
  });

  function openBid() {
    var min = minNext(lot);
    var dollars = prompt('Your maximum for lot ' + lot.lot_no + '\n\n' +
      lot.title + '\nCurrent bid ' + money(priceOf(lot)) + ', minimum ' + money(min) +
      '.\nWe bid only as much as it takes to keep you in front.', String(min / 100));
    if (dollars === null) return;
    var cents = Math.round(parseFloat(dollars) * 100);
    if (!isFinite(cents)) { say('That is not an amount.'); return; }
    API.placeBid(lot.lot_no, cents, false, 'lot-' + lot.lot_no + '-' + cents + '-' + Date.now())
      .then(function (r) {
        say(r.status === 'leading'
          ? 'You are the high bidder at ' + money(r.price_cents) + '.'
          : 'Outbid. It stands at ' + money(r.price_cents) + '.');
        return reload();
      })
      .catch(function (err) { say(err.message || 'That bid did not go through.'); });
  }

  function doBuy() {
    if (!confirm('Buy lot ' + lot.lot_no + ' now for ' + money(lot.buy_now_cents) + '?')) return;
    API.buyNow(lot.lot_no, false, 'buy-' + lot.lot_no + '-' + Date.now())
      .then(function (r) { say('Lot ' + r.lot_no + ' is yours at ' + money(r.price_cents) + '.'); return reload(); })
      .catch(function (err) { say(err.message || 'That did not go through.'); });
  }

  /* ---------- announcements ---------- */
  var live = document.createElement('p');
  live.className = 'live-note';
  live.setAttribute('role', 'status');
  live.setAttribute('aria-live', 'polite');
  document.body.appendChild(live);
  var t;
  function say(m) {
    live.textContent = m;
    live.classList.add('is-up');
    clearTimeout(t);
    t = setTimeout(function () { live.classList.remove('is-up'); }, 6000);
  }

  function reload() {
    return API.lots().then(function (rows) {
      lot = rows.filter(function (l) { return l.lot_no === lotNo; })[0] || lot;
      return AUTH.refresh();
    }).then(render);   /* `showing` is deliberately kept: a bid should not
                          throw you back to the first photograph. */
  }

  /* ---------- boot ---------- */
  if (!lotNo) {
    host.innerHTML = '<p class="lots__empty">No lot number in the address. ' +
      '<a href="index.html#lots">See the open lots</a>.</p>';
    return;
  }

  AUTH.bindPaddle();
  var hashErr = AUTH.readHashError();

  API.init()
    .then(function (state) {
      lot = state.lots.filter(function (l) { return l.lot_no === lotNo; })[0];
      if (!lot) {
        host.innerHTML = '<p class="lots__empty">There is no lot ' + lotNo + '. ' +
          '<a href="index.html#lots">See what is open</a>.</p>';
        return;
      }
      document.title = 'Lot ' + lot.lot_no + ' — ' + lot.title + ' — Hughes Living Auctions';
      return API.lotImages(lot.lot_no).then(function (rows) {
        shots = rows.length ? rows : [];
        if (API.canSignIn) return AUTH.refresh();
      });
    })
    .then(function () {
      if (!lot) return;
      render();
      setInterval(tick, 1000);
      API.subscribe(function (row) {
        if (row.lot_no !== lotNo) return;
        ['status', 'current_price_cents', 'bid_count', 'ends_at', 'extension_count', 'buy_now_cents']
          .forEach(function (k) { if (row[k] !== undefined) lot[k] = row[k]; });
        lot.min_next_cents = 0;
        render();
      });
      if (hashErr) setTimeout(function () { say(hashErr); }, 400);
    })
    .catch(function (err) {
      host.innerHTML = '<p class="lots__empty">Could not load that lot. ' +
        esc(err.message || '') + '</p>';
    });
})();
