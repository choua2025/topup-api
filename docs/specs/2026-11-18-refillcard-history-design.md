# Refill card history API — design

Date: 2026-11-18 · Status: approved, grilled (ready for writing-plans)

## Goal

Expose the scratch-card refill log (`MBAPP.dbo.Tb_Refillcard` on server 100) through the existing
top-up API, newest first, with paging, a date range and an optional phone filter.

Source query the user started from:

```sql
SELECT TOP (1000) TransID, UserID, MSISDN, Type, Pinno, Code, RDesc, Trans_id, Status,
       Amount, OldBalance, NewBalance, CDate, Service, Deatil
FROM [MBAPP].[dbo].[Tb_Refillcard] ORDER BY CDate DESC
```

## Findings (measured 2026-11-18 on the live DB)

- Server 172.28.17.100, database `MBAPP` (note: `.env` previously said `MDAPP` — fixed). Pool: `getDb100()`.
- ~751k rows, 2020-11-10 → today, ~340 rows/day. **No indexes at all** (heap), but the table is
  small enough that it doesn't matter:

  | Query | Time |
  |---|---|
  | User's `TOP 1000 ORDER BY CDate DESC` | 0.26 s |
  | 1 day, page of 20, `COUNT(*) OVER()` | 0.03 s |
  | 31 days, page of 20, `COUNT(*) OVER()` | 0.73 s |
  | One `MSISDN`, all years, page of 20 | 0.05 s |

- All columns are `varchar` except `CDate` (`datetime`). `Amount`, `OldBalance`, `NewBalance` are
  numbers stored as text.
- `Code = '0'` = success; never combined with `Status = 'false'`. `Status` is `''` on ~335k rows,
  so `Code` is the reliable success flag (not used as a filter in this version).
- `TransID` is non-empty on only 6 rows; the real reference is `Trans_id` (e.g. `TPLUS2026111895131445`).
- `Deatil` is the literal text `'null'` on ~415k rows.
- `UserID` ≠ `MSISDN` on ~25k rows (`UserID` = app user making the request, `MSISDN` = phone refilled).
- `Pinno` holds scratch-card PINs; failed attempts can contain real unused PINs → must be masked.

## 1. API

`GET /api/topup/refillcard`

| Param | Type | Default | Rules |
|---|---|---|---|
| `from`, `to` | `YYYY-MM-DD` or `YYYY-MM-DD HH:mm[:ss]` | today; **last 30 days when `phone` is given** | `parseDateRange`; max **31 days** without `phone`, **366 days** with `phone`; date-only `to` includes the whole day |
| `phone` | string | — | optional; `parseOptionalPhone(value, "phone")`; matched against `MSISDN` in the normalized **and** legacy stored form (see Data) |
| `page`, `limit` | int | 1, 10 | `parsePagination` (max 100) |

Example: `GET /api/topup/refillcard?phone=02076654156&from=2026-11-01&to=2026-11-18&page=1&limit=10`

## 2. Response

```json
{
  "success": true,
  "phone": "2076654156",
  "filter": { "from": "2026-11-01 00:00:00", "to": "2026-11-19 00:00:00" },
  "data": [
    {
      "transId": "",
      "userId": "2078868816",
      "phone": "2078868816",
      "type": "1",
      "pin": "***********1445",
      "code": "0",
      "description": "Operation successfully.",
      "refTransId": "TPLUS2026111895131445",
      "status": "true",
      "isSuccess": true,
      "amount": 10000,
      "oldBalance": 50940,
      "newBalance": 60940,
      "createdAt": "2026-11-18 09:51:31.430",
      "service": "app",
      "detail": null
    }
  ],
  "pagination": { "page": 1, "limit": 10, "total": 341, "totalPages": 35 }
}
```

- `phone` is `null` in the response when not filtered.
- `status` is the raw column (`'true'`, `'false'` or `''`); `isSuccess` is computed from `Code = '0'`
  and is the field callers should use.
- `pin` is `null` when `Pinno` is NULL (1,451 rows). `amount`/`oldBalance`/`newBalance` are `null`
  when the stored text isn't a number (`''`, `'undefined'`, `'NaN'` — ~2.1k rows).
- No rows / page past the end: `data: []`, `pagination.total: 0`, `totalPages: 0` (same as the
  other endpoints, a side effect of `COUNT(*) OVER ()`).

Errors (`{ success: false, message }`):

