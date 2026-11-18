# Refill card history API implementation plan

**Design:** docs/specs/2026-11-18-refillcard-history-design.md
**Goal:** Add `GET /api/topup/refillcard` returning paged scratch-card refill rows from `MBAPP.dbo.Tb_Refillcard` (server 100), newest first, with a date range and optional phone filter.
**Approach:** One parameterized query on `Tb_Refillcard WITH (NOLOCK)`, bounded by `CDate` range, optional `MSISDN IN (@phone, @legacyPhone)`, `COUNT(*) OVER ()` + `OFFSET/FETCH` paging; PIN masked in SQL. Adds one service function (`src/services/topup.service.js`), one controller (`src/controllers/topup.controller.js`) and one route (`src/routes/topup.routes.js`).
**Measured query time:** 0.03 s for 1 day, 0.73 s for 31 days, 0.05 s for one phone across all years.

Read `.claude/skills/writing-plans/references/project-conventions.md` before starting. The DB is
production: run only `SELECT`. Never print `.env`.

Live data keeps growing, so counts below are "at least" values measured on 2026-11-18.

## Tasks

### Task 1: Service function `getRefillCardHistory`

**Files:**
- Modify: `src/services/topup.service.js`
  - line 1 import
  - append new code at the end of the file, after `getTopupLogsByDay`

**Steps:**

1. Change the import on line 1 from:
   ```js
   import { getDb135, sql } from "../config/db.js";
   ```
   to:
   ```js
   import { getDb100, getDb135, sql } from "../config/db.js";
   ```

2. Append at the end of the file (after `getTopupLogsByDay`):
   ```js

   /**
    * Some Tb_Refillcard rows store MSISDN in an old form:
    *   20XXXXXXXX -> "02" + last 8 digits (e.g. 2077861223 -> 0277861223)
    *   30XXXXXXX  -> "0" + the number    (e.g. 307123456  -> 0307123456)
    * @param phone normalized phone (output of normalizePhone)
    */
   const toLegacyRefillCardPhone = (phone) =>
       phone.startsWith("20") ? `02${phone.slice(2)}` : `0${phone}`;

   /**
    * Scratch-card refill history from MBAPP.dbo.Tb_Refillcard on server 100 (paged, newest first).
    * Based on:
    *   SELECT TOP (1000) TransID, UserID, MSISDN, Type, Pinno, Code, RDesc, Trans_id, Status,
    *          Amount, OldBalance, NewBalance, CDate, Service, Deatil
    *   FROM [MBAPP].[dbo].[Tb_Refillcard] ORDER BY CDate DESC
    *
    * ~751k rows, no indexes, but small: 31 days takes ~0.7 s, one phone over all years ~0.05 s.
    * Pinno holds scratch-card PINs, so only the last 4 characters are returned.
    * Code = '0' is the reliable success flag (Status is '' on ~335k rows).
    *
    * @param from, to  "YYYY-MM-DD HH:mm:ss" (`to` exclusive)
    * @param phone     optional normalized phone, matched against MSISDN (also its legacy form)
    */
   export const getRefillCardHistory = async ({ from, to, phone, page, limit }) => {
       const db100Pool = await getDb100();

       const refillCardQuery = `
           SELECT
               refillCard.TransID      AS transId,
               refillCard.UserID       AS userId,
               refillCard.MSISDN       AS phone,
               refillCard.Type         AS type,
               CASE WHEN LEN(refillCard.Pinno) > 4
                    THEN REPLICATE('*', LEN(refillCard.Pinno) - 4) + RIGHT(refillCard.Pinno, 4)
                    ELSE REPLICATE('*', LEN(refillCard.Pinno))
               END                     AS pin,
               refillCard.Code         AS code,
               refillCard.RDesc        AS description,
               refillCard.Trans_id     AS refTransId,
               refillCard.Status       AS status,
               CAST(CASE WHEN refillCard.Code = '0' THEN 1 ELSE 0 END AS bit) AS isSuccess,
               TRY_CONVERT(decimal(18, 2), refillCard.Amount)     AS amount,
               TRY_CONVERT(decimal(18, 2), refillCard.OldBalance) AS oldBalance,
               TRY_CONVERT(decimal(18, 2), refillCard.NewBalance) AS newBalance,
               CONVERT(varchar(23), refillCard.CDate, 121)        AS createdAt,
               refillCard.Service      AS service,
               NULLIF(NULLIF(refillCard.Deatil, 'null'), '')      AS detail,
               COUNT(*) OVER ()        AS totalRows
           FROM dbo.Tb_Refillcard AS refillCard WITH (NOLOCK)
           WHERE refillCard.CDate >= @from AND refillCard.CDate < @to
             AND (@phone IS NULL OR refillCard.MSISDN IN (@phone, @legacyPhone))
           ORDER BY refillCard.CDate DESC
           OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY;`;

       const queryResult = await db100Pool
           .request()
           .input("from", sql.VarChar(19), from)
           .input("to", sql.VarChar(19), to)
           .input("phone", sql.VarChar(15), phone || null)
           .input("legacyPhone", sql.VarChar(15), phone ? toLegacyRefillCardPhone(phone) : null)
           .input("offset", sql.Int, (page - 1) * limit)
           .input("limit", sql.Int, limit)
           .query(refillCardQuery);

       return buildPageResult(queryResult.recordset, page, limit);
   };
   ```
   `buildPageResult` is the local (non-exported) helper already defined near the top of
   `topup.service.js`; reuse it as is.

