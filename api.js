/* Hughes Living Auctions — backend interface

   One interface, three implementations, chosen in config.js:

     demo      no server. The rules run in the page, against lots-demo.json.
               This is what a visitor gets on the static site with no database
               behind it. Nothing is persisted and nobody else is bidding.
     local     the Node dev server in server/, talking to Postgres. Every rule
               is decided by place_bid() in SQL.
     supabase  the same SQL, hosted, reached straight from the browser under RLS.

   The point of the seam is that app.js never knows which one it has, and never
   decides an auction question itself. Prices, minimums and clocks come from
   whoever is answering.

   All money is integer cents. All times are ISO strings from the server. */

(function (global) {
  'use strict';

  var CFG = global.HLA_CONFIG || { backend: 'demo' };

  /* ---------- rules, mirrored for the demo backend only ----------
     These duplicate bid_increment_cents() and protection_cents() from
     0001_auction_core.sql. They exist so the no-server build behaves like the
     real one. If the published increments ever change, they change in the SQL
     first and here second. */
  function incrementCents(price) {
    if (price <   5000) return  500;
    if (price <  25000) return 1000;
    if (price < 100000) return 2500;
    return 5000;
  }
  function protectionCents(amount) {
    return Math.max(800, Math.ceil(amount * 0.06));
  }

  function AuctionError(message, code) {
    var e = new Error(message);
    e.name = 'AuctionError';
    e.code = code || null;
    return e;
  }

  /* ================================================================ demo */
  function DemoBackend() {
    var lots = [];
    var offset = 0;
    var listeners = [];
    var signedIn = null;
    /* one row per submitted maximum, exactly like the bids table */
    var bids = {};                       // lot_no -> [{ bidder, max_cents, at }]

    function emit(lot) { listeners.forEach(function (fn) { fn(lot); }); }

    /* Mirror of resolve_price(): each bidder counted once at their highest max,
       leader pays one increment over the runner-up, capped at their own max. */
    function resolve(lotNo, openingCents) {
      var rows = bids[lotNo] || [];
      var best = {};
      rows.forEach(function (b) {
        var cur = best[b.bidder];
        if (!cur || b.max_cents > cur.max_cents) best[b.bidder] = b;
      });
      var ranked = Object.keys(best).map(function (k) { return best[k]; })
        .sort(function (x, y) { return y.max_cents - x.max_cents || x.at - y.at; });
      if (ranked.length === 0) return { price: openingCents, leader: null };
      if (ranked.length === 1) return { price: openingCents, leader: ranked[0].bidder };
      return {
        price: Math.min(ranked[0].max_cents,
                        ranked[1].max_cents + incrementCents(ranked[1].max_cents)),
        leader: ranked[0].bidder
      };
    }

    function minNext(lot) {
      return lot.bid_count === 0
        ? lot.opening_cents
        : lot.current_price_cents + incrementCents(lot.current_price_cents);
    }

    return {
      name: 'demo',
      canSignIn: false,

      init: function () {
        return fetch('lots-demo.json', { cache: 'no-store' })
          .then(function (r) {
            if (!r.ok) throw AuctionError('Could not load the lot list.');
            return r.json();
          })
          .then(function (rows) {
            var start = Date.now();
            lots = rows.map(function (r) {
              return {
                lot_no: r.lot_no, status: 'open',
                category: r.category, title: r.title, alt_text: r.alt_text,
                image_path: r.image_path, grade: r.grade, pallet: r.pallet,
                found: r.found, fixed: r.fixed, still: r.still,
                retail_cents: r.retail_cents,
                opening_cents: r.opening_cents,
                buy_now_cents: r.buy_now_cents,
                current_price_cents: 0,
                bid_count: 0,
                extension_count: 0,
                ends_at: new Date(start + r.ends_in_s * 1000).toISOString(),
                min_next_cents: r.opening_cents
              };
            });
            return { lots: lots.slice(), now: new Date() };
          });
      },

      serverNow: function () { return new Date(Date.now() + offset); },
      lots: function () { return Promise.resolve(lots.slice()); },
      me: function () { return Promise.resolve({ signedIn: false, positions: [] }); },
      signIn: function () {
        return Promise.reject(AuctionError(
          'This is the demonstration build, so there is nobody to sign in as. ' +
          'Bids here stay in your browser.'));
      },
      signOut: function () { return Promise.resolve(); },
      register: function () {
        return Promise.reject(AuctionError(
          'This is the demonstration build, so there is no paddle to issue.'));
      },
      changePassword: function () {
        return Promise.reject(AuctionError('There are no passwords in the demonstration build.'));
      },
      requestReset: function () {
        return Promise.reject(AuctionError('There are no passwords in the demonstration build.'));
      },
      onPasswordRecovery: function () {},

      placeBid: function (lotNo, maxCents, protection) {
        var lot = lots.filter(function (l) { return l.lot_no === lotNo; })[0];
        if (!lot) return Promise.reject(AuctionError('That lot does not exist.'));
        if (lot.status !== 'open') return Promise.reject(AuctionError('This lot has closed.'));
        var now = Date.now();
        if (new Date(lot.ends_at).getTime() <= now) {
          return Promise.reject(AuctionError('This lot has closed.'));
        }
        if (maxCents % 100 !== 0) {
          return Promise.reject(AuctionError('Bids are in whole dollars.'));
        }
        var me = 'you';
        var mine = (bids[lotNo] || []).filter(function (b) { return b.bidder === me; });
        var myMax = mine.length ? Math.max.apply(null, mine.map(function (b) { return b.max_cents; })) : null;
        if (myMax !== null && maxCents <= myMax) {
          return Promise.reject(AuctionError(
            'Your maximum is already $' + (myMax / 100) + '. Raise it to bid again.'));
        }
        var leadingNow = signedIn === null && lot._leader === me;
        if (!leadingNow && maxCents < minNext(lot)) {
          return Promise.reject(AuctionError(
            'The minimum bid is $' + (minNext(lot) / 100) + '.'));
        }

        bids[lotNo] = (bids[lotNo] || []).concat([{ bidder: me, max_cents: maxCents, at: now }]);
        var r = resolve(lotNo, lot.opening_cents);
        var extended = false;
        if (new Date(lot.ends_at).getTime() - now < 120000) {
          lot.ends_at = new Date(now + 120000).toISOString();   /* leaves two minutes, not adds */
          lot.extension_count += 1;
          extended = true;
        }
        lot.current_price_cents = r.price;
        lot._leader = r.leader;
        lot.bid_count = (bids[lotNo] || []).length;
        lot.buy_now_cents = null;                                /* comes off at the first bid */
        lot.min_next_cents = minNext(lot);
        emit(lot);
        return Promise.resolve({
          status: r.leader === me ? 'leading' : 'outbid',
          lot_no: lotNo, price_cents: r.price, ends_at: lot.ends_at,
          extended: extended,
          protection_cents: protection ? protectionCents(r.price) : 0,
          min_next_cents: lot.min_next_cents
        });
      },

      buyNow: function (lotNo, protection) {
        var lot = lots.filter(function (l) { return l.lot_no === lotNo; })[0];
        if (!lot || !lot.buy_now_cents) {
          return Promise.reject(AuctionError('Buy it now is no longer available on this lot.'));
        }
        var price = lot.buy_now_cents;
        lot.status = 'closed';
        lot.current_price_cents = price;
        lot.buy_now_cents = null;
        lot._leader = 'you';
        lot.bid_count += 1;
        emit(lot);
        return Promise.resolve({
          status: 'won', lot_no: lotNo, price_cents: price,
          protection_cents: protection ? protectionCents(price) : 0
        });
      },

      isMine: function (lot) { return lot._leader === 'you'; },
      subscribe: function (fn) {
        listeners.push(fn);
        return function () { listeners = listeners.filter(function (f) { return f !== fn; }); };
      }
    };
  }

  /* =============================================================== local */
  function LocalBackend() {
    var offset = 0;
    var token = null;
    var positions = {};
    var es = null;
    var listeners = [];

    try { token = global.localStorage.getItem('hla.token'); } catch (e) {}

    function req(path, opts) {
      opts = opts || {};
      var headers = { 'content-type': 'application/json' };
      if (token) headers.authorization = 'Bearer ' + token;
      return fetch(path, {
        method: opts.method || 'GET',
        headers: headers,
        body: opts.body ? JSON.stringify(opts.body) : undefined,
        cache: 'no-store'
      }).then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (j) {
          if (!r.ok) throw AuctionError(j.error || 'Request failed.', r.status);
          return j;
        });
      });
    }

    return {
      name: 'local',
      canSignIn: true,

      init: function () {
        return req('/api/lots').then(function (j) {
          offset = new Date(j.now).getTime() - Date.now();
          return { lots: j.lots, now: new Date(j.now) };
        });
      },
      serverNow: function () { return new Date(Date.now() + offset); },
      lots: function () { return req('/api/lots').then(function (j) { return j.lots; }); },

      me: function () {
        if (!token) return Promise.resolve({ signedIn: false, positions: [] });
        return req('/api/me').then(function (j) {
          positions = {};
          (j.positions || []).forEach(function (p) { positions[p.lot_no] = p; });
          return j;
        });
      },
      /* The dev server issues a paddle on first sign-in, so registering and
         signing in are the same call here. */
      register: function (email) { return this.signIn(email); },
      changePassword: function () {
        return Promise.reject(AuctionError('The dev server has no passwords.'));
      },
      requestReset: function () {
        return Promise.reject(AuctionError('The dev server has no passwords.'));
      },
      onPasswordRecovery: function () {},

      signIn: function (email /*, password: dev server is passwordless */) {
        return req('/api/signin', { method: 'POST', body: { email: email } })
          .then(function (j) {
            token = j.token;
            try { global.localStorage.setItem('hla.token', token); } catch (e) {}
            return j;
          });
      },
      signOut: function () {
        var done = req('/api/signout', { method: 'POST' }).catch(function () {});
        token = null; positions = {};
        try { global.localStorage.removeItem('hla.token'); } catch (e) {}
        return done;
      },

      placeBid: function (lotNo, maxCents, protection, key) {
        return req('/api/bid', { method: 'POST', body: {
          lot_no: lotNo, max_cents: maxCents, protection: !!protection, idempotency_key: key } });
      },
      buyNow: function (lotNo, protection, key) {
        return req('/api/buy', { method: 'POST', body: {
          lot_no: lotNo, protection: !!protection, idempotency_key: key } });
      },

      isMine: function (lot) {
        var p = positions[lot.lot_no];
        return !!(p && p.is_leading);
      },
      myMax: function (lot) {
        var p = positions[lot.lot_no];
        return p ? p.my_max_cents : null;
      },
      subscribe: function (fn) {
        listeners.push(fn);
        if (!es) {
          es = new EventSource('/api/stream');
          es.addEventListener('lot', function (ev) {
            var row;
            try { row = JSON.parse(ev.data); } catch (e) { return; }
            listeners.forEach(function (f) { f(row); });
          });
        }
        return function () { listeners = listeners.filter(function (f) { return f !== fn; }); };
      }
    };
  }

  /* ============================================================ supabase */
  function SupabaseBackend() {
    var sb = null, offset = 0, positions = {}, listeners = [], channel = null;

    /* supabase-js is vendored at vendor/supabase-js-2.112.4.js and loaded from
       our own origin, not a CDN. This library handles the session token; if it
       came from a third party, a bad build there would be a bad build here, and
       ESM imports carry no integrity check. Pinned, hash recorded beside it.
       To upgrade: npm i @supabase/supabase-js@<version>, copy dist/umd, redo
       the hash, change the tag in index.html. */
    var LIB = 'vendor/supabase-js-2.112.4.js';
    var libLoading = null;
    function loadLib() {
      if (global.supabase && global.supabase.createClient) return Promise.resolve();
      if (libLoading) return libLoading;
      libLoading = new Promise(function (resolve, reject) {
        var el = document.createElement('script');
        el.src = LIB;
        el.onload = function () {
          if (global.supabase && global.supabase.createClient) resolve();
          else reject(AuctionError('The Supabase library loaded but looks wrong.'));
        };
        el.onerror = function () { reject(AuctionError('Could not load ' + LIB + '.')); };
        document.head.appendChild(el);
      });
      return libLoading;
    }

    function client() {
      if (sb) return Promise.resolve(sb);
      if (!CFG.supabaseUrl || !CFG.supabaseAnonKey) {
        return Promise.reject(AuctionError(
          'No Supabase project configured. Set supabaseUrl and supabaseAnonKey in config.js.'));
      }
      return loadLib().then(function () {
        sb = global.supabase.createClient(CFG.supabaseUrl, CFG.supabaseAnonKey, {
          auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
        });
        return sb;
      });
    }

    var PUBLIC_COLS = [
      'lot_no', 'status', 'category', 'title', 'alt_text', 'image_path', 'grade',
      'pallet', 'found', 'fixed', 'still', 'retail_cents', 'opening_cents',
      'buy_now_cents', 'opens_at', 'ends_at', 'extension_count',
      'current_price_cents', 'bid_count'
    ].join(',');

    function fetchLots() {
      return client().then(function (c) {
        return c.from('lots').select(PUBLIC_COLS)
                .in('status', ['open', 'closed', 'settled'])
                .order('ends_at', { ascending: true });
      }).then(function (r) {
        if (r.error) throw AuctionError(r.error.message);
        return r.data;
      });
    }

    /* min_next_cents() takes the internal id, which anon never sees, so the
       published minimum comes back through min_next_for(lot_no) instead. */
    function withMinNext(lots) {
      return client().then(function (c) {
        return Promise.all(lots.map(function (l) {
          if (l.status !== 'open') { l.min_next_cents = 0; return l; }
          return c.rpc('min_next_for', { p_lot_no: l.lot_no }).then(function (r) {
            l.min_next_cents = (r && typeof r.data === 'number') ? r.data : 0;
            return l;
          });
        }));
      });
    }

    return {
      name: 'supabase',
      canSignIn: true,

      init: function () {
        return client()
          .then(function (c) { return c.rpc('server_now'); })
          .then(function (r) {
            if (r && r.data) {
              offset = new Date(r.data).getTime() - Date.now();
            } else {
              /* Say so rather than quietly drawing clocks off the browser. */
              console.warn('server_now() unavailable; clocks are running on browser time');
            }
            return fetchLots().then(withMinNext);
          })
          .then(function (lots) { return { lots: lots, now: new Date(Date.now() + offset) }; });
      },
      serverNow: function () { return new Date(Date.now() + offset); },
      lots: function () { return fetchLots().then(withMinNext); },

      me: function () {
        return client().then(function (c) { return c.auth.getUser(); }).then(function (u) {
          if (!u.data || !u.data.user) return { signedIn: false, positions: [] };
          return sb.rpc('my_positions').then(function (r) {
            positions = {};
            (r.data || []).forEach(function (p) { positions[p.lot_no] = p; });
            return sb.from('bidders').select('paddle').single().then(function (b) {
              return {
                signedIn: true,
                email: u.data.user.email,
                paddle: b.data ? b.data.paddle : null,
                positions: r.data || []
              };
            });
          });
        });
      },
      /* Two ways in. A password signs you straight in; leaving it blank emails
         a link instead. Both land on the same account, and the paddle is
         issued by the signup trigger either way.

         The link route depends on a mail service. Supabase's built-in sender
         allows two an hour and cannot be raised without your own SMTP, so the
         password route is the one that works before that is set up. */
      /* Registration. Supabase returns a session immediately when email
         confirmation is off, and no session when it is on — in which case the
         account exists but cannot bid until the address is confirmed. Report
         which happened rather than pretending both are success. */
      register: function (email, password) {
        return client().then(function (c) {
          return c.auth.signUp({ email: email, password: password });
        }).then(function (r) {
          if (r.error) {
            var m = r.error.message || '';
            if (/already registered|already been registered/i.test(m)) {
              throw AuctionError('That email already has a paddle. Sign in instead.');
            }
            if (/password/i.test(m) && /(6|8|characters|short|weak)/i.test(m)) {
              throw AuctionError('Choose a longer password — at least six characters.');
            }
            if (/rate limit/i.test(m)) {
              throw AuctionError(
                'The sign-up email limit has been reached for this hour. Try again later.');
            }
            if (/signups not allowed|disabled/i.test(m)) {
              throw AuctionError('New paddles are closed at the moment.');
            }
            throw AuctionError(m);
          }
          /* session present => straight in. absent => confirmation required. */
          return { needsConfirmation: !(r.data && r.data.session), email: email };
        });
      },

      signIn: function (email, password) {
        return client().then(function (c) {
          if (password) {
            return c.auth.signInWithPassword({ email: email, password: password })
              .then(function (r) {
                if (r.error) {
                  var m = r.error.message || '';
                  if (/invalid login credentials/i.test(m)) {
                    throw AuctionError(
                      'That email and password did not match. If you have never set a ' +
                      'password, leave it blank and we will email you a link.');
                  }
                  if (/email not confirmed/i.test(m)) {
                    throw AuctionError('That address has not been confirmed yet.');
                  }
                  throw AuctionError(m);
                }
                return { magicLink: false, email: email };
              });
          }
          return c.auth.signInWithOtp({ email: email }).then(function (r) {
            if (r.error) {
              var m = r.error.message || '';
              if (/rate limit/i.test(m)) {
                throw AuctionError(
                  'The sign-in email limit has been reached for this hour. ' +
                  'Use a password instead, or try again later.');
              }
              throw AuctionError(m);
            }
            return { magicLink: true, email: email };
          });
        });
      },
      signOut: function () {
        return client().then(function (c) { return c.auth.signOut(); });
      },

      placeBid: function (lotNo, maxCents, protection, key) {
        return client().then(function (c) {
          return c.rpc('place_bid', {
            p_lot_no: lotNo, p_max_cents: maxCents,
            p_protection: !!protection, p_idempotency_key: key || null });
        }).then(function (r) {
          if (r.error) throw AuctionError(r.error.message, r.error.code);
          return r.data;
        });
      },
      buyNow: function (lotNo, protection, key) {
        return client().then(function (c) {
          return c.rpc('buy_now', {
            p_lot_no: lotNo, p_protection: !!protection, p_idempotency_key: key || null });
        }).then(function (r) {
          if (r.error) throw AuctionError(r.error.message, r.error.code);
          return r.data;
        });
      },

      /* Change your own password while signed in. No email involved, so this
         is the one recovery path that works for everybody. */
      changePassword: function (newPassword) {
        return client()
          .then(function (c) { return c.auth.updateUser({ password: newPassword }); })
          .then(function (r) {
            if (r.error) {
              var m = r.error.message || '';
              if (/should be at least|password/i.test(m) && /6|characters|short|weak/i.test(m)) {
                throw AuctionError('Choose a longer password — at least six characters.');
              }
              if (/same.*password|different from the old/i.test(m)) {
                throw AuctionError('That is the password you already have.');
              }
              throw AuctionError(m);
            }
            return true;
          });
      },

      /* Emails a recovery link. Same single-use caveat as the sign-in link:
         a mail provider that pre-scans links will spend it before the person
         clicks. Said plainly in the interface rather than left to surprise. */
      requestReset: function (email) {
        var back = location.origin + location.pathname.replace(/[^/]*$/, '') + 'paddle.html';
        return client()
          .then(function (c) { return c.auth.resetPasswordForEmail(email, { redirectTo: back }); })
          .then(function (r) {
            if (r.error) {
              var m = r.error.message || '';
              if (/rate limit/i.test(m)) {
                throw AuctionError('The email limit has been reached for this hour. Try again later, or call the office.');
              }
              throw AuctionError(m);
            }
            return { email: email };
          });
      },

      /* Supabase fires PASSWORD_RECOVERY once a recovery link establishes a
         session. The hash is consumed by the library, so this event is the
         only reliable signal that someone arrived to set a new password. */
      onPasswordRecovery: function (fn) {
        client().then(function (c) {
          c.auth.onAuthStateChange(function (event) {
            if (event === 'PASSWORD_RECOVERY') fn();
          });
        }).catch(function () {});
      },

      /* Office view. The RPCs check is_staff server-side and raise otherwise,
         so a non-staff caller gets an error rather than an empty list. */
      staffLots: function () {
        return client().then(function (c) { return c.rpc('staff_lots'); })
          .then(function (r) {
            if (r.error) {
              if (/not staff/i.test(r.error.message || '')) {
                throw AuctionError('This paddle does not have office access.', 'NOTSTAFF');
              }
              throw AuctionError(r.error.message);
            }
            return r.data || [];
          });
      },
      staffSummary: function () {
        return client().then(function (c) { return c.rpc('staff_summary'); })
          .then(function (r) {
            if (r.error) {
              if (/not staff/i.test(r.error.message || '')) {
                throw AuctionError('This paddle does not have office access.', 'NOTSTAFF');
              }
              throw AuctionError(r.error.message);
            }
            return (r.data && r.data[0]) || null;
          });
      },

      isMine: function (lot) {
        var p = positions[lot.lot_no];
        return !!(p && p.is_leading);
      },
      myMax: function (lot) {
        var p = positions[lot.lot_no];
        return p ? p.my_max_cents : null;
      },
      subscribe: function (fn) {
        listeners.push(fn);
        if (!channel) {
          client().then(function (c) {
            channel = c.channel('lots')
              .on('postgres_changes',
                  { event: 'UPDATE', schema: 'public', table: 'lots' },
                  function (payload) {
                    listeners.forEach(function (f) { f(payload.new); });
                  })
              .subscribe();
          });
        }
        return function () { listeners = listeners.filter(function (f) { return f !== fn; }); };
      }
    };
  }

  var backend =
      CFG.backend === 'local'    ? LocalBackend()
    : CFG.backend === 'supabase' ? SupabaseBackend()
    :                              DemoBackend();

  backend.incrementCents  = incrementCents;
  backend.protectionCents = protectionCents;
  global.HLA_API = backend;
})(window);
