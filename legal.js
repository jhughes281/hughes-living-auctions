/* The legal pages need the header to behave — sign in, the paddle chip, the
   staff-only link — but nothing else. No lots, no clocks, no bidding. */
(function () {
  'use strict';
  var AUTH = window.HLA_AUTH;
  if (!AUTH) return;
  AUTH.bindPaddle();
  if (window.HLA_API && window.HLA_API.canSignIn) AUTH.refresh();
})();
