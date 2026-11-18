# Package registration history implementation plan

**Design:** docs/specs/2026-11-12-package-register-history-design.md
**Goal:** Two endpoints on server 22 (SPNV) that list package registrations (successful and failed)
for one day or one phone number, with package price/data/validity.
**Approach:** One service function `getPackageRegistrations` runs a `UNION ALL` of `DREGISTER_PKG`
(success) and `DREGISTER_PKG_not_successful` (failed), bounded by date, with an
`OUTER APPLY TOP 1` lookup into `Tb_PACKAGE` by name. A new controller validates input and applies
the history cutoff from `.env` (`REGISTER_HISTORY_MIN_DATE`, default `2026-09-01`). `parseDay` moves
to the shared helpers.
**Measured query time:** phone, 31 days ≈ 0.4 s; one full day (268,216 rows) ≈ 3.0–3.3 s.

Read `.claude/skills/writing-plans/references/project-conventions.md` before starting any task.
The database is production: SELECT only.

Known real data used in verification (fixed past dates, so the numbers don't change):

| Query | Expected |
|---|---|
| Day `2026-11-10`, both statuses | total **268,216** |
| Day `2026-11-10`, `status=success` | total **221,408** |
| Day `2026-11-10`, `status=failed` | total **46,808** |
| Day `2026-11-10`, `channel=USSD` | total **254,800** |
| Phone `2076003655`, `2026-10-12` → `2026-11-12` | total ≈ 40–45, includes a failed row on 2026-11-09 with `"balance is not enough"` |

---

## Tasks

### Task 1: Move `parseDay` to shared helpers and add `dayToDateRange`

**Files:**
- Modify: `src/utils/request.helpers.js`
- Modify: `src/controllers/topup.controller.js`

**Steps:**

1. In `src/utils/request.helpers.js`, add this block **directly after** the `parsePagination`
   function (before `parseStatus`). `formatDate` and `addDays` already exist in this file above it.

```js
const DAY_PATTERN = /^(\d{4})-?(\d{2})-?(\d{2})$/; // "YYYY-MM-DD" or "YYYYMMDD"

// Returns the day as "YYYY-MM-DD" (default: today). Throws if the format or date is invalid.
export const parseDay = (dayInput) => {
    if (!dayInput) return formatDate(new Date());

    const dayMatch = DAY_PATTERN.exec(dayInput);
    if (!dayMatch) throw new BadRequestError("date must be YYYY-MM-DD or YYYYMMDD");

    const [, year, month, dayOfMonth] = dayMatch;
    const parsedDate = new Date(Number(year), Number(month) - 1, Number(dayOfMonth));
    const isRealDate =
        parsedDate.getFullYear() === Number(year) &&
        parsedDate.getMonth() === Number(month) - 1 &&
        parsedDate.getDate() === Number(dayOfMonth);
    if (!isRealDate) throw new BadRequestError("date is not a valid calendar date");

    return `${year}-${month}-${dayOfMonth}`;
};

// Turns a "YYYY-MM-DD" day into { from, to } covering that whole day ("YYYY-MM-DD HH:mm:ss", `to` exclusive)
export const dayToDateRange = (day) => ({
    from: `${day} 00:00:00`,
    to: `${formatDate(addDays(parseDateTime(`${day} 00:00:00`), 1))} 00:00:00`,
});
```

2. In `src/controllers/topup.controller.js`:
   - Delete the local `DAY_PATTERN` constant and the whole local `parseDay` function (currently
     lines 91–116, from `const DAY_PATTERN = ...` through the closing `};` of `parseDay`).
   - Add `parseDay,` to the import from `"../utils/request.helpers.js"` so it reads:

```js
import {
    BadRequestError,
    normalizePhone,
    parseDateRange,
    parseDay,
    parsePagination,
    parseStatus,
    sendErrorResponse,
} from "../utils/request.helpers.js";
```

   Do not change anything else in the top-up controller; `getDailyByPhone` and `getLogsByDay` keep
   calling `parseDay(req.query.date)`.

**Verify:**
```bash
cd d:/tplus-project/topup-project
node -e "import('./src/utils/request.helpers.js').then(h => { console.log(h.parseDay('20261110'), h.parseDay('2026-11-10'), JSON.stringify(h.dayToDateRange('2026-11-30'))); try { h.parseDay('20261340') } catch (e) { console.log(e.message) } })"
(PORT=5099 node index.js > /dev/null 2>&1 &) ; for i in $(seq 1 30); do curl -s localhost:5099/health/db >/dev/null && break; sleep 1; done
curl -s "localhost:5099/api/topup/historyByPhone?phone=2076327321&date=20261110" | head -c 150; echo
curl -s "localhost:5099/api/topup/logs?date=20261340"; echo
powershell -c "Get-NetTCPConnection -LocalPort 5099 -State Listen | % { Stop-Process -Id \$_.OwningProcess -Force }"
```
Expected:
- `2026-11-10 2026-11-10 {"from":"2026-11-30 00:00:00","to":"2026-12-01 00:00:00"}` then `date is not a valid calendar date`
- `/historyByPhone` returns `{"success":true,"phone":"2076327321","date":"2026-11-10",...` with `"total":2`
- `/logs?date=20261340` returns `{"success":false,"message":"date is not a valid calendar date"}`

**Done when:** `parseDay` exists only in `request.helpers.js` and both top-up day endpoints behave as before.

---

### Task 2: Service `getPackageRegistrations`

**Files:**
- Create: `src/services/package.service.js`

**Steps:**

1. Create `src/services/package.service.js` with exactly this content:

```js
import { getDb22, sql } from "../config/db.js";

/**
 * Package registration history from SPNV (server 22).
 *
 * Successful registrations live in DREGISTER_PKG, failed attempts in
 * DREGISTER_PKG_not_successful (same columns). Status = source table.
 * Package price/data/validity come from the Tb_PACKAGE catalog, matched by name
 * (PACKAGE_CODE is not unique there). OUTER APPLY TOP 1 keeps one catalog row per
 * registration even if the catalog gets duplicate active names.
 *
 * Measured: one phone, 31 days ≈ 0.4 s; one full day (≈268k rows) ≈ 3 s.
 */

const REGISTRATION_COLUMNS = `
    ID, CHANEL, MSISDN, COUNTERCODE, COUNTERNAME, START_TIME, EXPIRY_TIME,
    ODER_REF, RESULT_CODE, RESULT_DESC, CDATE`;

const REGISTRATION_FILTERS = `
    CDATE >= @from AND CDATE < @to
    AND (@phone       IS NULL OR MSISDN      = @phone)
    AND (@channel     IS NULL OR CHANEL      = @channel)
    AND (@packageCode IS NULL OR COUNTERCODE = @packageCode)`;

// Failed rows store "0" when there is no value
const NO_VALUE = "0";
const valueOrNull = (columnValue) => (columnValue === NO_VALUE || columnValue == null ? null : columnValue);

// Turns query rows (with a `totalRows` column) into { data, pagination }
const buildPageResult = (registrationRows, pageNumber, pageSize) => {
    const totalRows = registrationRows.length ? registrationRows[0].totalRows : 0;
    return {
        data: registrationRows.map((registrationRow) => ({
            id: registrationRow.id,
            phone: registrationRow.phone,
            status: registrationRow.status,
            channel: registrationRow.channel,
            packageCode: registrationRow.packageCode,
            packageName: registrationRow.packageName,
            price: registrationRow.price,
            dataMb: registrationRow.dataMb == null ? null : registrationRow.dataMb.trim(),
            validity: registrationRow.validity,
            validityUnit: registrationRow.validityUnit,
            startTime: valueOrNull(registrationRow.startTime),
            expiryTime: valueOrNull(registrationRow.expiryTime),
            orderRef: valueOrNull(registrationRow.orderRef),
            resultCode: registrationRow.resultCode,
            resultDesc: registrationRow.resultDesc,
            createdAt: registrationRow.createdAt,
        })),
        pagination: {
            page: pageNumber,
            limit: pageSize,
            total: totalRows,
            totalPages: Math.ceil(totalRows / pageSize),
        },
    };
};

/**
 * @param from, to      "YYYY-MM-DD HH:mm:ss" (`to` exclusive)
 * @param phone         normalized phone or null
 * @param channel       exact CHANEL value or null
 * @param packageCode   exact COUNTERCODE value or null
 * @param status        "success" | "failed" | null (both)
 */
export const getPackageRegistrations = async ({ from, to, phone, channel, packageCode, status, page, limit }) => {
    const db22Pool = await getDb22();

    const registrationQuery = `
        SELECT
            registration.ID                 AS id,
            registration.MSISDN             AS phone,
            registration.status             AS status,
            registration.CHANEL             AS channel,
            registration.COUNTERCODE        AS packageCode,
            registration.COUNTERNAME        AS packageName,
            packageInfo.Price               AS price,
            packageInfo.Amount_mb           AS dataMb,
            packageInfo.Validity            AS validity,
            packageInfo.Unit                AS validityUnit,
            registration.START_TIME         AS startTime,
            registration.EXPIRY_TIME        AS expiryTime,
            registration.ODER_REF           AS orderRef,
            registration.RESULT_CODE        AS resultCode,
            registration.RESULT_DESC        AS resultDesc,
            CONVERT(varchar(23), registration.CDATE, 121) AS createdAt,
            COUNT(*) OVER ()                AS totalRows
        FROM (
            SELECT 'success' AS status, ${REGISTRATION_COLUMNS}
            FROM dbo.DREGISTER_PKG WITH (NOLOCK)
            WHERE ${REGISTRATION_FILTERS}
              AND (@status IS NULL OR @status = 'success')
            UNION ALL
            SELECT 'failed' AS status, ${REGISTRATION_COLUMNS}
            FROM dbo.DREGISTER_PKG_not_successful WITH (NOLOCK)
            WHERE ${REGISTRATION_FILTERS}
              AND (@status IS NULL OR @status = 'failed')
        ) registration
        OUTER APPLY (
            SELECT TOP 1 packageCatalog.Price, packageCatalog.Amount_mb, packageCatalog.Validity, packageCatalog.Unit
            FROM dbo.Tb_PACKAGE packageCatalog WITH (NOLOCK)
            WHERE packageCatalog.PACKAGE_NAME = registration.COUNTERNAME
              AND packageCatalog.FLAG = 1
            ORDER BY packageCatalog.PACKAGE_ROW_ID DESC
        ) packageInfo
        ORDER BY registration.CDATE DESC, registration.status DESC, registration.ID DESC
        OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY;`;

    const queryResult = await db22Pool
        .request()
        // Dates passed as text so SQL Server reads them in its own local time (same as CDATE)
        .input("from", sql.VarChar(19), from)
        .input("to", sql.VarChar(19), to)
        .input("phone", sql.VarChar(20), phone || null)
        .input("channel", sql.VarChar(25), channel || null)
        .input("packageCode", sql.VarChar(15), packageCode || null)
        .input("status", sql.VarChar(10), status || null)
        .input("offset", sql.Int, (page - 1) * limit)
        .input("limit", sql.Int, limit)
        .query(registrationQuery);

    return buildPageResult(queryResult.recordset, page, limit);
};
```

**Verify:**
```bash
cd d:/tplus-project/topup-project
node -e "
import('./src/services/package.service.js').then(async ({ getPackageRegistrations }) => {
  const day = { from: '2026-11-10 00:00:00', to: '2026-11-11 00:00:00', page: 1, limit: 20 };
  const cases = [
    ['day both', day],
    ['day success', { ...day, status: 'success' }],
    ['day failed', { ...day, status: 'failed' }],
    ['day USSD', { ...day, channel: 'USSD' }],
    ['phone 31d', { from: '2026-10-12 00:00:00', to: '2026-11-12 00:00:00', phone: '2076003655', page: 1, limit: 100 }],
  ];
  for (const [label, params] of cases) {
    const startedAt = Date.now();
    const result = await getPackageRegistrations(params);
    console.log(label, result.pagination.total, 'rows', Date.now() - startedAt, 'ms');
    if (label === 'phone 31d') {
      console.log(JSON.stringify(result.data[0]));
      console.log(JSON.stringify(result.data.find((row) => row.status === 'failed')));
    }
  }
  process.exit(0);
});" 2>&1 | grep -v injected
```
Expected:
- `day both 268216`, `day success 221408`, `day failed 46808`, `day USSD 254800`, each under ~6000 ms
- `phone 31d` total ≈ 40–45, under ~1500 ms
- First phone row has `status:"success"`, numeric `price`, `dataMb` without trailing spaces
  (e.g. `"4876"`), `startTime` like `"2026-11-..T..+07:00"`
- The failed row has `startTime:null, expiryTime:null, orderRef:null`, `resultCode:"400"`

**Done when:** all five cases return the expected totals and field shapes.

---

### Task 3: Controller `package.controller.js`

**Files:**
- Create: `src/controllers/package.controller.js`

**Steps:**

1. Create `src/controllers/package.controller.js` with exactly this content:

```js
import { getPackageRegistrations } from "../services/package.service.js";
import {
    BadRequestError,
    dayToDateRange,
    normalizePhone,
    parseDateRange,
    parseDay,
    parsePagination,
    parseStatus,
    sendErrorResponse,
} from "../utils/request.helpers.js";

// DREGISTER_PKG is continuous only from this day; older months are in backup tables.
// Override with REGISTER_HISTORY_MIN_DATE in .env when the DBA archives more months.
const DEFAULT_MIN_HISTORY_DATE = "2026-09-01";
const MIN_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MAX_RANGE_DAYS = 31;
const DEFAULT_RANGE_DAYS = 30;
const MAX_CHANNEL_LENGTH = 25;
const PACKAGE_CODE_PATTERN = /^\d{1,15}$/;
const FAILURE_MESSAGE = "Failed to get package registration history";

// Read at request time so a changed .env takes effect after restart without code changes
const getMinHistoryDate = () => {
    const configuredDate = process.env.REGISTER_HISTORY_MIN_DATE;
    return MIN_DATE_PATTERN.test(configuredDate || "") ? configuredDate : DEFAULT_MIN_HISTORY_DATE;
};

const historyNotAvailableMessage = (minHistoryDate) => `History before ${minHistoryDate} is not available`;

const parseChannel = (channelInput) => {
    if (!channelInput) return null;
    if (channelInput.length > MAX_CHANNEL_LENGTH) {
        throw new BadRequestError(`channel must be at most ${MAX_CHANNEL_LENGTH} characters`);
    }
    return channelInput;
};

const parsePackageCode = (packageCodeInput) => {
    if (!packageCodeInput) return null;
    if (!PACKAGE_CODE_PATTERN.test(packageCodeInput)) {
        throw new BadRequestError("packageCode must be digits, e.g. 117");
    }
    return packageCodeInput;
};

/**
 * GET /api/package/registerHistory?date=20261110&channel=USSD&packageCode=117&status=success&page=1&limit=20
 * All package registrations (successful and failed) for one day, newest first.
 * Query params:
 *   date         - "YYYY-MM-DD" or "YYYYMMDD" (default: today), not before REGISTER_HISTORY_MIN_DATE
 *   channel      - exact channel, e.g. USSD, TPLUSAPP
 *   packageCode  - e.g. 117
 *   status       - success | failed (default: both)
 *   page, limit  (default 1, 20; max limit 100)
 */
export const getRegisterHistory = async (req, res) => {
    try {
        const queryParams = req.query;
        const day = parseDay(queryParams.date);
        const minHistoryDate = getMinHistoryDate();
        if (day < minHistoryDate) {
            throw new BadRequestError(historyNotAvailableMessage(minHistoryDate));
        }

        const channel = parseChannel(queryParams.channel);
        const packageCode = parsePackageCode(queryParams.packageCode);
        const status = parseStatus(queryParams.status);

        const registrationPage = await getPackageRegistrations({
            ...dayToDateRange(day),
            phone: null,
            channel,
            packageCode,
            status,
            ...parsePagination(queryParams),
        });

        res.json({ success: true, date: day, channel, packageCode, status, ...registrationPage });
    } catch (error) {
        sendErrorResponse(res, "GET /api/package/registerHistory", error, FAILURE_MESSAGE);
    }
};

/**
 * GET /api/package/registerHistory/:phone?from=2026-11-01&to=2026-11-12
 * Package registrations (successful and failed) for one phone number, newest first.
 * Query params:
 *   from, to     - "YYYY-MM-DD" or "YYYY-MM-DD HH:mm:ss" (default: last 30 days, max 31 days).
 *                  A range starting before REGISTER_HISTORY_MIN_DATE is clamped and a `notice` is returned.
 *   channel, packageCode, status, page, limit - same as the day endpoint
 */
export const getRegisterHistoryByPhone = async (req, res) => {
    try {
        const phone = normalizePhone(req.params.phone);
        if (!phone) {
            throw new BadRequestError("Invalid phone number.");
        }

        const queryParams = req.query;
        const requestedRange = parseDateRange(queryParams, {
            defaultDays: DEFAULT_RANGE_DAYS,
            maxRangeDays: MAX_RANGE_DAYS,
        });

        // "YYYY-MM-DD HH:mm:ss" strings compare correctly as text
        const minHistoryDate = getMinHistoryDate();
        const minHistoryDateTime = `${minHistoryDate} 00:00:00`;
        if (requestedRange.to <= minHistoryDateTime) {
            throw new BadRequestError(historyNotAvailableMessage(minHistoryDate));
        }
        const isClamped = requestedRange.from < minHistoryDateTime;
        const dateRange = isClamped ? { ...requestedRange, from: minHistoryDateTime } : requestedRange;

        const registrationPage = await getPackageRegistrations({
            ...dateRange,
            phone,
            channel: parseChannel(queryParams.channel),
            packageCode: parsePackageCode(queryParams.packageCode),
            status: parseStatus(queryParams.status),
            ...parsePagination(queryParams),
        });

        res.json({
            success: true,
            phone,
            filter: dateRange,
            ...(isClamped && { notice: historyNotAvailableMessage(minHistoryDate) }),
            ...registrationPage,
        });
    } catch (error) {
        sendErrorResponse(res, "GET /api/package/registerHistory/:phone", error, FAILURE_MESSAGE);
    }
};
```

**Verify** (calls the controller functions directly with fake `req`/`res`; routes come in Task 4):
```bash
cd d:/tplus-project/topup-project
node -e "
import('./src/controllers/package.controller.js').then(async (controller) => {
  const call = (handler, req) => new Promise((resolve) => {
    const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { resolve({ statusCode: this.statusCode, body }); } };
    handler({ query: {}, params: {}, ...req }, res);
  });
  const show = ({ statusCode, body }) => console.log(statusCode, JSON.stringify({ message: body.message, notice: body.notice, filter: body.filter, date: body.date, total: body.pagination && body.pagination.total }));
  show(await call(controller.getRegisterHistory, { query: { date: '20261110', status: 'failed', limit: '1' } }));
  show(await call(controller.getRegisterHistory, { query: { date: '20260815' } }));
  show(await call(controller.getRegisterHistory, { query: { date: '20261110', packageCode: 'abc' } }));
  show(await call(controller.getRegisterHistoryByPhone, { params: { phone: '02076003655' }, query: { from: '2026-10-12', to: '2026-11-11' } }));
  show(await call(controller.getRegisterHistoryByPhone, { params: { phone: '2076003655' }, query: { from: '2026-08-20', to: '2026-09-10' } }));
  show(await call(controller.getRegisterHistoryByPhone, { params: { phone: '2076003655' }, query: { from: '2026-08-01', to: '2026-08-31' } }));
  show(await call(controller.getRegisterHistoryByPhone, { params: { phone: '123' } }));
  process.exit(0);
});" 2>&1 | grep -v injected
```
Expected, in order:
1. `200 {"date":"2026-11-10","total":46808}`
2. `400 {"message":"History before 2026-09-01 is not available"}`
3. `400 {"message":"packageCode must be digits, e.g. 117"}`
4. `200` with `filter.from "2026-10-12 00:00:00"`, no `notice`, total ≈ 40–45
5. `200` with `"notice":"History before 2026-09-01 is not available"` and `filter.from "2026-09-01 00:00:00"`
6. `400 {"message":"History before 2026-09-01 is not available"}`
7. `400 {"message":"Invalid phone number."}`

(If `.env` already has `REGISTER_HISTORY_MIN_DATE` set to another date, the messages show that date.)

**Done when:** all seven cases match.

---

### Task 4: Route file and mount

**Files:**
- Create: `src/routes/package.routes.js`
- Modify: `index.js`

**Steps:**

1. Create `src/routes/package.routes.js`:

```js
import { Router } from "express";
import { getRegisterHistory, getRegisterHistoryByPhone } from "../controllers/package.controller.js";

const router = Router();

router.get("/registerHistory", getRegisterHistory);
router.get("/registerHistory/:phone", getRegisterHistoryByPhone);

export default router;
```

2. In `index.js`, after the line `import transferRoutes from "./src/routes/transfer.routes.js";` add:

```js
import packageRoutes from "./src/routes/package.routes.js";
```

   and after the line `app.use("/api/transfer", transferRoutes);` add:

```js
app.use("/api/package", packageRoutes);
```

   Keep `index.js`'s existing 2-space indentation; change nothing else.

**Verify:**
```bash
cd d:/tplus-project/topup-project
(PORT=5099 node index.js > /dev/null 2>&1 &) ; for i in $(seq 1 30); do curl -s localhost:5099/health/db >/dev/null && break; sleep 1; done
show(){ startedAt=$(date +%s%3N); curl -s "localhost:5099/api/package/$1" | node -e "let text='';process.stdin.on('data',chunk=>text+=chunk).on('end',()=>{const body=JSON.parse(text);console.log(JSON.stringify({success:body.success,message:body.message,notice:body.notice,date:body.date,filter:body.filter,pagination:body.pagination,firstRow:body.data&&body.data[0]}))})"; echo "  -> $(( $(date +%s%3N)-startedAt )) ms"; }
show "registerHistory?date=20261110"
show "registerHistory?date=2026-11-10&page=2&limit=5"
show "registerHistory?date=20261110&channel=USSD&limit=1"
show "registerHistory?date=20261110&packageCode=117&status=success&limit=1"
show "registerHistory?date=20261110&status=bad"
show "registerHistory/2076003655?from=2026-10-12&to=2026-11-11"
show "registerHistory/+856%2020%207600%203655?status=failed"
show "registerHistory/2076003655?from=2026-08-20&to=2026-09-10"
show "registerHistory/2076003655?from=2026-01-01&to=2026-11-11"
powershell -c "Get-NetTCPConnection -LocalPort 5099 -State Listen | % { Stop-Process -Id \$_.OwningProcess -Force }"
```
Expected:
1. total `268216`, `totalPages 13411`, first row has all 16 fields from the design, < ~6000 ms
2. `page 2, limit 5`, same total
3. total `254800`, first row `channel:"USSD"`
4. first row `packageCode:"117"`, `status:"success"`, `price:10000`
5. `{"success":false,"message":"status must be success or failed"}`
6. `phone:"2076003655"` is echoed at top level (not shown by the script; check one raw response), total ≈ 40–45, < ~1500 ms
7. only failed rows; `startTime:null`
8. `notice:"History before 2026-09-01 is not available"`, `filter.from:"2026-09-01 00:00:00"`
9. `{"success":false,"message":"Date range cannot exceed 31 days"}`

**Done when:** all nine calls match.

---

### Task 5: Regression check and summary

**Files:** none changed.

**Steps:**

1. Re-check the existing endpoints that share the changed helpers:

```bash
cd d:/tplus-project/topup-project
(PORT=5099 node index.js > /dev/null 2>&1 &) ; for i in $(seq 1 30); do curl -s localhost:5099/health/db >/dev/null && break; sleep 1; done
curl -s localhost:5099/health/db; echo
curl -s "localhost:5099/api/topup/historyByPhone?phone=2076327321&date=20261110" | head -c 120; echo
curl -s "localhost:5099/api/topup/logs?date=20261110&limit=1" | head -c 120; echo
curl -s "localhost:5099/api/topup/history/2077861223?limit=1" | head -c 120; echo
curl -s "localhost:5099/api/transfer/historyTransfer/2077292853?limit=1" | head -c 120; echo
powershell -c "Get-NetTCPConnection -LocalPort 5099 -State Listen | % { Stop-Process -Id \$_.OwningProcess -Force }"
```

2. Report to the user: endpoints with example URLs, measured times, files changed, and the reminder
   to add `REGISTER_HISTORY_MIN_DATE=2026-09-01` to `.env` (optional; code defaults to it).

**Verify:** Expected: health shows both DBs ok; `/historyByPhone` `"total":2`; `/logs` success;
`/history/2077861223` success; `/historyTransfer/2077292853` success.

**Done when:** all existing endpoints respond with `"success":true` as before.
