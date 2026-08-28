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

  function render() {
    var s = AUTH.session;

    if (!s.signedIn) {
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
          return '<tr class="' + (r.is_leading ? 'is-leading' : 'is-outbid') + '">' +
            '<td><a href="lot.html?lot=' + r.lot_no + '">' +
              (l.title ? esc(l.title) : 'Lot ' + r.lot_no) + '</a>' +
              '<span class="pos__no">Lot ' + r.lot_no + '</span></td>' +
            '<td><span class="pos__flag">' +
              (done ? (r.is_leading ? 'Won' : 'Lost') : (r.is_leading ? 'Holding' : 'Outbid')) +
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
