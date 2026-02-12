# Squares

Run your own squares board. Hosts create boards, share links, players pick and pay.

## Stack

- **Framework:** Next.js 16 (App Router, TypeScript)
- **Database:** Postgres (Supabase) + Prisma ORM
- **Payments:** Stripe Connect Express
- **Hosting:** Vercel

## Getting Started

```bash
# Install dependencies
npm install

# Set up environment variables
cp .env.example .env
# Fill in DATABASE_URL, STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, NEXT_PUBLIC_URL

# Run database migration
npm run db:migrate

# Start dev server
npm run dev
```

## Environment Variables

| Variable | Description |
|---|---|
| `DATABASE_URL` | Supabase Postgres connection string |
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase anon/public key |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service role key (server-side admin ops) |
| `STRIPE_SECRET_KEY` | Stripe secret key (test mode) |
| `STRIPE_WEBHOOK_SECRET` | Stripe webhook signing secret |
| `NEXT_PUBLIC_URL` | App URL (`http://localhost:3000` for dev) |

## Smoke Test

After setup, hit `GET /api/health` to confirm the app connects to the database.

## Supabase Auth Setup

In your Supabase dashboard → Authentication → URL Configuration:

1. Set **Site URL** to your app URL (`http://localhost:3000` for dev)
2. Add **Redirect URLs**:
   - `http://localhost:3000/auth/callback`
   - `https://your-vercel-domain.vercel.app/auth/callback`

## Stripe Setup

1. Create a Stripe account and enable Connect (Express)
2. Set `STRIPE_SECRET_KEY` in `.env`
3. Set up webhook endpoint:
   - **URL:** `https://your-domain/api/webhooks/stripe`
   - **Events:** `account.updated`, `checkout.session.completed`, `checkout.session.expired`
4. Set `STRIPE_WEBHOOK_SECRET` from the webhook signing secret
5. For local dev, use `stripe listen --forward-to localhost:3000/api/webhooks/stripe`

## Architecture Notes

- **Authorization:** App-layer only (no Postgres RLS). All route protection runs through Next.js middleware + `getHost()` helper. If RLS is added later, it's additive — not a migration.
- **Identity:** Host records are keyed by `supabase_user_id` (auth UUID), not email. Email is display/contact only.
