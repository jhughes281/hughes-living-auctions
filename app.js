/* Hughes Living Auctions — lot engine
   Clocks, proxy bidding, the two-minute extension, watchlist, filters.
   Demo build: bids live in the page, not on a server. */
(function () {
  'use strict';

  var START = Date.now();

  /* Lot 118 is rendered in the markup as the hero. Everything else is built from here.
     endsIn = seconds from page load, so the clocks read sensibly in a demo. */
  var LOTS = [
    { id: 118, feature: true, endsIn: 8940, price: 640, bids: 23, grade: 'b' },

    { id: 119, img: 'lot-recliner.jpg', cat: 'Recliner', pallet: '0442', grade: 'c',
      title: 'Kanlow Rocker Recliner, Nutmeg',
      alt: 'Nutmeg upholstered rocker recliner, three-quarter view.',
      retail: 729, price: 95, bids: 11, endsIn: 2615,
      found: 'Reclining mechanism jammed shut and the release handle snapped off in the carton.',
      fixed: 'New handle assembly and release cable, then cycled forty times on the bench.',
      still: 'Scuff on the outside left arm, about the size of a quarter.' },

    { id: 121, img: 'lot-dresser.jpg', cat: 'Dresser and mirror', pallet: '0442', grade: 'b',
      title: 'Cornina 6-Drawer Dresser with Mirror',
      alt: 'Six-drawer dresser with a rectangular mirror, front view.',
      retail: 1149, price: 205, bids: 17, endsIn: 12480,
      found: 'Arrived with no drawer pulls and no mirror mounting hardware. Nothing broken, just naked.',
      fixed: 'Full pull set and mirror brackets sourced and fitted, drawers aligned.',
      still: 'Two of the eight pulls are a close match rather than an exact one.' },

    { id: 122, img: 'lot-chairs.jpg', cat: 'Dining chairs, pair', pallet: '0447', grade: 'a',
      title: 'Milena Dining Chairs, Ivory, Set of 2',
      alt: 'Pair of ivory upholstered dining chairs.',
      retail: 329, price: 60, bids: 8, endsIn: 720,
      found: 'Customer return. Box opened, chairs never assembled.',
      fixed: 'Assembled, inspected, hardware confirmed complete.',
      still: 'Nothing. This one only lost its box.' },

    { id: 124, img: 'lot-rug.jpg', cat: 'Area rug, 5 x 7', pallet: '0447', grade: 'b',
      title: 'Shaggy Area Rug, Brown and Beige',
      alt: 'Brown and beige shag area rug photographed flat.',
      retail: 219, price: 25, bids: 6, endsIn: 26400,
      found: 'Returned with pet hair through the pile and one corner folded in storage.',
      fixed: 'Commercially cleaned, then blocked flat for six days.',
      still: 'Slight ripple at one corner. It relaxes under a coffee table.' },

    { id: 125, img: 'lot-lamp.jpg', cat: 'Table lamp', pallet: '0447', grade: 'c',
      title: 'Linus Table Lamp, Brushed Brass',
      alt: 'Brushed brass table lamp base with a drum shade.',
      retail: 129, price: 15, bids: 4, endsIn: 1140,
      found: 'Cord cut off at the plug. No harp and no shade in the carton.',
      fixed: 'Rewired with a new UL cord and plug, new harp fitted, socket tested.',
      still: 'Sold without a shade. The one in the photo is not included.' },

    { id: 127, img: 'lot-tvstand.jpg', cat: 'Media console, 65 in.', pallet: '0442', grade: 'c',
      title: 'Carlina TV Stand, Ivory',
      alt: 'Ivory media console with open shelving, front view.',
      retail: 579, price: 85, bids: 9, endsIn: 40200,
      found: 'Front left corner chipped through the finish down to the substrate.',
      fixed: 'Filled, color matched by hand and sealed.',
      still: 'The repair reads from about three feet. Farther than that it disappears.' },

    { id: 128, img: 'lot-ottoman.jpg', cat: 'Ottoman', pallet: '0447', grade: 'a',
      title: 'Ariana Rectangle Ottoman, Ivory Velvet',
      alt: 'Low ivory velvet rectangular ottoman.',
      retail: 349, price: 40, bids: 5, endsIn: 90600, buyNow: 145,
      found: 'Floor sample. Light dust, no damage.',
      fixed: 'Steam cleaned and legs re-torqued.',
      still: 'Nothing worth printing.' },

    { id: 130, img: 'lot-bench.jpg', cat: 'Dining bench', pallet: '0442', grade: 'b',
      title: 'Lettner Dining Bench, Gray Brown',
      alt: 'Gray brown wooden dining bench with an upholstered seat.',
      retail: 389, price: 55, bids: 7, endsIn: 5400,
      found: 'One leg loose. The screw hole under the seat was stripped out.',
      fixed: 'Hole doweled, re-drilled, glued and clamped overnight.',
      still: 'Repair is under the seat. Sound, and you will not see it.' },

    { id: 131, img: 'lot-headboard.jpg', cat: 'Headboard, queen', pallet: '0447', grade: 'c',
      title: 'Adinton Panel Headboard, Queen',
      alt: 'Brown wood-tone queen panel headboard.',
      retail: 449, price: 30, bids: 3, endsIn: 172800, buyNow: 60,
      found: 'Headboard only. No side rails, no bolt pack.',
      fixed: 'Universal bolt pack included and pre-drilled to fit a standard queen frame.',
      still: 'Still no side rails. Bring a frame or plan on one.' },

    { id: 133, img: 'lot-mattress.jpg', cat: 'Mattress, king', pallet: '0447', grade: 'a',
      title: 'Comfort Plus Euro Top Mattress, King',
      alt: 'King euro top mattress made up on a gray upholstered bed.',
      retail: 899, price: 130, bids: 12, endsIn: 61200, buyNow: 340,
      found: 'Carton torn open at a corner in freight. Inner bag never breached.',
      fixed: 'Nothing to fix. Bag is sealed and it has never been slept on.',
      still: 'The box is ugly. The mattress is not.' },

    { id: 134, img: 'lot-barset.jpg', cat: 'Counter set, 5 pc', pallet: '0442', grade: 'b',
      title: 'Hazelteen Counter Table with Four Stools',
      alt: 'Medium brown counter height dining table with four matching stools.',
      retail: 899, price: 175, bids: 14, endsIn: 33000,
      found: 'One stool came through with a cracked weld at the footrest.',
      fixed: 'Weld ground out, re-run, and repainted to match the set.',
      still: 'The repainted section sits about a half shade darker than the others.' },

    { id: 135, img: 'lot-mirror.jpg', cat: 'Wall mirror', pallet: '0442', grade: 'b',
      title: 'Modest Round Wall Mirror, Gold',
      alt: 'Round wall mirror with a thin gold frame.',
      retail: 199, price: 35, bids: 6, endsIn: 3300,
      found: 'Frame separated at one corner joint. Glass untouched.',
      fixed: 'Re-glued, clamped, and hanging hardware added.',
      still: 'Hairline gap remains at the top right corner of the frame.' }
  ];

  var GRADE_LABEL = { a: 'Grade A', b: 'Grade B', c: 'Grade C', d: 'Grade D' };

  /* ---------- storage ---------- */
  function load(key, fallback) {
    try { var v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; }
    catch (e) { return fallback; }
  }
  function save(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* private mode */ }
  }

  var watching = load('hla.watch', []);
  var paddle = load('hla.paddle', null);
  if (!paddle) { paddle = 4000 + Math.floor(Math.random() * 900); save('hla.paddle', paddle); }
  ['paddleNo', 'paddleNo2'].forEach(function (id) {
    var el = document.getElementById(id);
    if (el) el.textContent = paddle;
  });

  /* ---------- money and clocks ---------- */
  function money(n) {
    return '$' + Math.round(n).toLocaleString('en-US');
  }
  function money2(n) {
    return '$' + n.toFixed(2);
  }
  function increment(price) {
    if (price < 50) return 5;
    if (price < 250) return 10;
    if (price < 1000) return 25;
    return 50;
  }
  function minNext(price) { return price + increment(price); }
  function protectionOn(amount) { return Math.max(8, amount * 0.06); }

  function endsAt(lot) { return START + lot.endsIn * 1000; }

  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function formatLeft(ms) {
    if (ms <= 0) return 'Closed';
    var s = Math.floor(ms / 1000);
    var d = Math.floor(s / 86400);
    var h = Math.floor((s % 86400) / 3600);
    var m = Math.floor((s % 3600) / 60);
    var sec = s % 60;
    if (d > 0) return d + 'd ' + pad(h) + 'h ' + pad(m) + 'm';
    return pad(h) + ':' + pad(m) + ':' + pad(sec);
  }

  /* ---------- markup ---------- */
  function star(id, on) {
    return '<button class="watch" type="button" data-watch="' + id + '" aria-pressed="' + (on ? 'true' : 'false') +
      '" aria-label="Watch lot ' + id + '">' +
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.6l2.6 5.3 5.8.8-4.2 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8L3.6 9.7l5.8-.8z"/></svg>' +
      '</button>';
  }

  function cardHTML(lot) {
    var watched = watching.indexOf(lot.id) > -1;
    return '' +
      '<article class="tag" data-lot="' + lot.id + '">' +
        '<span class="tag__punch" aria-hidden="true"></span>' +
        '<div class="tag__head">' +
          '<span class="tag__id">LOT ' + lot.id + '</span>' +
          '<span class="tag__src">Pallet ' + lot.pallet + '</span>' +
          star(lot.id, watched) +
        '</div>' +
        '<div class="tag__photo">' +
          '<img src="img/' + lot.img + '" alt="' + lot.alt + '" loading="lazy" width="1000" height="750">' +
          '<span class="grade grade--' + lot.grade + '">' + GRADE_LABEL[lot.grade] + '</span>' +
        '</div>' +
        '<div class="tag__body">' +
          '<p class="tag__cat">' + lot.cat + '</p>' +
          '<h3 class="tag__title">' + lot.title + '</h3>' +
          '<p class="tag__retail">Retail <s>' + money(lot.retail) + '</s>' +
            (lot.buyNow ? ' &middot; Buy it now ' + money(lot.buyNow) : '') + '</p>' +
          '<dl class="ledger">' +
            '<div class="ledger__row"><dt>Found</dt><dd>' + lot.found + '</dd></div>' +
            '<div class="ledger__row is-fixed"><dt>Fixed</dt><dd>' + lot.fixed + '</dd></div>' +
            '<div class="ledger__row is-flaw"><dt>Still</dt><dd>' + lot.still + '</dd></div>' +
          '</dl>' +
        '</div>' +
        '<div class="stub">' +
          '<div class="stub__bid">' +
            '<span class="lbl">Current bid</span>' +
            '<span class="amt" data-amt>' + money(lot.price) + '</span>' +
            '<span class="meta" data-bids>' + lot.bids + ' bids</span>' +
          '</div>' +
          '<div class="stub__clock" data-clock>' +
            '<span class="lbl">Closes in</span>' +
            '<time datetime="">--:--:--</time>' +
          '</div>' +
          '<p class="mine-flag">You hold this lot</p>' +
          '<div class="stub__acts">' +
            '<button class="btn" type="button" data-bid="' + lot.id + '">Place bid</button>' +
            (lot.buyNow ? '<button class="btn btn--buy" type="button" data-buy="' + lot.id + '">Buy ' + money(lot.buyNow) + '</button>' : '') +
          '</div>' +
        '</div>' +
      '</article>';
  }

  var grid = document.getElementById('lotGrid');
  grid.innerHTML = LOTS.filter(function (l) { return !l.feature; }).map(cardHTML).join('');

  /* index every card on the page, hero included */
  var byId = {};
  LOTS.forEach(function (lot) {
    lot.node = document.querySelector('[data-lot="' + lot.id + '"]');
    lot.ends = endsAt(lot);
    byId[lot.id] = lot;
  });

  /* ---------- clock loop ---------- */
  function paintClock(lot) {
    if (!lot.node) return;
    var box = lot.node.querySelector('[data-clock]');
    var t = box.querySelector('time');
    var left = lot.ends - Date.now();
    t.textContent = formatLeft(left);
    t.setAttribute('datetime', new Date(lot.ends).toISOString());
    box.classList.toggle('is-final', left > 0 && left < 3600000);
    box.classList.toggle('is-done', left <= 0);
    box.querySelector('.lbl').textContent = left <= 0 ? 'Hammer' : 'Closes in';
    if (left <= 0) {
      var bid = lot.node.querySelector('[data-bid]');
      var buy = lot.node.querySelector('[data-buy]');
      if (bid) { bid.disabled = true; bid.textContent = 'Lot closed'; }
      if (buy) buy.remove();
    }
  }
  function tick() { LOTS.forEach(paintClock); }
  tick();
  setInterval(tick, 1000);

  function paintPrice(lot) {
    if (!lot.node) return;
    lot.node.querySelector('[data-amt]').textContent = money(lot.price);
    lot.node.querySelector('[data-bids]').textContent = lot.bids + ' bids';
    lot.node.classList.toggle('is-mine', !!lot.mine);
    if (lot.mine) {
      var buy = lot.node.querySelector('[data-buy]');
      if (buy) buy.remove();               /* buy it now comes off at the first bid */
      var retail = lot.node.querySelector('.tag__retail');
      if (retail && lot.buyNow) retail.innerHTML = 'Retail <s>' + money(lot.retail) + '</s>';
    }
  }

  function flashExtend(lot) {
    if (!lot.node) return;
    var stub = lot.node.querySelector('.stub');
    var old = stub.querySelector('.extend-flag');
    if (old) old.remove();
    var p = document.createElement('p');
    p.className = 'extend-flag';
    p.textContent = 'Clock extended 2:00 — bid inside the final two minutes';
    stub.insertBefore(p, stub.querySelector('.stub__acts'));
    setTimeout(function () { p.remove(); }, 9000);
  }

  /* ---------- watchlist ---------- */
  function paintWatch(id) {
    var on = watching.indexOf(id) > -1;
    Array.prototype.forEach.call(document.querySelectorAll('[data-watch="' + id + '"]'), function (b) {
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
      b.setAttribute('aria-label', (on ? 'Stop watching' : 'Watch') + ' lot ' + id);
    });
  }
  LOTS.forEach(function (l) { paintWatch(l.id); });

  document.addEventListener('click', function (e) {
    var w = e.target.closest('[data-watch]');
    if (w) {
      var id = +w.getAttribute('data-watch');
      var i = watching.indexOf(id);
      if (i > -1) { watching.splice(i, 1); } else { watching.push(id); }
      save('hla.watch', watching);
      paintWatch(id);
      if (activeFilter === 'watch') applyFilter();
      return;
    }
    var b = e.target.closest('[data-bid]');
    if (b && !b.disabled) { openSheet(byId[+b.getAttribute('data-bid')]); return; }

    var n = e.target.closest('[data-buy]');
    if (n) {
      var lot = byId[+n.getAttribute('data-buy')];
      lot.price = lot.buyNow; lot.bids += 1; lot.mine = true; lot.ends = Date.now();
      paintPrice(lot); paintClock(lot);
      return;
    }
  });

  /* ---------- filters ---------- */
  var activeFilter = 'all';
  var chips = Array.prototype.slice.call(document.querySelectorAll('[data-filter]'));
  var countEl = document.getElementById('lotCount');
  var emptyEl = document.getElementById('lotEmpty');

  function passes(lot) {
    if (activeFilter === 'all') return true;
    if (activeFilter === 'soon') return (lot.ends - Date.now()) < 43200000;
    if (activeFilter === 'buy') return !!lot.buyNow;
    if (activeFilter === 'clean') return lot.grade === 'a';
    if (activeFilter === 'watch') return watching.indexOf(lot.id) > -1;
    return true;
  }

  function applyFilter() {
    var shown = 0;
    LOTS.forEach(function (lot) {
      if (lot.feature || !lot.node) return;
      var ok = passes(lot);
      lot.node.hidden = !ok;
      if (ok) shown++;
    });
    var total = LOTS.filter(function (l) { return !l.feature; }).length;
    countEl.textContent = shown === total ? total + ' lots open' : shown + ' of ' + total + ' lots';
    emptyEl.hidden = shown > 0;
  }

  chips.forEach(function (chip) {
    chip.addEventListener('click', function () {
      activeFilter = chip.getAttribute('data-filter');
      chips.forEach(function (c) { c.setAttribute('aria-pressed', c === chip ? 'true' : 'false'); });
      applyFilter();
    });
  });
  applyFilter();

  /* ---------- bid sheet ---------- */
  var sheet = document.getElementById('bidSheet');
  var form = document.getElementById('bidForm');
  var fLot = document.getElementById('sheetLot');
  var fTitle = document.getElementById('sheetTitle');
  var fNow = document.getElementById('sheetNow');
  var fLeft = document.getElementById('sheetLeft');
  var fMax = document.getElementById('maxBid');
  var fHint = document.getElementById('minHint');
  var fProtect = document.getElementById('protect');
  var fCost = document.getElementById('protectCost');
  var fTotal = document.getElementById('sheetTotal');
  var fErr = document.getElementById('sheetErr');
  var current = null;
  var returnTo = null;
  var sheetTimer = null;

  function titleOf(lot) {
    return lot.title || lot.node.querySelector('.tag__title').textContent;
  }

  function paintTotals() {
    if (!current) return;
    var v = parseFloat(fMax.value);
    var base = isNaN(v) ? minNext(current.price) : v;
    var cost = protectionOn(base);
    fCost.textContent = money2(cost);
    fTotal.textContent = money2(base + (fProtect.checked ? cost : 0));
  }

  function paintSheetClock() {
    if (!current) return;
    fLeft.textContent = formatLeft(current.ends - Date.now()) + ' left';
  }

  function openSheet(lot) {
    current = lot;
    returnTo = document.activeElement;
    var next = minNext(lot.price);
    fLot.textContent = 'LOT ' + lot.id + ' · Paddle ' + paddle;
    fTitle.textContent = titleOf(lot);
    fNow.textContent = 'Current bid ' + money(lot.price) + ' · ' + lot.bids + ' bids';
    fHint.textContent = 'Minimum next bid ' + money(next) + '. Increment at this price is ' + money(increment(lot.price)) + '.';
    fMax.value = next;
    fMax.min = next;
    fErr.textContent = '';
    paintTotals();
    paintSheetClock();
    clearInterval(sheetTimer);
    sheetTimer = setInterval(paintSheetClock, 1000);
    sheet.showModal();
    fMax.focus();
    fMax.select();
  }

  function closeSheet() {
    clearInterval(sheetTimer);
    sheet.close();
  }

  fMax.addEventListener('input', paintTotals);
  fProtect.addEventListener('change', paintTotals);
  document.getElementById('sheetClose').addEventListener('click', closeSheet);
  sheet.addEventListener('close', function () {
    clearInterval(sheetTimer);
    if (returnTo && returnTo.focus) returnTo.focus();
  });
  sheet.addEventListener('click', function (e) {
    if (e.target === sheet) closeSheet();   /* click the backdrop */
  });

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    if (!current) return;
    var lot = current;
    var next = minNext(lot.price);
    var max = parseFloat(fMax.value);

    if (isNaN(max)) { fErr.textContent = 'Enter the most you are willing to pay.'; fMax.focus(); return; }
    if (max < next) { fErr.textContent = 'Too low. The next valid bid is ' + money(next) + '.'; fMax.focus(); return; }
    if (lot.ends - Date.now() <= 0) { fErr.textContent = 'This lot has closed.'; return; }

    /* proxy: you take the lot at the smallest step that wins, holding your max in reserve */
    lot.price = next;
    lot.bids += 1;
    lot.mine = true;

    var left = lot.ends - Date.now();
    if (left < 120000) { lot.ends += 120000; flashExtend(lot); }

    paintPrice(lot);
    paintClock(lot);
    closeSheet();
  });

  /* ---------- mobile nav ---------- */
  var burger = document.getElementById('burger');
  var mobnav = document.getElementById('mobnav');
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
