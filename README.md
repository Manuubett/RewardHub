# SemaAfrica Rewards

Website (HTML/JS) + Firebase Auth/Firestore + your own Node server in `server/`. No Cloud Functions, no Blaze plan needed.

Users open **20 sponsored opportunities (BTN001–BTN020)**, earn **points** after a partner confirms the activity and an admin approves it, and see everything in a points wallet. Redeeming points for M-Pesa is **not built yet** (see "Not included yet").

> **Read first:** do not award points for ordinary ad-network clicks. Monetag prohibits incentivized clicks. Only switch an opportunity on when its provider has given written permission for rewarded activity. The admin screen forces you to confirm this before an opportunity can go live. Details: `README_SEMAAFRICA_REWARDS_UPDATE.md`, section 1.

## What changed from RewardHub
| Area | Now |
|---|---|
| Admin check | Same rule in the website, server and Firestore rules: you are an admin if you have a document at `admins/{your-uid}` **or** the Firebase custom claim `admin: true`. |
| Points | New collections `opportunities`, `activityAttempts`, `cooldowns`, `pointLedger`, `providerEvents`, `adminAudit`. Points are separate from the old KES balances. |
| Cooldown | Per opportunity, enforced by the server in a Firestore transaction. The browser only displays the countdown. |
| Backend | `server/index.js` (existing) + `server/points.js` (new). The root `index.js` now just points to `server/index.js`. |
| Old KES tasks | Still work unchanged (campaigns, `/postback`, withdrawals, M-Pesa B2C). |

## 1. Firebase
1. Authentication > enable **Email/Password**. Firestore Database > create.
2. **Publish the new `firestore.rules`**: Firestore > Rules > paste the file > Publish. (Without this the Earn page cannot read opportunities.)
3. Project settings > Service accounts > **Generate new private key**. Save as `server/serviceAccountKey.json`. Never upload it to GitHub.

## 2. Run the server
```
cd server
npm install
cp ../env.example .env      # set ALLOWED_ORIGINS to your site, e.g. https://manuubett.github.io
npm start
```
Test: open http://localhost:3000/health and you should see `ok`.

## 3. Host the server
The site is on GitHub Pages (https), so the server must also be **https** (Render, Railway, Fly.io, or a VPS with Caddy/Nginx).
Upload the `server` folder, set `ALLOWED_ORIGINS` and `SERVICE_ACCOUNT_JSON`, start command `npm start`, then set `API_URL` in `firebase-config.js`.
If your host starts from the repository root instead, that also works: the root `index.js` loads `server/index.js`.

## 4. Make yourself admin
Register on the site, then in the Firebase console: Firestore Database > **Start collection** `admins` > Document ID = **your user UID** (Authentication > Users > copy the UID) > add any field, e.g. `role` = `admin` > Save. **Log out and in**; the Admin tab appears.
Only the document's existence matters, not its fields. Nobody can create it from the website; only you in the console.
Alternative if you can run Node: in `server/` run `node setAdmin.js you@email.com` to grant the custom claim instead (either method is enough).

## 5. Set up the 20 opportunities
1. Admin > scroll to **Opportunities** > click **Create the missing BTN001–BTN020 entries**. They are created **paused** with placeholder text.
2. Open each one and fill in: title, provider, destination URL (https), reward points, cooldown minutes, requirements.
3. If the provider supports signed confirmations: add them under **Advertising partners**, pick that partner in the opportunity, and give the partner the points postback URL below.
4. Tick **"The provider has given written permission for rewarded activity"** and say where that permission is recorded. Only then can you tick **Active**.

## 6. Provider confirmation (points postback)
```
GET https://YOUR-SERVER/postback/points?partner=PARTNER_ID&click_id={tracking_ref}&txn_id={unique}&event=conversion&sig=SIG
SIG = hex HMAC-SHA256(partner_secret, "click_id|txn_id|event")
```
- `click_id` is the tracking reference SemaAfrica appended to the destination URL (parameter name set per opportunity, default `click_id`).
- `conversion` moves the activity to **Awaiting review** and adds the points to the user's *pending* balance. `valid_click` is only accepted for opportunities whose type is "Click". `reversed` removes the points (pending or approved) with a ledger entry. Any other event is ignored.
- A confirmation never makes points spendable by itself: an admin must **Approve** in Admin > Awaiting review.
- Duplicate events, wrong signatures, unknown references, another partner's reference and confirmations later than 7 days are rejected.
- Do not hand this URL to a provider until you know their real callback format. If it differs, write an adapter instead of bending their format.

## 7. Reviewing activity
Admin > **Awaiting review** lists provider-confirmed activity. **Recent activity** also shows "Started" items that have no provider confirmation. Approving one of those needs a note (10+ characters) describing the evidence you checked. Rejecting always needs a reason. You cannot review your own activity. Every decision is written to `pointLedger` and `adminAudit`; ledger entries are never edited or deleted (corrections are new entries).

## 8. M-Pesa B2C withdrawals (old KES wallet, unchanged)
Fill the `MPESA_*`, `PUBLIC_URL` and `CALLBACK_TOKEN` values in `server/.env`. Start with `MPESA_ENV=sandbox`.
Admin > Withdrawal requests shows **Pay via M-Pesa**. Flow: pending > submitting > submitted > paid, or failed (balance refunded).
- Safaricom calls `PUBLIC_URL/mpesa/result` and `/mpesa/timeout`; both need the token and must be reachable over https.
- A **timeout never refunds automatically**: it becomes `needs_review`. Check the Daraja portal, then *Mark paid (manual)* or *Reject* (refunds).
- If the server can't tell whether money was sent (`submission_error`), do not retry until you have checked in Daraja.
- You need approved Safaricom B2C production access, shortcode and security credential before real payouts.

## Not included yet
- **Points to M-Pesa redemption** (needs a decided points-to-KES rate; build it only after the points accounting has been proven in staging).
- Admin date filters beyond the 7/30-day summaries, and pagination (Admin loads the latest 200 activities and 500 ledger entries).
- A real provider integration: the 20 opportunities ship with placeholder content and are paused.
- reCAPTCHA / App Check and IP checks before launch. Get terms, tax and data-protection advice before handling advertiser money.
- Firestore Emulator tests of `firestore.rules`. The backend logic and the pages were tested with in-memory fakes, **not** against real Firebase. Test everything in a staging project first (checklist in `README_SEMAAFRICA_REWARDS_UPDATE.md`, section 12).

## The ad tag in `index.html`
`index.html` still loads one site-wide Monetag script. It runs on every page, including Earn. Remove it, or get written confirmation from Monetag that it may run alongside rewarded activities, before launching point rewards.

## Folders
`server/` live backend · `legacy/` and `functions/` old copies, do not deploy · `index.js`, `package.json`, `setAdmin.js` in the root are thin copies for hosts that start from the root.
