# RewardHub setup (own Node server)

Website (HTML/JS) + Firebase Auth/Firestore + your own server in `server/`. No Cloud Functions, no Blaze plan needed.

## 1. Firebase
1. Authentication > enable **Email/Password**. Firestore Database > create.
2. Publish `firestore.rules`: Firestore > Rules > paste the file > Publish.
3. Project settings > Service accounts > **Generate new private key**. Save as `server/serviceAccountKey.json`.
   Never upload this file to GitHub or share it.

## 2. Run the server
```
cd server
npm install
cp .env.example .env        # set ALLOWED_ORIGINS to your site, e.g. https://manuubett.github.io
npm start
```
Test: open http://localhost:3000/health and you should see `ok`.

## 3. Host the server (needed for real use)
Your site is on GitHub Pages (https), so the server must also be **https**. Options: Render, Railway, Fly.io or a VPS with Caddy/Nginx.
Upload the `server` folder, set env vars `ALLOWED_ORIGINS` and `SERVICE_ACCOUNT` (or add the key as a secret file), start command `npm start`.
Then set `API_URL` in `firebase-config.js` to your server address and push the site.

## 4. Make yourself admin
Register on the site, then in `server/`: `node setAdmin.js you@email.com`. Log out and in; the Admin tab appears.

## 5. Onboard an advertising partner
Admin > Advertising partners > Add partner. Give them their Partner ID, Secret and your postback URL:
```
GET https://YOUR-SERVER/postback?partner=ID&click_id={click_id}&txn_id={unique}&event=conversion&sig=SIG
SIG = hex HMAC-SHA256(secret, "click_id|txn_id|event")
```
Events: `conversion` (or `valid_click`) > pending, `approved` > withdrawable, `reversed` > deducted.

## Fraud controls
Clicks never pay; signed server-to-server postbacks only; unique transaction IDs; pending until approved; reversals deducted; one phone per account and shared devices flagged; ledger written only by the server (Firestore rules block client writes); rate limiting per IP.

## Not included yet
- M-Pesa payout is manual (send money, click *Mark paid*). Daraja B2C can be added in `adminDecideWithdrawal`.
- Add reCAPTCHA / App Check and IP checks before launch. Get terms, tax and data-protection advice before handling advertiser money.
