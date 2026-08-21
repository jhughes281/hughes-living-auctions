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
  backend: location.port === '8754' ? 'local' : 'demo',

  supabaseUrl: '',
  supabaseAnonKey: ''
};