**Verify:** (run from the project root; PowerShell users: run inside Git Bash or the Bash tool)
```bash
cat > _verify_service.mjs <<'EOF'
import { getRefillCardHistory } from "./src/services/topup.service.js";
const timed = async (label, args) => {
  const startedAt = Date.now();
  const refillPage = await getRefillCardHistory(args);
  console.log(label, "rows:", refillPage.data.length, "total:", refillPage.pagination.total, "ms:", Date.now() - startedAt);
  return refillPage;
};
const oneDay = await timed("one day", { from: "2026-11-17 00:00:00", to: "2026-11-18 00:00:00", phone: null, page: 1, limit: 5 });
console.log(JSON.stringify(oneDay.data[0], null, 2));
await timed("31 days", { from: "2026-10-18 00:00:00", to: "2026-11-18 00:00:00", phone: null, page: 1, limit: 10 });
await timed("phone + legacy, 1 year", { from: "2025-11-18 00:00:00", to: "2026-11-19 00:00:00", phone: "2076946001", page: 1, limit: 100 });
await timed("past last page", { from: "2026-11-17 00:00:00", to: "2026-11-18 00:00:00", phone: null, page: 9999, limit: 10 });
process.exit(0);
EOF
node _verify_service.mjs; rm _verify_service.mjs
```
Expected:
- `one day rows: 5 total: 278` (exactly 278 — that day is closed), ms well under 1000.
- The printed row has camelCase keys `transId, userId, phone, type, pin, code, description, refTransId, status, isSuccess, amount, oldBalance, newBalance, createdAt, service, detail`, no `totalRows`; `pin` looks like `***********1234`; `isSuccess` is a boolean; `amount` is a number (e.g. `10000`); `createdAt` like `"2026-11-17 23:12:05.123"`; `detail` is `null` when stored as `'null'`.
- `31 days rows: 10 total: <several thousand>`, ms < 2000.
- `phone + legacy, 1 year rows: 53 total: 53` or more (43 rows stored as `2076946001` + 10 as `0276946001`). If total is 43, the legacy match is broken.
- `past last page rows: 0 total: 0`.

**Done when:** all four lines print as expected and the file still exports the four existing functions unchanged.

### Task 2: Controller `getRefillCardHistory`

**Files:**
- Modify: `src/controllers/topup.controller.js`
  - import blocks at the top (lines 1-15)
  - constants (after line 20, `FAILURE_MESSAGE`)
  - append new controller at the end of the file, after `getLogsByDay`

**Steps:**

1. In the service import (lines 1-6), add `getRefillCardHistory` so it reads:
   ```js
   import {
       getDailyTopupsByReceiver,
       getRefillCardHistory as getRefillCardHistoryPage,
       getTopupHistory,
       getTopupHistoryByPhone,
       getTopupLogsByDay,
   } from "../services/topup.service.js";
   ```
   (Aliased because the controller has the same name.)

2. In the helpers import (lines 7-15), add `parseOptionalPhone` so it reads:
   ```js
   import {
       BadRequestError,
       normalizePhone,
       parseDateRange,
       parseDay,
       parseOptionalPhone,
       parsePagination,
       parseStatus,
       sendErrorResponse,
   } from "../utils/request.helpers.js";
   ```

