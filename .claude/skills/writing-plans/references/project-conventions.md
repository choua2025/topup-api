# topup-project conventions

Shared by the brainstorming, grill-me, writing-plans and subagent-driven-development skills.
Read this before designing, planning or writing code in this project. If the code has moved on
from what is written here, trust the code and update this file.

## Stack

- Node.js (ES modules, `"type": "module"`), Express 5, `mssql` driver, `dotenv`.
- Start: `npm start` (nodemon `index.js`). Port comes from `PORT` in `.env`.
- No test framework. Verification is done by running the server and calling endpoints (see below).

## Layout: route → controller → service

| Layer | Folder | Job |
|---|---|---|
| Route | `src/routes/*.routes.js` | Map URL to controller function only. Mounted in `index.js` (`/api/topup`, `/api/transfer`). |
| Controller | `src/controllers/*.controller.js` | Read and validate `req.query` / `req.params`, call service, send JSON. |
| Service | `src/services/*.service.js` | SQL only. Returns plain data / `{ data, pagination }`. |
| Shared helpers | `src/utils/request.helpers.js` | `parseDateRange`, `parsePagination`, `parseStatus`, `normalizePhone`, `parseOptionalPhone`, `BadRequestError`, `sendErrorResponse`. Reuse these; don't re-implement them. |
| DB config | `src/config/db.js` | All DB config in this one file. `getDb135()` (MTOPUP), `getDb22()` (SPNV), `sql`. |

### Existing endpoints (as of 2026-11-12 — check `src/routes/` for the current list)

| Endpoint | Controller → service | Source |
|---|---|---|
| `GET /api/topup/history` | `getHistory` → `getTopupHistory` | master + receiver + detail logs, ≤ 31 days |
| `GET /api/topup/history/:phone` | `getHistoryByPhone` → `getTopupHistoryByPhone` | receiver-first lookup, ≤ 31 days |
| `GET /api/topup/historyByPhone?phone=&date=` | `getDailyByPhone` → `getDailyTopupsByReceiver` | `V_TRANSFER_LOG`, one day |
| `GET /api/topup/logs?date=&userId=` | `getLogsByDay` → `getTopupLogsByDay` | `V_TRANSFER_LOG`, one day |
| `GET /api/transfer/historyTransfer` | `getHistoryTransfer` → `getTransferHistory` | `tb_tansfer_bl_USSD_logs`, ≤ 366 days |
| `GET /api/transfer/historyTransfer/:phone` | `getHistoryByPhone` → `getTransferHistory` + `getTransferSummaryByPhone` | same, with totals |
| `GET /health/db` | inline in `index.js` | `@@SERVERNAME` on both servers |

`buildPageResult` (rows with `totalRows` → `{ data, pagination }`) is a local helper inside each
service file, not exported.

New features follow the same three files. Reuse a helper before writing a new one; if two
controllers need the same new helper, put it in `request.helpers.js`.

## Naming

- Variable and function names say what the value is: `queryParams`, `phoneDigits`, `dateRange`,
  `historyPage`, `db135Pool`, `queryResult`. No one-letter names (`q`, `r`, `d`, `n`), including SQL
  table aliases (`masterLog`, `receiverLog`, `detailLog`, `transferLog`).
- Named constants instead of magic numbers (`MAX_RANGE_DAYS`, `DEFAULT_PAGE_SIZE`).
- Response fields are camelCase (`transId`, `balanceBefore`, `createdAt`). Do not rename existing API
  query params or response fields — clients depend on them. Route paths are chosen by the user;
  ask before changing one.

## API response shape

- Success: `{ success: true, ...filters echoed back, data: [...], pagination: { page, limit, total, totalPages } }`
- Error: `{ success: false, message }` — 400 via `BadRequestError`, 500 via `sendErrorResponse`.
- Paging: `page` default 1, `limit` default 20, max 100 (`parsePagination`).
- Dates in: `YYYY-MM-DD`, `YYYYMMDD` or `YYYY-MM-DD HH:mm:ss`. Dates out:
  `CONVERT(varchar(23), CDATE, 121)` → `"2026-11-10 18:33:14.220"` (server local time, no `Z`).