- 400 `phone is not a valid phone number`
- 400 `from/to must be YYYY-MM-DD or YYYY-MM-DD HH:mm:ss`, `` `to` must be after `from` ``,
  `Date range cannot exceed 31 days` (or `366 days` with `phone`)
- 500 `Failed to get refill card history`

## 3. Data

```sql
SELECT refillCard.TransID AS transId, refillCard.UserID AS userId, refillCard.MSISDN AS phone,
       refillCard.Type AS type,
       CASE WHEN LEN(refillCard.Pinno) > 4
            THEN REPLICATE('*', LEN(refillCard.Pinno) - 4) + RIGHT(refillCard.Pinno, 4)
            ELSE REPLICATE('*', LEN(refillCard.Pinno)) END AS pin,
       refillCard.Code AS code, refillCard.RDesc AS description, refillCard.Trans_id AS refTransId,
       refillCard.Status AS status,
       CAST(CASE WHEN refillCard.Code = '0' THEN 1 ELSE 0 END AS bit) AS isSuccess,
       TRY_CONVERT(decimal(18, 2), refillCard.Amount) AS amount,
       TRY_CONVERT(decimal(18, 2), refillCard.OldBalance) AS oldBalance,
       TRY_CONVERT(decimal(18, 2), refillCard.NewBalance) AS newBalance,
       CONVERT(varchar(23), refillCard.CDate, 121) AS createdAt,
       refillCard.Service AS service,
       NULLIF(NULLIF(refillCard.Deatil, 'null'), '') AS detail,
       COUNT(*) OVER () AS totalRows
FROM dbo.Tb_Refillcard AS refillCard WITH (NOLOCK)
WHERE refillCard.CDate >= @from AND refillCard.CDate < @to
  AND (@phone IS NULL OR refillCard.MSISDN IN (@phone, @legacyPhone))
ORDER BY refillCard.CDate DESC
OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY;
```

- `@from`/`@to` as `sql.VarChar(19)`, `@phone`/`@legacyPhone` as `sql.VarChar(15)`,
  `@offset`/`@limit` as `sql.Int`.
- `@legacyPhone` (computed in the service from the normalized phone): some rows store `MSISDN` in an
  old form (~880 `02…` rows, 80 `030…` rows; ~57 in the last 90 days):
  - `20XXXXXXXX` → `02` + last 8 digits (e.g. `2077861223` → `0277861223`)
  - `30XXXXXXX` → `0` + the number (e.g. `307123456` → `0307123456`)
- PINs ≤ 4 chars are fully masked so short PINs are never shown in full.
- Expected time: < 1 s for any allowed range.

## 4. Code

| File | Change |
|---|---|
| `src/services/topup.service.js` | import `getDb100`; add `getRefillCardHistory({ from, to, phone, page, limit })` using the local `buildPageResult` |
| `src/controllers/topup.controller.js` | add `getRefillCardHistory` controller; constants `REFILL_CARD_FAILURE_MESSAGE`, `REFILL_CARD_DEFAULT_DAYS = 1`, `REFILL_CARD_PHONE_DEFAULT_DAYS = 30`, `REFILL_CARD_PHONE_MAX_RANGE_DAYS = 366`; reuse `MAX_RANGE_DAYS` (31) when no phone. Parse `phone` first, then choose defaults/limits for `parseDateRange` |
| `src/routes/topup.routes.js` | `router.get("/refillcard", getRefillCardHistory);` |

Helpers reused: `parseDateRange`, `parseOptionalPhone`, `parsePagination`, `sendErrorResponse`.
No new shared helpers.

## 5. Out of scope

- Filters on status, `userId`, PIN, service.
- Totals / sums.
- Returning more than 100 rows per page or a CSV export.
- Any DB change (index not needed at current size).

## Decisions (grill-me)

| Question | Answer |
|---|---|
| Phone filter: also match legacy `02…`/`030…` stored forms? | Yes — `MSISDN IN (@phone, @legacyPhone)` |
| Max date range when `phone` is given? | 366 days (31 without phone); default stays 30 days with phone, today without |
| Status field? | Keep raw `status`, add `isSuccess` from `Code = '0'` |
| Non-numeric amounts / NULL PIN? (checked in DB) | Return `null` |
| Page past the end? (checked in code) | `data: []`, `total: 0` — consistent with existing endpoints |
| Decimal amounts? (checked in DB) | None exist; `decimal(18,2)` is safe |

## Open questions

None.
