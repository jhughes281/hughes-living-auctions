/* Which engine answers the auction questions.

   demo      no server. Rules run in the page against lots-demo.json. Nothing
             persists, nobody else is bidding. This is what the static site
             serves, and it says so on screen.
   local     the Node server in server/, deciding every bid in Postgres.
             Selected automatically when the page is served from it.
   supabase  the same Postgres, hosted. Fill in the two values below and set
             backend to 'supabase'. The anon key is meant to be public — it is
             restricted by row level security. The service_role key is NOT, and
             must never appear in this file or anywhere else the browser sees. */

window.HLA_CONFIG = {
  // Port 8754 is the local dev server; everywhere else is the hosted project.
  backend: location.port === '8754' ? 'local' : 'supabase',

  supabaseUrl: 'https://otkkmcxgufrspwipdfgk.supabase.co',

  // Publishable key. Public by design — row level security is what restricts
  // it, and 0004 verified that at migration time. The SECRET key bypasses all
  // of it and must never appear here.
  supabaseAnonKey: 'sb_publishable_JhOEnBchDxRL-KgYiEG2fw_Z9bHBiT-'
};