3. After the line `const FAILURE_MESSAGE = "Failed to get top-up history";` add:
   ```js

   // Refill card log (MBAPP.dbo.Tb_Refillcard on server 100)
   const REFILL_CARD_FAILURE_MESSAGE = "Failed to get refill card history";
   const REFILL_CARD_DEFAULT_DAYS = 1;
   const REFILL_CARD_PHONE_DEFAULT_DAYS = 30;
   const REFILL_CARD_PHONE_MAX_RANGE_DAYS = 366;
   ```

4. Append at the end of the file:
   ```js

   /**
    * GET /api/topup/refillcard?from=2026-11-01&to=2026-11-18&phone=02076654156&page=1&limit=10
    * Scratch-card refill history (MBAPP.dbo.Tb_Refillcard), newest first.
    * Query params:
    *   from, to    - "YYYY-MM-DD" or "YYYY-MM-DD HH:mm:ss". Default: today (last 30 days with phone).
    *                 Max range: 31 days, or 366 days when phone is given.
    *   phone       - optional phone that received the refill (MSISDN), any Lao format
    *   page, limit (default 1, 10; max limit 100)
    */
   export const getRefillCardHistory = async (req, res) => {
       try {
           const queryParams = req.query;
           const phone = parseOptionalPhone(queryParams.phone, "phone");
           const dateRange = parseDateRange(queryParams, phone
               ? { defaultDays: REFILL_CARD_PHONE_DEFAULT_DAYS, maxRangeDays: REFILL_CARD_PHONE_MAX_RANGE_DAYS }
               : { defaultDays: REFILL_CARD_DEFAULT_DAYS, maxRangeDays: MAX_RANGE_DAYS });

           const refillCardPage = await getRefillCardHistoryPage({
               ...dateRange,
               phone,
               ...parsePagination(queryParams),
           });

           res.json({ success: true, phone, filter: dateRange, ...refillCardPage });
       } catch (error) {
           sendErrorResponse(res, "GET /api/topup/refillcard", error, REFILL_CARD_FAILURE_MESSAGE);
       }
   };
   ```
   `parseOptionalPhone`, `parseDateRange`, `parsePagination`, `sendErrorResponse` come from
   `src/utils/request.helpers.js`; `MAX_RANGE_DAYS` (31) is already defined in this file.

**Verify:**
```bash
node -e "import('./src/controllers/topup.controller.js').then(controllerModule => { console.log(Object.keys(controllerModule).sort().join(',')); process.exit(0); })"
```
Expected: `getDailyByPhone,getHistory,getHistoryByPhone,getLogsByDay,getRefillCardHistory` (no import/syntax error).

**Done when:** the module loads and exports `getRefillCardHistory` alongside the four existing controllers.

### Task 3: Route + endpoint check

**Files:**
- Modify: `src/routes/topup.routes.js`

**Steps:**

1. Replace line 2:
   ```js
   import { getDailyByPhone, getHistory, getHistoryByPhone, getLogsByDay } from "../controllers/topup.controller.js";
   ```
   with:
   ```js
   import { getDailyByPhone, getHistory, getHistoryByPhone, getLogsByDay, getRefillCardHistory } from "../controllers/topup.controller.js";
   ```

2. After `router.get("/logs", getLogsByDay);` add:
   ```js
   router.get("/refillcard", getRefillCardHistory);
   ```
   Do not change the existing routes. `index.js` already mounts this router at `/api/topup`.

