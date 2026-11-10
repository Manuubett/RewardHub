# RewardHub setup

## 1. Firebase project
1. console.firebase.google.com > create a project.
2. Build > Authentication > enable **Email/Password**.
3. Build > Firestore Database > create (production mode).
4. Upgrade to **Blaze** plan (required for Cloud Functions; free tier usage still applies).
5. Project settings > Your apps > Web app > copy the config into `firebase-config.js`.

## 2. Deploy
```
npm i -g firebase-tools && firebase login
firebase init        # choose Firestore, Functions (JavaScript), Hosting (public dir = .)
                     # keep my firestore.rules and functions/ files when asked to overwrite: say NO
firebase deploy
```

## 3. Make yourself admin
Register normally on the site, then:
```
cd functions && npm i
GOOGLE_APPLICATION_CREDENTIALS=serviceAccountKey.json node setAdmin.js you@email.com
```
Log out and in. An **Admin** tab appears.

## 4. Onboard an advertising partner
Admin > Advertising partners > Add partner. Give the partner:
- their **Partner ID** and **Secret**
- the postback URL: `https://us-central1-YOUR_PROJECT.cloudfunctions.net/postback`

They call it server-to-server:
```
GET /postback?partner=ID&click_id={click_id}&txn_id={their_unique_txn}&event=conversion&sig=SIG
SIG = hex HMAC-SHA256(secret, "click_id|txn_id|event")
```
Events: `conversion` (or `valid_click` for click campaigns) > pending, `approved` > withdrawable, `reversed` > deducted.
When you add a campaign, your tracking URL receives `click_id` automatically; the partner must echo it back.

## Fraud controls built in
| # | Control | Where |
|---|---|---|
| 1 | Clicks never pay; only partner postbacks do (`cpc` campaigns need a partner-signed `valid_click`) | `postback` |
| 2 | Signed server-to-server postback, HMAC checked | `postback` |
| 3 | Unique `partner_txn_event` doc blocks duplicate rewards | `postback` transaction |
| 4 | Rewards stay pending until `approved` | `postback` |
| 5 | `reversed` deducts the reward (balance can go negative, blocking withdrawals) | `postback` |
| 6 | One phone per account, shared-device accounts flagged and blocked from withdrawing, admin can suspend | `registerProfile`, Admin |
| 7 | Append-only `ledger`, written only by functions (client writes denied by rules) | rules + functions |

## Not included yet (be aware)
- **M-Pesa payout is manual**: admin sends money, then clicks *Mark paid*. To automate, add Safaricom Daraja B2C inside `adminDecideWithdrawal` before marking paid.
- Device check is a simple browser ID; add Firebase App Check + reCAPTCHA and IP rate limiting before launch.
- Get a lawyer/accountant to review terms, data protection (Kenya DPA) and tax before handling real advertiser money.
