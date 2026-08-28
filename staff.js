/* The office view.

   Answers the questions you actually have on a Sunday night: what closed, who
   won it, what do I collect, and what got no bids and needs relisting.

   Winner identities come from staff_lots(), which checks is_staff in the
   database and raises otherwise. This page cannot show what the server will
   not send, so a non-staff paddle sees a refusal rather than an empty table. */
(function () {
  'use strict';

  var API  = window.HLA_API;
  var AUTH = window.HLA_AUTH;
  var host = document.getElementById('staffHost');
  var sumHost = document.getElementById('staffSummary');

  function money(c) { return '$' + Math.round((c || 0) / 100).toLocaleString('en-US'); }
  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function left(ms) {
    if (ms <= 0) return 'closed';
    var s = Math.floor(ms / 1000), d = Math.floor(s / 86400); s -= d * 86400;
    var h = Math.floor(s / 3600); s -= h * 3600;
    var m = Math.floor(s / 60); s -= m * 60;
    return d > 0 ? d + 'd ' + pad(h) + 'h' : pad(h) + ':' + pad(m) + ':' + pad(s);
  }
  function esc(v) {
    return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function summary(s) {
    if (!s) return '';
    var margin = s.hammer_total && s.retail_total
      ? Math.round((s.hammer_total / s.retail_total) * 100) : null;
    var cells = [
      ['Open now',        s.open_lots],
      ['Closing in 24h',  s.closing_24h],
      ['Won, to collect', s.closed_won],
      ['Closed unsold',   s.closed_unsold],
      ['Hammer total',    money(s.hammer_total)],
      ['Paddles issued',  s.bidders_total]
    ];
    return '<div class="office__stats">' + cells.map(function (c) {
      return '<div class="office__stat"><span class="k">' + c[0] + '</span>' +
             '<span class="v">' + c[1] + '</span></div>';
    }).join('') +
    (margin !== null
      ? '<div class="office__stat"><span class="k">Hammer vs retail</span>' +
        '<span class="v">' + margin + '%</span></div>'
      : '') +
    '</div>';
  }

  function table(title, rows, kind) {
    if (!rows.length) return '';
    var isWon = kind === 'won';
    return '' +
    '<section class="office__group">' +
      '<h2 class="office__h">' + title + ' <span>' + rows.length + '</span></h2>' +
      '<table class="office">' +
        '<thead><tr>' +
          '<th scope="col">Lot</th>' +
          (isWon ? '<th scope="col">Winner</th><th scope="col">Contact</th>' : '') +
          '<th scope="col">' + (isWon ? 'Hammer' : 'Bid') + '</th>' +
          '<th scope="col">' + (isWon ? 'Protection' : 'Bidders') + '</th>' +
          '<th scope="col">' + (isWon ? 'Reserve' : 'Closes') + '</th>' +
        '</tr></thead><tbody>' +
        rows.map(function (r) {
          var ms = new Date(r.ends_at).getTime() - API.serverNow().getTime();
          return '<tr>' +
            '<td><a href="lot.html?lot=' + r.lot_no + '">' + esc(r.title) + '</a>' +
              '<span class="office__no">Lot ' + r.lot_no + ' &middot; ' +
              esc(String(r.grade).toUpperCase()) +
              (r.pallet ? ' &middot; Pallet ' + esc(r.pallet) : '') + '</span></td>' +
            (isWon
              ? '<td>' + (r.winner_paddle
                  ? '<b>' + r.winner_paddle + '</b><span class="office__no">' +
                    esc(r.winner_name || '') + '</span>'
                  : '<span class="office__none">no bids</span>') + '</td>' +
                '<td>' + (r.winner_email
                  ? '<a href="mailto:' + esc(r.winner_email) + '">' + esc(r.winner_email) + '</a>'
                  : '&mdash;') + '</td>'
              : '') +
            '<td class="office__num">' + money(r.current_price_cents) +
              (r.retail_cents ? '<span class="office__no">retail ' + money(r.retail_cents) + '</span>' : '') +
            '</td>' +
            (isWon
              ? '<td class="office__num">' + (r.protection
                    ? money(r.protection_cents)
                    : '<span class="office__none">none</span>') + '</td>' +
                '<td>' + (r.reserve_cents
                    ? (r.met_reserve
                        ? '<span class="office__ok">met</span>'
                        : '<span class="office__no-reserve">short of ' + money(r.reserve_cents) + '</span>')
                    : '<span class="office__none">none set</span>') + '</td>'
              : '<td class="office__num">' + r.bidder_count + '</td>' +
                '<td class="office__num" data-ends="' + esc(r.ends_at) + '">' + left(ms) + '</td>') +
          '</tr>';
        }).join('') +
      '</tbody></table>' +
    '</section>';
  }

  function render(lots, sum) {
    document.getElementById('staffEyebrow').textContent =
      'Office · paddle ' + AUTH.session.paddle;
    sumHost.innerHTML = summary(sum);

    var now = API.serverNow().getTime();
    var closed  = lots.filter(function (l) { return l.status !== 'open'; });
    var won     = closed.filter(function (l) { return l.winner_paddle; });
    var unsold  = closed.filter(function (l) { return !l.winner_paddle; });
    var soon    = lots.filter(function (l) {
      return l.status === 'open' && new Date(l.ends_at).getTime() - now < 24 * 3600e3;
    });
    var later   = lots.filter(function (l) {
      return l.status === 'open' && new Date(l.ends_at).getTime() - now >= 24 * 3600e3;
    });

    var html =
      table('To collect', won, 'won') +
      table('Closing within a day', soon, 'open') +
      table('Open, later', later, 'open') +
      table('Closed with no bids &mdash; relist', unsold, 'won');

    host.innerHTML = html || '<p class="lots__empty">Nothing listed yet.</p>';
  }

  function tick() {
    var cells = document.querySelectorAll('[data-ends]');
    for (var i = 0; i < cells.length; i++) {
      cells[i].textContent = left(new Date(cells[i].dataset.ends).getTime() - API.serverNow().getTime());
    }
  }

  function load() {
    if (!AUTH.session.signedIn) {
      sumHost.innerHTML = '';
      host.innerHTML = '<p class="lots__empty">Sign in with an office paddle. ' +
        '<button class="linkbtn" id="goIn">Sign in</button></p>';
      document.getElementById('goIn').addEventListener('click', function () { AUTH.open(load); });
      return;
    }
    Promise.all([API.staffLots(), API.staffSummary()])
      .then(function (r) { render(r[0], r[1]); })
      .catch(function (err) {
        sumHost.innerHTML = '';
        host.innerHTML = err.code === 'NOTSTAFF'
          ? '<p class="lots__empty">Paddle ' + AUTH.session.paddle +
            ' does not have office access. Set <code>is_staff</code> on this ' +
            'bidder in the database to grant it.</p>'
          : '<p class="lots__empty">Could not load the office view. ' + esc(err.message || '') + '</p>';
      });
  }

  AUTH.bindPaddle();
  AUTH.onChange(load);

  API.init()
    .then(function () { if (API.canSignIn) return AUTH.refresh(); })
    .then(function () {
      load();
      setInterval(tick, 1000);
      setInterval(function () { if (AUTH.session.signedIn) load(); }, 30000);
      API.subscribe(function () { if (AUTH.session.signedIn) load(); });
    })
    .catch(function (err) {
      host.innerHTML = '<p class="lots__empty">' + esc(err.message || 'Could not start.') + '</p>';
    });
})();