**Verify:**
```bash
(PORT=5099 node index.js > /dev/null 2>&1 &) ; for i in $(seq 1 30); do curl -s localhost:5099/health/db >/dev/null && break; sleep 1; done
B=localhost:5099/api/topup/refillcard
curl -s -w '  [%{http_code} %{time_total}s]\n' "$B?limit=2" | head -c 900; echo
curl -s -w '  [%{http_code}]\n' "$B?from=2026-11-17&to=2026-11-17&limit=1&page=2" | head -c 600; echo
curl -s "$B?from=2026-11-17&to=2026-11-17&limit=1" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const r=JSON.parse(s);console.log('total',r.pagination.total,'filter',JSON.stringify(r.filter))})"
curl -s "$B?phone=02076946001&from=2025-11-18&to=2026-11-18&limit=100" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const r=JSON.parse(s);console.log('phone',r.phone,'total',r.pagination.total,'forms',[...new Set(r.data.map(x=>x.phone))].join('|'))})"
curl -s "$B?phone=2077993555" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const r=JSON.parse(s);console.log('default phone range',JSON.stringify(r.filter),'total',r.pagination.total)})"
curl -s -w '  [%{http_code}]\n' "$B?phone=123"
curl -s -w '  [%{http_code}]\n' "$B?from=2026-01-01&to=2026-03-01"
curl -s -w '  [%{http_code}]\n' "$B?phone=2077993555&from=2024-01-01&to=2026-11-18"
curl -s -w '  [%{http_code}]\n' "$B?from=2026-13-45"
curl -s -w '  [%{http_code}]\n' "$B?from=2026-11-18&to=2026-11-10"
powershell -c "Get-NetTCPConnection -LocalPort 5099 -State Listen | % { Stop-Process -Id \$_.OwningProcess -Force }"
```
Expected:
1. `{"success":true,"phone":null,"filter":{"from":"2026-11-18 00:00:00","to":"2026-11-19 00:00:00"},"data":[…2 rows…],"pagination":{"page":1,"limit":2,…}}  [200 <1s]` — rows have masked `pin` and boolean `isSuccess`.
2. `"pagination":{"page":2,"limit":1,"total":278,"totalPages":278}` `[200]`.
3. `total 278 filter {"from":"2026-11-17 00:00:00","to":"2026-11-18 00:00:00"}`.
4. `phone 2076946001 total 53` (or more) and `forms 2076946001|0276946001` (order may differ).
5. `default phone range {"from":"2026-10-20 00:00:00","to":"2026-11-19 00:00:00"} total 66` (or more; dates shift with the current day — `from` is 29 days before today).
6. `{"success":false,"message":"phone is not a valid phone number"}  [400]`
7. `{"success":false,"message":"Date range cannot exceed 31 days"}  [400]`
8. `{"success":false,"message":"Date range cannot exceed 366 days"}  [400]`
9. `{"success":false,"message":"`to` must be after `from`"}  [400]` — `2026-13-45` passes the shared `DATE_PATTERN` but is an invalid date, so `parseDateRange` reports it this way (existing helper behaviour, same on `/history`; do not change the shared helper in this task).
10. `{"success":false,"message":"`to` must be after `from`"}  [400]`

**Done when:** every call returns the expected status and body, and the server on 5099 is stopped.

### Task 4: Regression check + summary

**Files:** none changed.

**Steps:**
1. Start the throwaway server, call the existing endpoints that share the changed files, stop the server:
   ```bash
   (PORT=5099 node index.js > /dev/null 2>&1 &) ; for i in $(seq 1 30); do curl -s localhost:5099/health/db >/dev/null && break; sleep 1; done
   curl -s -w '  [%{http_code} %{time_total}s]\n' "localhost:5099/api/topup/history?limit=1" | tail -c 200; echo
   curl -s -w '  [%{http_code} %{time_total}s]\n' "localhost:5099/api/topup/logs?date=2026-11-17&limit=1" | tail -c 200; echo
   curl -s -w '  [%{http_code} %{time_total}s]\n' "localhost:5099/api/topup/historyByPhone/?phone=2077861223&limit=1" | tail -c 200; echo
   curl -s -w '  [%{http_code}]\n' "localhost:5099/health/db"
   powershell -c "Get-NetTCPConnection -LocalPort 5099 -State Listen | % { Stop-Process -Id \$_.OwningProcess -Force }"
   ```
   Expected: each `/api/topup/*` call returns `200` with `"success":true` and a `pagination` object;
   `/health/db` returns `200`.
2. `git diff --stat` should show only `src/services/topup.service.js`, `src/controllers/topup.controller.js`,
   `src/routes/topup.routes.js` changed by this plan (other files may already be modified by the user —
   leave them alone).
3. Write a short summary for the user: new endpoint, params, example call, measured times, and any
   deviations found in Task 3 (e.g. the `2026-13-45` behaviour).

**Done when:** all existing endpoints still respond 200 and the summary is delivered.

## Design → task coverage

| Design requirement | Task |
|---|---|
| Query, masking, isSuccess, number conversion, `detail` null, legacy phone | 1 |
| Phone parsing, date defaults (1 / 30 days), max range (31 / 366), paging, error messages | 2 |
| Route `/api/topup/refillcard` | 3 |
| No change to existing routes/fields | 3, 4 |