- Phone numbers: always pass through `normalizePhone` (accepts `020…`, `+856…`, `856…`, 8 digits).
  Stored forms are `20XXXXXXXX` (10 digits) and `30XXXXXXX` (9 digits).

## Database (production — read-only)

These are live production servers. Only run `SELECT` queries. Never `INSERT/UPDATE/DELETE`,
create indexes, or change schema — if something needs that (e.g. an index), recommend it to the
user for their DBA instead.

| Server | DB | Contents |
|---|---|---|
| 135 (`getDb135`) | MTOPUP | Partner top-up logs, money-transfer (USSD) logs |
| 22 (`getDb22`) | SPNV | Package registration (`DREGISTER_PKG*`, `Tb_PACKAGE`, …) |

Known MTOPUP tables:

- `TB_TRANSFER_MASTER_LOG` (sender/partner side), `TB_TRANSFER_RECEIVER_LOG` (receiver),
  `TB_TRANSFER_DETAIL_LOG` (result, `RESULT_CODE = '0'` = success). Joined by `TRANS_ID`.
  ~4M rows each, only 2026 data; older years in `*_BackUp_2023/2024/2025`.
- `V_TRANSFER_LOG` view = those three joined. Fast only with a selective filter
  (e.g. `RECEIVER_ISDN = @phone`); unfiltered + sorted ≈ 25 s.
- `tb_tansfer_bl_USSD_logs` — money transfers between subscribers (small, ~8.5k rows).
  Success = `step = 'tansfer' AND resultCode = '200'`.
- `tb_tansfer_bl_USSD_user` — contains password hashes. Never expose it through the API.

### Query rules (learned the hard way)

- The big log tables have **no index on `TRANS_ID`, `CDATE` or phone columns** (only clustered `ID`).
  Every query must be bounded by a date range, and joined tables get the same range.
- Write date filters as ranges (`CDATE >= @dayStart AND CDATE < DATEADD(DAY, 1, @dayStart)`),
  never `CONVERT(varchar, CDATE, 112) = '…'`.
- Pass dates as `sql.VarChar(19)` text so SQL Server reads them in its own local time (same as `CDATE`).
- Always parameterize with `.input(...)`; never build SQL from request values.
- Use `WITH (NOLOCK)` on log tables, `ORDER BY … OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY`
  for paging, `COUNT(*) OVER () AS totalRows` for the total (removing it made one view query
  4 s → 16 s because of a worse plan).
- For "by phone" lookups, find the phone's `TRANS_ID`s in the receiver table first, then fetch only
  those rows from master/detail (~1 s vs ~24 s).
- **Time every new query against the live DB before committing to a design.** Target < 5 s per
  request with the default `requestTimeout` of 30 s.

## Verifying a change

1. Start a throwaway server on a spare port and wait for it:
   ```bash
   (PORT=5099 node index.js > /dev/null 2>&1 &) ; for i in $(seq 1 30); do curl -s localhost:5099/health/db >/dev/null && break; sleep 1; done
   ```
2. Call the endpoint with real values: happy path, paging (`limit=1&page=2`), each filter,
   bad input (expect 400 with a clear message), and time it.
3. Re-check at least one existing endpoint to catch regressions from shared-helper changes.
4. Stop the server (Windows):
   ```bash
   powershell -c "Get-NetTCPConnection -LocalPort 5099 -State Listen | % { Stop-Process -Id \$_.OwningProcess -Force }"
   ```
5. URL-encode spaces in query strings (`%20`), or curl sends a broken request.

## Secrets

`.env` holds DB passwords. Never print it, never commit it, never send it anywhere.
