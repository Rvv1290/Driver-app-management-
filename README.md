# RVIP Admin Backend

Standalone Node.js admin API for the RVIP driver app. **Does not touch your existing seacoastrvip.com webapp.**

## Why a separate backend?

- Service account key never goes near the browser (never expose it in HTML/JS).
- Lives at its own URL (e.g. `admin-api.seacoastrvip.com`), with its own deploy.
- Uses Firebase Admin SDK which **bypasses Firestore security rules** — your live webapp's rules stay completely unchanged.
- You can shut it off, redeploy it, or rotate its key without ever touching the rider/driver apps.

## Quick local run

1. `cd rvip-admin-backend`
2. `npm install`
3. Copy the service account JSON you downloaded from Firebase Console here. Name it `seacoast-admin-key.json`.
4. `cp .env.example .env` — edit it, set `ADMIN_API_TOKEN` to a long random string (`openssl rand -hex 32`).
5. `npm start`
6. Open `http://localhost:3000/healthz` — should say `{"ok":true}`.
7. Test a real endpoint:
   ```
   curl -H "Authorization: Bearer YOUR_ADMIN_API_TOKEN" \
     http://localhost:3000/api/drivers
   ```

## Deploy to Render (free tier — recommended, isolated from your webapp)

1. Push this folder (with `.gitignore` — the JSON key MUST NOT go to GitHub) to a new private GitHub repo.
2. https://render.com → New → Web Service → connect that repo.
3. Build command: `npm install`
4. Start command: `npm start`
5. **Environment variables** in Render dashboard:
   - `SERVICE_ACCOUNT_KEY_JSON` — paste the entire JSON file content as one line (Render escapes it automatically).
   - `ADMIN_API_TOKEN` — your random string from step 4 above.
   - `ADMIN_ORIGIN` — `https://seacoastrvip.com` (or wherever your admin HTML lives).
6. Deploy. You get a URL like `https://rvip-admin-backend.onrender.com`.

## Deploy alternatives

- **Railway** — similar flow, $5/mo for always-on (Render free sleeps after 15 min idle).
- **Fly.io** — `fly launch`, free tier, never sleeps.
- **Cloud Run** (GCP) — pay per request, scales to zero, native to your existing Firebase project.

All four are isolated from your existing webapp hosting — you can pick whichever you're already comfortable with.

## Endpoints

| Method | Path | What |
|---|---|---|
| GET | `/healthz` | health check (no auth) |
| GET | `/api/drivers` | list all drivers |
| GET | `/api/drivers/:id` | one driver + signed URLs for their documents |
| POST | `/api/drivers/:id/verify` | flip `isVerified: true` |
| POST | `/api/drivers/:id/suspend` | body: `{ suspended: true, reason }` |
| POST | `/api/drivers/:id/docs/:type/approve` | `:type` is `dl_front`, `coi`, `registration`, `tnc_inspection` |
| POST | `/api/drivers/:id/docs/:type/reject` | body: `{ reason }` |
| GET | `/api/drivers/:id/payouts/:week` | `:week` is `2026_W26`. Returns total + trip detail. |
| POST | `/api/drivers/:id/payouts/:week/mark-paid` | body: `{ amount, method, note }`. The driver app sees the green PAID badge instantly. |
| POST | `/api/drivers/:id/payouts/:week/mark-unpaid` | undo |
| GET | `/api/payouts/pending` | every driver's current week, for the dashboard |

All require `Authorization: Bearer YOUR_ADMIN_API_TOKEN`.

## Admin HTML side (sketch)

Your existing seacoastrvip.com webapp can have a `/admin` subroute that just makes `fetch()` calls to this backend's URL. The HTML doesn't need any Firebase SDK at all — it just calls the backend.

```html
<script>
const API = "https://rvip-admin-backend.onrender.com";
const TOKEN = "YOUR_ADMIN_API_TOKEN";  // load from a cookie or login flow

async function loadDrivers() {
  const r = await fetch(`${API}/api/drivers`, {
    headers: { Authorization: `Bearer ${TOKEN}` }
  });
  const { drivers } = await r.json();
  console.log(drivers);
}
</script>
```

## Security notes

- The service account JSON gives FULL project access. Never commit it. Never paste it into any browser-side code.
- `ADMIN_API_TOKEN` is the gate between your admin HTML and this backend. Make it long and random.
- Set `ADMIN_ORIGIN` to your admin frontend's exact origin so CORS blocks any other site.
- Rotate the token (and key, if needed) by changing the env vars and redeploying — no app code changes.
