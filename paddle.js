/* Where you stand — every lot you have bid on.

   Built on my_positions(), which answers "am I winning" without naming anyone
   else or revealing what they bid. Your own maximum is shown here because it
   is yours; nobody else can read it, in this page or anywhere. */
(function () {
  'use strict';

  var API  = window.HLA_API;
  var AUTH = window.HLA_AUTH;
  var host = document.getElementById('posHost');
  var lotsByNo = {};
  var standing = null;   /* my_standing(): walk-aways left, paid lots, gold */

  function money(c) { return '$' + Math.round(c / 100).toLocaleString('en-US'); }
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

  /* What a winner owes, and by when. The deadline is the lot's own settle_by,
     not a number this page invents. */
  function settlementLine(l, owed, won) {
    if (!won) return '';
    if (l.settled_at)  return '<span class="pos__settle is-done">Collected</span>';
    if (l.declined_at) return '<span class="pos__settle is-back">Handed back &mdash; relisting</span>';
    if (!l.settle_by)  return '';
    var by = new Date(l.settle_by);
    var hrs = (by.getTime() - API.serverNow().getTime()) / 3600000;
    var when = by.toLocaleString('en-US', { weekday: 'long', month: 'short', day: 'numeric',
                                            hour: 'numeric', minute: '2-digit' });
    return '<span class="pos__settle' + (hrs < 24 ? ' is-urgent' : '') + '">' +
             (hrs <= 0 ? 'Past the collection window' : 'Collect by ' + when) +
           '</span>' +
           (standing && standing.remaining <= 0
             ? '<span class="pos__settle is-urgent">No walk-aways left &mdash; this one needs collecting</span>'
             : '<button type="button" class="linkbtn pos__decline" data-decline="' + l.lot_no + '">' +
                 'I no longer want this' + '</button>');
  }

  /* Walk-aways and paid lots. The database counts; this page only reports,
     and re-draws the table if the count moved so the hand-back buttons match. */
  function paintStanding() {
    var el = document.getElementById('posStanding');
    if (!el) return;
    if (!standing) { el.innerHTML = ''; return; }
    var st = standing;
    if (st.suspended) {
      el.innerHTML = '<p class="standing is-suspended"><b>This paddle is suspended</b> for a won ' +
        'lot that was not paid for or collected. You can still collect lots you have won. ' +
        'Contact us to have bidding restored.</p>';
      return;
    }
    var nextAt = (Math.floor(st.paid_lots / 5) + 1) * 5;
    el.innerHTML = '<p class="standing">' +
      (st.gold ? '<span class="standing__gold">Gold buyer</span> ' : '') +
      '<b>' + st.remaining + ' of ' + st.allowance + '</b> walk-aways left' +
      ' &middot; ' + st.paid_lots + (st.paid_lots === 1 ? ' lot' : ' lots') + ' paid for' +
      ' &middot; ' + (nextAt - st.paid_lots) + ' more to earn another' +
      (st.paid_lots === 0
        ? '<span class="standing__warn">Until your first lot is paid for, letting a win run ' +
          'out without handing it back suspends your paddle.</span>'
        : '') +
      ' <a href="terms.html#paying">How this works</a></p>';
  }

  function loadStanding() {
    if (!API.myStanding) return;
    API.myStanding().then(function (st) {
      var moved = JSON.stringify(st) !== JSON.stringify(standing);
      standing = st;
      paintStanding();
      if (moved) render(true);
    });
  }

  function render(fromStanding) {
    var s = AUTH.session;

    if (!s.signedIn) {
      standing = null;
      paintStanding();
      host.innerHTML = '<p class="lots__empty">Sign in to see your lots. ' +
        '<button class="linkbtn" id="goIn">Sign in</button></p>';
      document.getElementById('goIn').addEventListener('click', function () {
        AUTH.open(function () { render(); });
      });
      return;
    }

    document.getElementById('paddleEyebrow').textContent = 'Paddle ' + s.paddle;

    /* Account controls. Without a way to change it, a reset leaves someone
       stuck with whatever password was set for them. */
    var acct = document.getElementById('posAccount');
    if (acct) {
      acct.innerHTML =
        '<p class="acct">Signed in as <b>' + esc(s.email || '') + '</b>' +
        ' &middot; <button class="linkbtn" id="acctPw">Change your password</button></p>';
      document.getElementById('acctPw').addEventListener('click', function () {
        AUTH.openPassword();
      });
    }
    if (!fromStanding) loadStanding();

    var rows = (s.positions || []).slice().sort(function (a, b) {
      /* losing first — those are the ones that need you */
      if (a.is_leading !== b.is_leading) return a.is_leading ? 1 : -1;
      return new Date(a.ends_at) - new Date(b.ends_at);
    });

    if (!rows.length) {
      host.innerHTML = '<p class="lots__empty">You have not bid on anything yet. ' +
        '<a href="index.html#lots">See the open lots</a>.</p>';
      return;
    }

    var losing = rows.filter(function (r) { return !r.is_leading; }).length;

    host.innerHTML =
      '<p class="pos__summary">' +
        rows.length + (rows.length === 1 ? ' lot' : ' lots') + ' in play. ' +
        (losing
          ? '<b class="pos__losing">' + losing + ' where you have been outbid.</b>'
          : 'You are holding every one of them.') +
      '</p>' +
      '<table class="pos">' +
        '<caption>Only you can see this. Your maximums never leave the server.</caption>' +
        '<thead><tr>' +
          '<th scope="col">Lot</th><th scope="col">Standing</th>' +
          '<th scope="col">Current</th><th scope="col">Your max</th>' +
          '<th scope="col">Closes</th>' +
        '</tr></thead><tbody>' +
        rows.map(function (r) {
          var l = lotsByNo[r.lot_no] || {};
          var ms = new Date(r.ends_at).getTime() - API.serverNow().getTime();
          var done = ms <= 0;
          var won  = done && r.is_leading && l.sold;
          /* settle_by, settled_at and declined_at are public columns on the
             lot; my_positions() says whether the lot is yours. */
          var owed = won && !l.settled_at && !l.declined_at;
          return '<tr class="' + (r.is_leading ? 'is-leading' : 'is-outbid') +
                   (owed ? ' is-owed' : '') + '">' +
            '<td><a href="lot.html?lot=' + r.lot_no + '">' +
              (l.title ? esc(l.title) : 'Lot ' + r.lot_no) + '</a>' +
              '<span class="pos__no">Lot ' + r.lot_no + '</span>' +
              settlementLine(l, owed, won) + '</td>' +
            '<td><span class="pos__flag">' +
              (l.settled_at ? 'Collected'
                : l.declined_at ? 'Handed back'
                : won ? 'Won'
                : done ? 'Lost'
                : r.is_leading ? 'Holding' : 'Outbid') +
              '</span></td>' +
            '<td class="pos__num">' + money(r.price_cents) + '</td>' +
            '<td class="pos__num">' + money(r.my_max_cents) + '</td>' +
            '<td class="pos__num" data-ends="' + esc(r.ends_at) + '">' + left(ms) + '</td>' +
          '</tr>';
        }).join('') +
      '</tbody></table>';
  }

  function tick() {
    var cells = document.querySelectorAll('[data-ends]');
    for (var i = 0; i < cells.length; i++) {
      cells[i].textContent = left(new Date(cells[i].dataset.ends).getTime() - API.serverNow().getTime());
    }
  }

  document.addEventListener('click', function (e) {
    var b = e.target.closest('[data-decline]');
    if (!b) return;
    var lotNo = Number(b.dataset.decline);
    if (!confirm('Hand lot ' + lotNo + ' back?\n\nIt goes straight back into the auction and ' +
                 'you owe nothing. This cannot be undone.')) return;
    b.disabled = true;
    API.declineLot(lotNo)
      .then(function () { return API.lots(); })
      .then(function (rows) {
        rows.forEach(function (l) { lotsByNo[l.lot_no] = l; });
        return AUTH.refresh();
      })
      .then(render)
      .catch(function (err) { alert(err.message || 'That did not go through.'); b.disabled = false; });
  });

  AUTH.bindPaddle();
  AUTH.onChange(render);

  API.init()
    .then(function (state) {
      state.lots.forEach(function (l) { lotsByNo[l.lot_no] = l; });
      if (API.canSignIn) return AUTH.refresh();
    })
    .then(function () {
      render();
      setInterval(tick, 1000);
      /* someone else bidding changes where you stand, so re-check */
      setInterval(function () { if (AUTH.session.signedIn) AUTH.refresh(); }, 15000);
      API.subscribe(function () { if (AUTH.session.signedIn) AUTH.refresh(); });
    })
    .catch(function (err) {
      host.innerHTML = '<p class="lots__empty">Could not load your lots. ' + esc(err.message || '') + '</p>';
    });
})();
