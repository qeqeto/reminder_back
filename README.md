# reminder-backend
API + Telegram ბოტი + cron სკრიპტი. Root Directory არ სჭირდება: repo-ს ძირში არის package.json.

## Railway
**API სერვისი:** New → GitHub Repo → ეს repo. Variables:
```
DATABASE_URL=${{Postgres.DATABASE_URL}}
JWT_SECRET=...
ADMIN_EMAIL=...
ADMIN_PASSWORD=...
FRONTEND_URL=https://<frontend-domain>
```
Settings → Networking → Generate Domain.

**Cron სერვისი:** New → GitHub Repo → იგივე repo. Variables: `DATABASE_URL`, `ADMIN_EMAIL`.
Start Command: `npm run cron`, Cron Schedule: `0 5 * * *` (09:00 თბილისი).

SMTP და Telegram ტოკენი ადმინის პანელიდან ემატება.
