# Package registration history — design

**Date:** 2026-11-12
**Status:** Approved (brainstorming + grill-me). Next: writing-plans.
**Server / DB:** 22 / SPNV (`getDb22()`), read-only.

## Goal

Let API callers see which data packages a phone number registered (or tried to register), and list
all registrations for a day, including failed attempts and package price/data/validity.

## 1. API

New route file `src/routes/package.routes.js`, mounted at `/api/package` in `index.js`.

### History cutoff

`DREGISTER_PKG` is continuous only from **2026-09-01** (July/August 2026 live only in backup
tables). The earliest supported date comes from `.env`:

```
REGISTER_HISTORY_MIN_DATE=2026-09-01
```

Default `2026-09-01` when the variable is missing or not a valid `YYYY-MM-DD`. When the DBA
archives another month, change this line and restart — no code change.

- Range partly before the cutoff → **clamp** `from` to the cutoff, return 200, echo the clamped
  `filter.from`, and add `"notice": "History before 2026-09-01 is not available"`.
- Range entirely before the cutoff (`to` ≤ cutoff), or day endpoint `date` < cutoff → **400**
  `"History before 2026-09-01 is not available"`.
- Clamping happens after `parseDateRange` (so the 31-day limit is checked on what the caller sent).

### `GET /api/package/registerHistory` — all registrations for one day

| Param | Type | Default | Rules |
|---|---|---|---|
| `date` | `YYYYMMDD` or `YYYY-MM-DD` | today | ≥ cutoff, else 400 (via `parseDay`) |
| `channel` | string, **exact** match on `CHANEL` | — | e.g. `USSD` (does not include `USSD|IR|66`); max 25 chars |
| `packageCode` | digits, exact match on `COUNTERCODE` | — | `/^\d{1,15}$/`, else 400 |
| `status` | `success` \| `failed` | both | via `parseStatus` |
| `page`, `limit` | int | 1, 20 | max 100 via `parsePagination` |

Example: `GET /api/package/registerHistory?date=20261110&channel=USSD&page=2`

### `GET /api/package/registerHistory/:phone` — one phone number

| Param | Type | Default | Rules |
|---|---|---|---|
| `:phone` | any format accepted by `normalizePhone` | required | 400 `"Invalid phone number."` |
| `from`, `to` | `YYYY-MM-DD` or `YYYY-MM-DD HH:mm:ss` | last 30 days | max 31 days (`parseDateRange`), clamped to cutoff |
| `channel`, `packageCode` | same as day endpoint | — | optional |
| `status` | `success` \| `failed` | both | |
| `page`, `limit` | int | 1, 20 | max 100 |

Example: `GET /api/package/registerHistory/02076003655?from=2026-11-01&to=2026-11-12`

## 2. Response

```json
{
  "success": true,
  "phone": "2076003655",
  "filter": { "from": "2026-10-13 00:00:00", "to": "2026-11-13 00:00:00" },
  "data": [
    {
      "id": 199554755,
      "phone": "2076003655",
      "status": "success",
      "channel": "USSD",
      "packageCode": "117",
      "packageName": "TP PPS PK 117",
      "price": 10000,
      "dataMb": "4876",
      "validity": 6,
      "validityUnit": "Day",
      "startTime": "2026-11-12T09:05:10.0700000+07:00",
      "expiryTime": "2026-11-18T09:05:10.0700000+07:00",
      "orderRef": "USSD65520261112090509123",
      "resultCode": "200",
      "resultDesc": "OK.",
      "createdAt": "2026-11-12 09:05:09.327"
    }
  ],
  "pagination": { "page": 1, "limit": 20, "total": 43, "totalPages": 3 }
}
```

- Day endpoint top level: `{ success, date, channel, packageCode, status, data, pagination }`
  (filters echoed, `null` when not given).
