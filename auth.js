/* Hughes Living Auctions — sign in, shared by every page

   Injects its own dialog rather than expecting each page to carry the markup,
   so the sign-in experience cannot drift between the lot list, a lot page and
   the paddle page.

   Exposes window.HLA_AUTH:
     session          { signedIn, paddle, email, positions }
     refresh()        re-read the session and positions from the server
     require(fn)      run fn if signed in, otherwise open the dialog and run
                      it afterwards
     onChange(fn)     called whenever the session changes
     bindPaddle()     wire any [data-paddle] button to sign in / sign out
     isLeading(lotNo) / myMax(lotNo) from the last refresh */

(function (global) {
  'use strict';

  var API = global.HLA_API;
  var session = { signedIn: false, paddle: null, email: null, positions: [] };
  var byLot = {};
  var listeners = [];
  var mode = 'signin';
  var after = null;

  /* ---------- dialog ---------- */
  var DIALOG = [
    '<dialog class="sheet" id="hlaAuth" aria-labelledby="hlaAuthTitle">',
    '  <form method="dialog" class="sheet__in" id="hlaAuthForm" novalidate>',
    '    <div class="sheet__top">',
    '      <div><span class="sheet__lot">Paddle</span>',
    '           <h2 id="hlaAuthTitle">Sign in to bid</h2></div>',
    '      <button class="x" type="button" id="hlaAuthClose" aria-label="Close">&times;</button>',
    '    </div>',
    '    <div class="authmode" role="group" aria-label="Sign in or create a paddle">',
    '      <button type="button" class="authmode__btn" id="hlaModeIn"  aria-pressed="true">Sign in</button>',
    '      <button type="button" class="authmode__btn" id="hlaModeReg" aria-pressed="false">Create a paddle</button>',
    '    </div>',
    '    <div class="field">',
    '      <label for="hlaEmail">Email</label>',
    '      <input type="email" id="hlaEmail" autocomplete="email" inputmode="email" placeholder="you@example.com" required>',
    '    </div>',
    '    <div class="field">',
    '      <label for="hlaPass">Password</label>',
    '      <input type="password" id="hlaPass" autocomplete="current-password">',
    '      <p class="hint" id="hlaPassHint">The password you bid with.</p>',
    '    </div>',
    '    <p class="sheet__err" id="hlaAuthErr" role="alert"></p>',
    '    <button class="btn btn--block" type="submit" id="hlaAuthSubmit">Continue</button>',
    '    <p class="sheet__fine" id="hlaAuthFine"></p>',
    '    <p class="authalt" id="hlaAuthAlt">',
    '      Forgotten it, or never set one?',
    '      <button type="button" class="linkbtn" id="hlaMagic">Email me a sign-in link</button>',
    '      <span class="authalt__or">or</span>',
    '      <button type="button" class="linkbtn" id="hlaForgot">Email a password reset</button>',
    '      <span class="authalt__warn">Some mail providers, Outlook among them, open links to',
    '        scan them, which uses the link up before you can. If that happens, use a password.</span>',
    '    </p>',
    '  </form>',
    '</dialog>'
  ].join('\n');

  var PWDIALOG = [
    '<dialog class="sheet" id="hlaPw" aria-labelledby="hlaPwTitle">',
    '  <form method="dialog" class="sheet__in" id="hlaPwForm" novalidate>',
    '    <div class="sheet__top">',
    '      <div><span class="sheet__lot">Paddle</span>',
    '           <h2 id="hlaPwTitle">Set a new password</h2></div>',
    '      <button class="x" type="button" id="hlaPwClose" aria-label="Close">&times;</button>',
    '    </div>',
    '    <div class="field">',
    '      <label for="hlaPwNew">New password</label>',
    '      <input type="password" id="hlaPwNew" autocomplete="new-password">',
    '      <p class="hint">At least six characters.</p>',
    '    </div>',
    '    <div class="field">',
    '      <label for="hlaPwAgain">Type it again</label>',
    '      <input type="password" id="hlaPwAgain" autocomplete="new-password">',
    '    </div>',
    '    <p class="sheet__err" id="hlaPwErr" role="alert"></p>',
    '    <button class="btn btn--block" type="submit" id="hlaPwSubmit">Save password</button>',
    '    <p class="sheet__fine" id="hlaPwFine"></p>',
    '  </form>',
    '</dialog>'
  ].join('\n');

  var pw = {};
  function buildPw() {
    if (pw.dialog) return;
    var host = document.createElement('div');
    host.innerHTML = PWDIALOG;
    document.body.appendChild(host.firstChild);
    pw.dialog = document.getElementById('hlaPw');
    pw.form   = document.getElementById('hlaPwForm');
    pw.a      = document.getElementById('hlaPwNew');
    pw.b      = document.getElementById('hlaPwAgain');
    pw.err    = document.getElementById('hlaPwErr');
    pw.fine   = document.getElementById('hlaPwFine');
    pw.submit = document.getElementById('hlaPwSubmit');
    pw.title  = document.getElementById('hlaPwTitle');
    document.getElementById('hlaPwClose').addEventListener('click', function () { pw.dialog.close(); });
    pw.dialog.addEventListener('click', function (e) { if (e.target === pw.dialog) pw.dialog.close(); });
    pw.form.addEventListener('submit', function (e) {
      e.preventDefault();
      var a = pw.a.value || '', b = pw.b.value || '';
      if (a.length < 6) { pw.err.textContent = 'At least six characters.'; pw.a.focus(); return; }
      if (a !== b) { pw.err.textContent = 'Those two do not match.'; pw.b.focus(); return; }
      pw.submit.disabled = true;
      pw.err.textContent = '';
      API.changePassword(a)
        .then(function () {
          pw.a.value = ''; pw.b.value = '';
          pw.dialog.close();
          return refresh();
        })
        .catch(function (err) { pw.err.textContent = err.message || 'Could not save that.'; })
        .then(function () { pw.submit.disabled = false; });
    });
  }

  function openPassword(opts) {
    buildPw();
    opts = opts || {};
    pw.a.value = ''; pw.b.value = '';
    pw.err.textContent = '';
    pw.submit.disabled = false;
    pw.title.textContent = opts.recovery ? 'Set a new password' : 'Change your password';
    pw.fine.textContent = opts.recovery
      ? 'You arrived from a recovery link. Choose a password and you are signed in.'
      : 'You stay signed in on this device.';
    pw.dialog.showModal();
    pw.a.focus();
  }

  var el = {};
  function build() {
    if (el.dialog) return;
    var host = document.createElement('div');
    host.innerHTML = DIALOG;
    document.body.appendChild(host.firstChild);
    el.dialog = document.getElementById('hlaAuth');
    el.form   = document.getElementById('hlaAuthForm');
    el.email  = document.getElementById('hlaEmail');
    el.pass   = document.getElementById('hlaPass');
    el.err    = document.getElementById('hlaAuthErr');
    el.fine   = document.getElementById('hlaAuthFine');
    el.submit = document.getElementById('hlaAuthSubmit');
    el.title  = document.getElementById('hlaAuthTitle');
    el.hint   = document.getElementById('hlaPassHint');
    el.alt    = document.getElementById('hlaAuthAlt');
    el.modeIn = document.getElementById('hlaModeIn');
    el.modeReg= document.getElementById('hlaModeReg');

    document.getElementById('hlaAuthClose').addEventListener('click', close);
    el.dialog.addEventListener('click', function (e) { if (e.target === el.dialog) close(); });
    el.modeIn.addEventListener('click',  function () { setMode('signin'); });
    el.modeReg.addEventListener('click', function () { setMode('register'); });
    document.getElementById('hlaMagic').addEventListener('click', sendLink);
    document.getElementById('hlaForgot').addEventListener('click', sendReset);
    el.form.addEventListener('submit', submit);
  }

  function setMode(m) {
    mode = m;
    var reg = m === 'register';
    el.modeIn.setAttribute('aria-pressed',  reg ? 'false' : 'true');
    el.modeReg.setAttribute('aria-pressed', reg ? 'true' : 'false');
    el.title.textContent  = reg ? 'Create a paddle' : 'Sign in to bid';
    el.submit.textContent = reg ? 'Create paddle' : 'Continue';
    el.pass.setAttribute('autocomplete', reg ? 'new-password' : 'current-password');
    el.hint.textContent = reg
      ? 'At least six characters. You will use this to bid.'
      : 'The password you bid with.';
    el.alt.hidden = reg || !API.canSignIn;
    el.fine.textContent = reg
      ? 'A paddle number is issued the moment the account is made. No email is sent.'
      : 'No email is sent when you sign in with a password.';
    el.err.textContent = '';
  }

  function open(then) {
    build();
    after = then || null;
    el.err.textContent = '';
    el.pass.value = '';
    el.submit.disabled = false;
    document.querySelector('#hlaAuth .authmode').hidden = !API.register || API.name === 'local';
    setMode('signin');
    el.dialog.showModal();
    el.email.focus();
  }
  function close() { if (el.dialog) el.dialog.close(); }

  function submit(e) {
    e.preventDefault();
    var email = (el.email.value || '').trim();
    var pass  = el.pass.value || '';
    if (!email) { el.err.textContent = 'Enter your email address.'; el.email.focus(); return; }
    if (!pass) {
      el.err.textContent = mode === 'register'
        ? 'Choose a password to bid with.'
        : 'Enter your password, or use the link below if you have not set one.';
      el.pass.focus();
      return;
    }
    el.submit.disabled = true;
    el.err.textContent = '';

    var run = mode === 'register'
      ? API.register(email, pass).then(function (r) {
          if (r && r.needsConfirmation) {
            el.fine.textContent = 'Paddle created. Confirm ' + r.email + ', then sign in.';
            el.submit.textContent = 'Check your email';
            return { pending: true };
          }
          return r;
        })
      : API.signIn(email, pass);

    run.then(function (r) {
        if (r && r.pending) return;
        return refresh().then(function () {
          el.pass.value = '';
          close();
          var next = after; after = null;
          if (next) next();
        });
      })
      .catch(function (err) { el.err.textContent = err.message || 'Could not sign in.'; })
      .then(function () { el.submit.disabled = false; });
  }

  function sendLink() {
    var email = (el.email.value || '').trim();
    if (!email) { el.err.textContent = 'Enter your email first.'; el.email.focus(); return; }
    var b = document.getElementById('hlaMagic');
    b.disabled = true;
    el.err.textContent = '';
    API.signIn(email, '')
      .then(function (r) {
        el.fine.textContent = 'Sent to ' + r.email +
          '. Open it soon; the link works once and expires in an hour.';
      })
      .catch(function (err) { el.err.textContent = err.message || 'Could not send that.'; })
      .then(function () { b.disabled = false; });
  }

  function sendReset() {
    var email = (el.email.value || '').trim();
    if (!email) { el.err.textContent = 'Enter your email first.'; el.email.focus(); return; }
    var b = document.getElementById('hlaForgot');
    b.disabled = true;
    el.err.textContent = '';
    API.requestReset(email)
      .then(function (r) {
        el.fine.textContent = 'Reset sent to ' + r.email +
          '. It works once and expires in an hour, so open it soon.';
      })
      .catch(function (err) { el.err.textContent = err.message || 'Could not send that.'; })
      .then(function () { b.disabled = false; });
  }

  /* ---------- session ---------- */
  function refresh() {
    if (!API.me) return Promise.resolve(session);
    return API.me().then(function (m) {
      session = {
        signedIn: !!m.signedIn, paddle: m.paddle, email: m.email,
        positions: m.positions || []
      };
      byLot = {};
      session.positions.forEach(function (p) { byLot[p.lot_no] = p; });
      paintPaddles();
      listeners.forEach(function (fn) { fn(session); });
      return session;
    }).catch(function () { return session; });
  }

  function paintPaddles() {
    var btns = document.querySelectorAll('[data-paddle]');
    for (var i = 0; i < btns.length; i++) {
      var b = btns[i];
      var label = b.querySelector('[data-paddle-label]');
      var num   = b.querySelector('[data-paddle-no]');
      if (session.signedIn) {
        if (label) label.textContent = 'PADDLE';
        if (num) num.textContent = session.paddle;
        b.setAttribute('aria-label', 'Paddle ' + session.paddle + '. Sign out.');
      } else {
        if (label) label.textContent = API.canSignIn ? 'Sign in' : 'Demo';
        if (num) num.textContent = '';
        b.setAttribute('aria-label', 'Sign in');
      }
    }
  }

  function bindPaddle() {
    var btns = document.querySelectorAll('[data-paddle]');
    for (var i = 0; i < btns.length; i++) {
      btns[i].addEventListener('click', function () {
        if (!API.canSignIn) return;
        if (!session.signedIn) { open(); return; }
        if (confirm('Sign out of paddle ' + session.paddle + '?')) {
          API.signOut().then(refresh);
        }
      });
    }
    paintPaddles();
  }

  /* A failed email link comes back in the hash and is otherwise invisible. */
  function readHashError() {
    var h = location.hash || '';
    if (h.indexOf('error') === -1) return null;
    var p = new URLSearchParams(h.replace(/^#/, ''));
    var code = p.get('error_code') || p.get('error') || '';
    if (!code) return null;
    history.replaceState(null, '', location.pathname + location.search);
    return /otp_expired|invalid/i.test(code)
      ? 'That sign-in link had already been used or had expired. Links last one hour and work once. Use your password instead.'
      : (p.get('error_description') || 'That sign-in link did not work.').replace(/\+/g, ' ');
  }

  /* Someone arriving from a recovery link gets straight to setting one. */
  if (API.onPasswordRecovery) {
    API.onPasswordRecovery(function () {
      refresh().then(function () { openPassword({ recovery: true }); });
    });
  }

  global.HLA_AUTH = {
    get session() { return session; },
    refresh: refresh,
    open: open,
    require: function (fn) { session.signedIn || !API.canSignIn ? fn() : open(fn); },
    onChange: function (fn) { listeners.push(fn); },
    bindPaddle: bindPaddle,
    isLeading: function (lotNo) { var p = byLot[lotNo]; return !!(p && p.is_leading); },
    myMax: function (lotNo) { var p = byLot[lotNo]; return p ? p.my_max_cents : null; },
    readHashError: readHashError,
    openPassword: openPassword
  };
})(window);
