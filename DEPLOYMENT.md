# Deploying SalesPoint

Database: Supabase (already running). API: Render. Website: Vercel.
Deploy in this order: push code, API, website, then connect them.

## 0. Before you start
- Run the app locally once and make sure `npx prisma@5.22.0 migrate deploy` says no pending migrations.
- Keep your local `.env` values handy. You will paste several of them into Render.
- **Reuse your existing `ENCRYPTION_KEY`.** Paystack keys saved in the database are encrypted with it. A new key makes them unreadable.

## 1. Put both projects on GitHub
For each folder (backend, frontend), in PowerShell:
```
git init
git add .
git commit -m "SalesPoint"
```
Create two empty PRIVATE repos on GitHub (salespoint-api, salespoint-web), then:
```
git remote add origin https://github.com/YOUR-NAME/salespoint-api.git
git branch -M main
git push -u origin main
```
Check `git status` shows no `.env` file. The included `.gitignore` keeps it out.

## 2. API on Render
1. render.com, New, Blueprint (or Web Service, Docker), connect the salespoint-api repo.
2. Fill in the environment variables:

| Name | Value |
|---|---|
| NODE_ENV | production |
| DATABASE_URL | your Supabase pooler URL, port 5432 (same as local) |
| JWT_ACCESS_SECRET | 32+ random characters |
| JWT_REFRESH_SECRET | 32+ random characters, different |
| ENCRYPTION_KEY | the same value as your local `.env` |
| ALLOWED_ORIGINS | `https://YOUR-APP.vercel.app` (fill in after step 3; no trailing slash) |
| PASSWORD_RESET_BASE_URL | `https://YOUR-APP.vercel.app/reset-password` |
| PAYSTACK_CALLBACK_URL | `https://YOUR-APP.vercel.app/dashboard/pos` |
| RESEND_API_KEY / RESEND_FROM_EMAIL | from Resend |

Make secrets with: `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`

3. Deploy. The start command applies new database migrations by itself.
4. Open `https://YOUR-API.onrender.com/health`. You should see `{"status":"ok"}`.

The free plan sleeps after 15 minutes idle, so the first request takes about a minute. Use the Starter plan before real customers.

## 3. Website on Vercel
1. vercel.com, Add New Project, import salespoint-web. Framework: Next.js (auto).
2. Environment variables (both are the API's address, no trailing slash):
   - `NEXT_PUBLIC_API_BASE_URL` = `https://YOUR-API.onrender.com`
   - `API_BASE_URL` = `https://YOUR-API.onrender.com`
3. Deploy, then copy the Vercel URL.
4. Go back to Render and set `ALLOWED_ORIGINS`, `PASSWORD_RESET_BASE_URL` and `PAYSTACK_CALLBACK_URL` to that URL. Render redeploys.

## 4. Paystack
In the Paystack dashboard, Settings, API Keys and Webhooks, set the webhook URL to
`https://YOUR-API.onrender.com/webhooks/paystack`.
Each business adds its own keys in the app under Settings, Paystack.

## 5. Test the live site
- Register or log in, then log out (you should stay on the login page).
- Add a product, make a sale, open a shift.
- Forgot password: the email link should open the reset page on your Vercel domain.
- `/till`: PIN login for a cashier.

## When something breaks
- **Login says "Could not reach the server" or a CORS error:** `ALLOWED_ORIGINS` is wrong. It must exactly match the Vercel URL.
- **API crashes at start:** open the Render logs. A missing variable is named in the message.
- **Database unreachable (P1001):** the Supabase project is paused, or the URL is wrong.
- Update later by pushing to GitHub. Both services redeploy automatically.
