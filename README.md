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

## რეგისტრაცია და ვერიფიკაცია
- ახალი მომხმარებელი თვითონ რეგისტრირდება (`/api/register`) და ანგარიში დაუდასტურებელია.
- თუ SMTP გამართულია (ადმინის პანელი → პარამეტრები), მეილზე მიდის 6-ციფრიანი კოდი (10 წუთი, მაქს. 5 ცდა, ახალი კოდი 1 წუთში ერთხელ).
- თუ Telegram ბოტია მიერთებული, მომხმარებელი QR კოდით/ბმულით გადადის ბოტთან (`/start v_<ერთჯერადი ტოკენი>`) და ანგარიში მაშინვე დასტურდება. ამავე დროს Telegram შეხსენებებიც ეკავშირება.
- თუ ორივე გამორთულია, ადმინი ადასტურებს ხელით (მომხმარებლების გვერდი).
- `/api/health` გვერდით შეგიძლია შეამოწმო, მუშაობს თუ არა API.
