import { getDb135, sql } from "../config/db.js";

/**
 * Money (balance) transfer history from MTOPUP (server 135), table tb_tansfer_bl_USSD_logs.
 *
 * Each row is one transfer attempt from `msisdn` (sender) to `receiver`.
 * `step` is where the attempt ended:
 *   "tansfer" + resultCode "200"  -> transfer succeeded
 *   any other step / code         -> failed at that step
 *     (check password, check balance, check reciver, check sim active, check customer info, tansfer)
 * The table is small (thousands of rows), so long date ranges are fine.
 */

const SUCCESS_CONDITION = `(transferLog.step = 'tansfer' AND transferLog.resultCode = '200')`;

const TRANSFER_COLUMNS = `
    transferLog.id                  AS id,
    transferLog.msisdn              AS sender,
    transferLog.receiver            AS receiver,
    transferLog.amount              AS amount,
    CASE WHEN ${SUCCESS_CONDITION} THEN 'success' ELSE 'failed' END AS status,
    transferLog.step                AS step,
    transferLog.resultCode          AS resultCode,
    transferLog.resulstDesc         AS resultDesc,
    transferLog.ip_address          AS ipAddress,
    CONVERT(varchar(23), transferLog.cDate, 121) AS createdAt`;

// Turns query rows (with a `totalRows` column) into { data, pagination }
const buildPageResult = (transferRows, pageNumber, pageSize) => {
    const totalRows = transferRows.length ? transferRows[0].totalRows : 0;
    transferRows.forEach((transferRow) => delete transferRow.totalRows);
    return {
        data: transferRows,
        pagination: {
            page: pageNumber,
            limit: pageSize,
            total: totalRows,
            totalPages: Math.ceil(totalRows / pageSize),
        },
    };
};

/**
 * @param direction  "sent" (phone is sender), "received" (phone is receiver) or "all" (either side).
 *                   Only used when `phone` is given.
 */
export const getTransferHistory = async ({ from, to, phone, direction, sender, receiver, status, page, limit }) => {
    const db135Pool = await getDb135();

    const historyQuery = `
        SELECT ${TRANSFER_COLUMNS},
            CASE WHEN @phone IS NULL THEN NULL
                 WHEN transferLog.msisdn = @phone AND transferLog.receiver = @phone THEN 'self'
                 WHEN transferLog.msisdn = @phone THEN 'sent'
                 ELSE 'received' END AS direction,
            COUNT(*) OVER () AS totalRows
        FROM dbo.tb_tansfer_bl_USSD_logs transferLog WITH (NOLOCK)
        WHERE transferLog.cDate >= @from AND transferLog.cDate < @to
          AND (@phone IS NULL
               OR (@direction IN ('sent', 'all')     AND transferLog.msisdn   = @phone)
               OR (@direction IN ('received', 'all') AND transferLog.receiver = @phone))
          AND (@sender   IS NULL OR transferLog.msisdn   = @sender)
          AND (@receiver IS NULL OR transferLog.receiver = @receiver)
          AND (@status IS NULL
               OR (@status = 'success' AND ${SUCCESS_CONDITION})
               OR (@status = 'failed'  AND NOT ${SUCCESS_CONDITION}))
        ORDER BY transferLog.id DESC
        OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY;`;

    const queryResult = await db135Pool
        .request()
        // Dates passed as text so SQL Server reads them in its own local time (same as cDate)
        .input("from", sql.VarChar(19), from)
        .input("to", sql.VarChar(19), to)
        .input("phone", sql.VarChar(15), phone || null)
        .input("direction", sql.VarChar(10), direction || "all")
        .input("sender", sql.VarChar(15), sender || null)
        .input("receiver", sql.VarChar(15), receiver || null)
        .input("status", sql.VarChar(10), status || null)
        .input("offset", sql.Int, (page - 1) * limit)
        .input("limit", sql.Int, limit)
        .query(historyQuery);

    const transferRows = queryResult.recordset;
    // `direction` only makes sense when searching by one phone number
    if (!phone) transferRows.forEach((transferRow) => delete transferRow.direction);

    return buildPageResult(transferRows, page, limit);
};

/**
 * Totals for one phone number in the range: how much was sent and received successfully.
 */
export const getTransferSummaryByPhone = async ({ from, to, phone }) => {
    const db135Pool = await getDb135();

    const summaryQuery = `
        SELECT
            COUNT(CASE WHEN transferLog.msisdn = @phone AND ${SUCCESS_CONDITION} THEN 1 END)                    AS sentCount,
            ISNULL(SUM(CASE WHEN transferLog.msisdn = @phone AND ${SUCCESS_CONDITION} THEN transferLog.amount END), 0) AS sentAmount,
            COUNT(CASE WHEN transferLog.receiver = @phone AND ${SUCCESS_CONDITION} THEN 1 END)                  AS receivedCount,
            ISNULL(SUM(CASE WHEN transferLog.receiver = @phone AND ${SUCCESS_CONDITION} THEN transferLog.amount END), 0) AS receivedAmount,
            COUNT(CASE WHEN NOT ${SUCCESS_CONDITION} THEN 1 END)                                                AS failedCount
        FROM dbo.tb_tansfer_bl_USSD_logs transferLog WITH (NOLOCK)
        WHERE transferLog.cDate >= @from AND transferLog.cDate < @to
          AND (transferLog.msisdn = @phone OR transferLog.receiver = @phone);`;

    const queryResult = await db135Pool
        .request()
        .input("from", sql.VarChar(19), from)
        .input("to", sql.VarChar(19), to)
        .input("phone", sql.VarChar(15), phone)
        .query(summaryQuery);

    return queryResult.recordset[0];
};