- Phone endpoint adds `notice` only when the range was clamped.
- Failed rows always store `"0"` in `START_TIME`, `EXPIRY_TIME`, `ODER_REF` (verified: 0 exceptions
  on 2026-11-10); return `null` for those.
- Packages not in the catalog (promotions, free/loyalty packages, ~6% of rows) return `null` for
  `price`, `dataMb`, `validity`, `validityUnit`. `dataMb` is trimmed (catalog values have trailing spaces).
- `startTime` / `expiryTime` are returned as stored (text with `+07:00`).
- Not returned: `CLIENT_IP` (internal IPs), `USER_ID` (always `APITPLUS`), `REFILL_STOPTIME`,
  `PRODUCTNUMBER`.
- Page past the end returns `data: []` and `total: 0` (same as every other endpoint, because the
  total comes from `COUNT(*) OVER ()` on returned rows).
- Errors: `{ success: false, message }` — 400 for invalid phone, date format, date before cutoff,
  range > 31 days, bad status, invalid `packageCode` or `channel`; 500 "Failed to get package
  registration history" (full error logged with `console.error`).

## 3. Data

### Tables (SPNV on server 22)

| Table | Holds | Size / notes |
|---|---|---|
| `DREGISTER_PKG` | Successful registrations | ~23.6M rows. Months 2026-06 and 2026-09 → now (07/08 missing). Clustered `ID`; nonclustered `(CHANEL, MSISDN, CDATE)`. ~210–234k rows/day. Since 2026-09-01 every row has `RESULT_CODE = '200'` (16.7M rows checked). |
| `DREGISTER_PKG_not_successful` | Failed attempts | ~21.7M rows since 2025-08-21, **no indexes**. ~47k rows/day. Every row `RESULT_CODE = '400'`; reasons vary ("balance is not enough", "your credit limit has been exceeded", …). |
| `Tb_PACKAGE` | Package catalog | 145 rows. `PACKAGE_CODE` is **not unique** (41 codes repeat: POS/PPS, BCEL, old names). |

**Status = which table the row comes from** (success table → `success`, failed table → `failed`);
the result codes confirm it. No `ODER_REF` appears in both tables (checked 2026-11-10).

Phone formats in both tables: `20XXXXXXXX` (10 digits) and a few `30XXXXXXX` (9 digits) — both
produced by `normalizePhone`.

### Query

```sql
SELECT registration.*, pkg.Price, pkg.Amount_mb, pkg.Validity, pkg.Unit, COUNT(*) OVER () AS totalRows
FROM (
    SELECT 'success' AS status, <cols> FROM dbo.DREGISTER_PKG WITH (NOLOCK)
    WHERE <filters> AND (@status IS NULL OR @status = 'success')
    UNION ALL
    SELECT 'failed', <cols> FROM dbo.DREGISTER_PKG_not_successful WITH (NOLOCK)
    WHERE <filters> AND (@status IS NULL OR @status = 'failed')
) registration
OUTER APPLY (
    SELECT TOP 1 catalog.Price, catalog.Amount_mb, catalog.Validity, catalog.Unit
    FROM dbo.Tb_PACKAGE catalog WITH (NOLOCK)
    WHERE catalog.PACKAGE_NAME = registration.COUNTERNAME AND catalog.FLAG = 1
    ORDER BY catalog.PACKAGE_ROW_ID DESC
) pkg
ORDER BY registration.CDATE DESC, registration.status DESC, registration.ID DESC  -- tie-breaker: ~26k rows/day share a CDATE; ID is unique only per table
OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY;
```

- `<cols>`: `ID, CHANEL, MSISDN, COUNTERCODE, COUNTERNAME, START_TIME, EXPIRY_TIME, ODER_REF,
  RESULT_CODE, RESULT_DESC, CDATE`.
- `<filters>`: `CDATE >= @from AND CDATE < @to` (always), plus
  `(@phone IS NULL OR MSISDN = @phone)`, `(@channel IS NULL OR CHANEL = @channel)`,
  `(@packageCode IS NULL OR COUNTERCODE = @packageCode)`. All values parameterized; dates as
  `sql.VarChar(19)`.
- **Package match:** joining on `PACKAGE_CODE` duplicates rows (code 117 has 3 catalog rows).
  Matching `PACKAGE_NAME = COUNTERNAME AND FLAG = 1` matched 208,594 / 221,408 rows on 2026-11-10
  (94%) with 0 ambiguous matches. `OUTER APPLY … TOP 1` guarantees one catalog row per
  registration even if the catalog later gets duplicate active names — and it measured faster than
  `LEFT JOIN`.

### Measured speed (live, 2026-11-12)

| Query | Time |
|---|---|
| Phone, 31 days, both statuses + `OUTER APPLY` (43 rows) | **0.41–0.46 s** |
| One day, both statuses + `OUTER APPLY` + count (268,216 rows) | **3.0–3.3 s** |
| (earlier) One day with `LEFT JOIN` | 4.1–5.9 s |
| One day, success table only + count | ~1.3 s |

## 4. Code

| File | Change |
|---|---|
| `src/services/package.service.js` (new) | `getPackageRegistrations({ from, to, phone, channel, packageCode, status, page, limit })` using `getDb22()`; local `buildPageResult`; maps `"0"` → `null`, trims `dataMb`. |
| `src/controllers/package.controller.js` (new) | `getRegisterHistory` (day) and `getRegisterHistoryByPhone`; validation; reads cutoff from `process.env.REGISTER_HISTORY_MIN_DATE` (default `2026-09-01`); clamp/notice logic. |
| `src/routes/package.routes.js` (new) | `router.get("/registerHistory", getRegisterHistory)`, `router.get("/registerHistory/:phone", getRegisterHistoryByPhone)` |
| `index.js` | `import packageRoutes …`; `app.use("/api/package", packageRoutes)` |
| `src/utils/request.helpers.js` | Move `parseDay` here from `topup.controller.js` (export it) so both controllers use it. |
| `src/controllers/topup.controller.js` | Import `parseDay` from helpers instead of defining it. No behavior change. |
| `.env` | Add `REGISTER_HISTORY_MIN_DATE=2026-09-01` (the user adds it; code works without it). |

One service function serves both endpoints: the day endpoint passes `from = date 00:00:00`,
`to = next day 00:00:00`.

## 5. Out of scope

- Months before the cutoff (monthly `DREGISTER_PKG_BackUp_YYYYMM` tables, no indexes, ~1.3 s per
  month per phone lookup) — can be added later.
- `DREGISTER_PKG_PROMOTIONS`, `DREGISTER_PKG_IR`, `DREGISTER_PKG_4_FRIEND`.
- Summary totals (count/amount per package or channel).
- Prefix/grouped channel matching.
- Any database change (indexes, views).

## Decisions (grill-me)

| Question | Answer |
|---|---|
| Day list with both statuses is slow — accept, default to success, or drop count? | Accept and show both. Switching to `OUTER APPLY TOP 1` brought it to 3.0–3.3 s. |
| How is the history cutoff set? | `.env` `REGISTER_HISTORY_MIN_DATE`, default `2026-09-01`. |
| Range crossing the cutoff? | Clamp `from` to cutoff, return 200 with `notice`. Entirely before cutoff → 400. |
| Channel filter matching? | Exact match. |
| Package catalog duplicates in future? | `OUTER APPLY TOP 1 … ORDER BY PACKAGE_ROW_ID DESC` (decided from data; faster too). |
| What is "success"? | Source table; verified all success rows are `200`, all failed rows `400`. |
| Phone formats? | Verified `20XXXXXXXX` / `30XXXXXXX` only — `normalizePhone` is enough. |
| Expose `CLIENT_IP` / `USER_ID`? | No. |
| Channel/packageCode on phone endpoint? | Yes (same service, no extra cost). |

## Open questions

None.
