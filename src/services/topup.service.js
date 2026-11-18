import { getDb100, getDb135, sql } from "../config/db.js";

/**
 * Top-up history from MTOPUP (server 135).
 * Joins master (sender), receiver and detail (result) logs by TRANS_ID.
 *
 * The log tables have no index on TRANS_ID / CDATE / numbers, so every query
 * is bounded by a date range (also applied to the joined tables) to keep it fast.
 */

// Output columns shared by all history queries
const HISTORY_COLUMNS = `
    masterLog.ID                AS id,
    masterLog.TRANS_ID          AS transId,
    masterLog.USER_ID           AS userId,
    masterLog.MASTER_SIM        AS masterSim,
    receiverLog.RECEIVER        AS receiver,
    receiverLog.PAYMENT_TYPE    AS paymentType,
    masterLog.TRANSFER_AMOUNT   AS amount,
    receiverLog.AMOUNT_B        AS receiverBalanceBefore,
    receiverLog.AMOUNT_F        AS receiverBalanceAfter,
    masterLog.AMOUNT_B          AS masterBalanceBefore,
    masterLog.AMOUNT_F          AS masterBalanceAfter,
    detailLog.RESULT_CODE       AS resultCode,
    detailLog.RESULT_DESC       AS resultDesc,
    masterLog.UNDO              AS undo,
    masterLog.API               AS api,
    masterLog.CLIENT_IP         AS clientIp,
    CONVERT(varchar(23), masterLog.CDATE, 121) AS createdAt,
    COUNT(*) OVER ()            AS totalRows`;

const STATUS_FILTER = `
    (@status IS NULL
     OR (@status = 'success' AND detailLog.RESULT_CODE = '0')
     OR (@status = 'failed'  AND (detailLog.RESULT_CODE IS NULL OR detailLog.RESULT_CODE <> '0')))`;

// Turns query rows (with a `totalRows` column) into { data, pagination }
const buildPageResult = (historyRows, pageNumber, pageSize) => {
    const totalRows = historyRows.length ? historyRows[0].totalRows : 0;
    historyRows.forEach((historyRow) => delete historyRow.totalRows);
    return {
        data: historyRows,
        pagination: {
            page: pageNumber,
            limit: pageSize,
            total: totalRows,
            totalPages: Math.ceil(totalRows / pageSize),
        },
    };
};

export const getTopupHistory = async ({ from, to, receiver, masterSim, userId, transId, status, page, limit }) => {
    const db135Pool = await getDb135();

    const historyQuery = `
        SELECT ${HISTORY_COLUMNS}
        FROM dbo.TB_TRANSFER_MASTER_LOG masterLog WITH (NOLOCK)
        LEFT JOIN dbo.TB_TRANSFER_RECEIVER_LOG receiverLog WITH (NOLOCK)
            ON receiverLog.TRANS_ID = masterLog.TRANS_ID
           AND receiverLog.CDATE >= @from AND receiverLog.CDATE < DATEADD(HOUR, 1, @to)
        LEFT JOIN dbo.TB_TRANSFER_DETAIL_LOG detailLog WITH (NOLOCK)
            ON detailLog.TRANS_ID = masterLog.TRANS_ID
           AND detailLog.CDATE >= @from AND detailLog.CDATE < DATEADD(HOUR, 1, @to)
        WHERE masterLog.CDATE >= @from AND masterLog.CDATE < @to
          AND (@receiver  IS NULL OR receiverLog.RECEIVER = @receiver)
          AND (@masterSim IS NULL OR masterLog.MASTER_SIM = @masterSim)
          AND (@userId    IS NULL OR masterLog.USER_ID    = @userId)
          AND (@transId   IS NULL OR masterLog.TRANS_ID   = @transId)
          AND ${STATUS_FILTER}
        ORDER BY masterLog.ID DESC
        OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY;`;

    const queryResult = await db135Pool
        .request()
        // Dates passed as text so SQL Server reads them in its own local time (same as CDATE)
        .input("from", sql.VarChar(19), from)
        .input("to", sql.VarChar(19), to)
        .input("receiver", sql.VarChar(10), receiver)
        .input("masterSim", sql.VarChar(10), masterSim)
        .input("userId", sql.VarChar(10), userId)
        .input("transId", sql.VarChar(76), transId)
        .input("status", sql.VarChar(10), status)
        .input("offset", sql.Int, (page - 1) * limit)
        .input("limit", sql.Int, limit)
        .query(historyQuery);

    return buildPageResult(queryResult.recordset, page, limit);
};

/**
 * Top-up history received by one phone number.
 * Finds the phone's TRANS_IDs in the receiver log first, then fetches only those
 * rows from master/detail. Much faster than joining every top-up in the range
 * (~1s vs ~24s for 30 days).
 */
export const getTopupHistoryByPhone = async ({ phone, from, to, status, page, limit }) => {
    const db135Pool = await getDb135();

    const historyQuery = `
        DECLARE @phoneTransactions TABLE (
            TRANS_ID varchar(76) PRIMARY KEY, RECEIVER varchar(10), PAYMENT_TYPE varchar(25),
            AMOUNT_B bigint, AMOUNT_F bigint
        );

        INSERT INTO @phoneTransactions
        SELECT TRANS_ID, MAX(RECEIVER), MAX(PAYMENT_TYPE), MAX(AMOUNT_B), MAX(AMOUNT_F)
        FROM dbo.TB_TRANSFER_RECEIVER_LOG WITH (NOLOCK)
        WHERE RECEIVER = @phone
          AND CDATE >= DATEADD(HOUR, -1, @from) AND CDATE < DATEADD(HOUR, 1, @to)
        GROUP BY TRANS_ID;

        SELECT ${HISTORY_COLUMNS}
        FROM dbo.TB_TRANSFER_MASTER_LOG masterLog WITH (NOLOCK)
        JOIN @phoneTransactions receiverLog ON receiverLog.TRANS_ID = masterLog.TRANS_ID
        LEFT JOIN dbo.TB_TRANSFER_DETAIL_LOG detailLog WITH (NOLOCK)
            ON detailLog.TRANS_ID = masterLog.TRANS_ID
           AND detailLog.TRANS_ID IN (SELECT TRANS_ID FROM @phoneTransactions)
        WHERE masterLog.CDATE >= @from AND masterLog.CDATE < @to
          AND ${STATUS_FILTER}
        ORDER BY masterLog.ID DESC
        OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY;`;

    const queryResult = await db135Pool
        .request()
        .input("phone", sql.VarChar(10), phone)
        .input("from", sql.VarChar(19), from)
        .input("to", sql.VarChar(19), to)
        .input("status", sql.VarChar(10), status)
        .input("offset", sql.Int, (page - 1) * limit)
        .input("limit", sql.Int, limit)
        .query(historyQuery);

    return buildPageResult(queryResult.recordset, page, limit);
};

/**
 * Top-ups received by one phone number on one day, from the V_TRANSFER_LOG view (paged).
 * Same as:
 *   SELECT ... FROM MTOPUP.dbo.V_TRANSFER_LOG
 *   WHERE convert(varchar(8), CDATE, 112) = '20261110' AND RECEIVER_ISDN = '2076327321'
 * The date filter is written as a range so SQL Server can use it without converting every row.
 *
 * @param receiverPhone  e.g. "2076327321"
 * @param day            "YYYY-MM-DD", e.g. "2026-11-10"
 * @param page           page number, starting at 1
 * @param limit          rows per page (e.g. 20)
 * @returns { data, totalAmount, pagination }  totals cover the whole day, not just this page
 */
export const getDailyTopupsByReceiver = async ({ receiverPhone, day, page, limit }) => {
    const db135Pool = await getDb135();

    const dailyTopupQuery = `
        SELECT
            TRANS_ID            AS transId,
            USER_ID             AS userId,
            TRANSFER_AMOUNT     AS amount,
            RECEIVER_ISDN       AS receiver,
            RECEIVER_SIM_TYPE   AS simType,
            RECEIVER_AMOUNT_B   AS balanceBefore,
            RECEIVER_AMOUNT_F   AS balanceAfter,
            RESULT_DESC         AS resultDesc,
            CONVERT(varchar(23), CDATE, 121) AS createdAt,
            COUNT(*) OVER ()                AS totalRows,
            SUM(TRANSFER_AMOUNT) OVER ()    AS dayTotalAmount
        FROM dbo.V_TRANSFER_LOG WITH (NOLOCK)
        WHERE CDATE >= @dayStart AND CDATE < DATEADD(DAY, 1, @dayStart)
          AND RECEIVER_ISDN = @receiverPhone
        ORDER BY CDATE DESC
        OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY;`;

    const queryResult = await db135Pool
        .request()
        .input("dayStart", sql.VarChar(10), day)
        .input("receiverPhone", sql.VarChar(10), receiverPhone)
        .input("offset", sql.Int, (page - 1) * limit)
        .input("limit", sql.Int, limit)
        .query(dailyTopupQuery);

    const topupRows = queryResult.recordset;
    const totalAmount = topupRows.length ? Number(topupRows[0].dayTotalAmount) : 0;
    topupRows.forEach((topupRow) => delete topupRow.dayTotalAmount);

    return { ...buildPageResult(topupRows, page, limit), totalAmount };
};

/**
 * All top-up logs for one day from the V_TRANSFER_LOG view (paged, newest first).
 * Based on:
 *   SELECT TRANS_ID, USER_ID, TRANSFER_AMOUNT, RECEIVER_ISDN, RECEIVER_SIM_TYPE,
 *          RECEIVER_AMOUNT_B, RECEIVER_AMOUNT_F, RESULT_DESC, CDATE
 *   FROM MTOPUP.dbo.V_TRANSFER_LOG
 *
 * The view has no useful indexes: reading it unfiltered and sorted takes ~25s,
 * so it is always limited to one day (~4s). Keep COUNT(*) OVER () in the query:
 * without it SQL Server picks a much slower plan (~16s).
 *
 * @param day     "YYYY-MM-DD"
 * @param userId  optional partner filter, e.g. "LDB"
 */
export const getTopupLogsByDay = async ({ day, userId, page, limit }) => {
    const db135Pool = await getDb135();

    const topupLogQuery = `
        SELECT
            TRANS_ID            AS transId,
            USER_ID             AS userId,
            TRANSFER_AMOUNT     AS amount,
            RECEIVER_ISDN       AS receiver,
            RECEIVER_SIM_TYPE   AS simType,
            RECEIVER_AMOUNT_B   AS balanceBefore,
            RECEIVER_AMOUNT_F   AS balanceAfter,
            RESULT_DESC         AS resultDesc,
            CONVERT(varchar(23), CDATE, 121) AS createdAt,
            COUNT(*) OVER ()    AS totalRows
        FROM dbo.V_TRANSFER_LOG WITH (NOLOCK)
        WHERE CDATE >= @dayStart AND CDATE < DATEADD(DAY, 1, @dayStart)
          AND (@userId IS NULL OR USER_ID = @userId)
        ORDER BY CDATE DESC
        OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY;`;

    const queryResult = await db135Pool
        .request()
        .input("dayStart", sql.VarChar(10), day)
        .input("userId", sql.VarChar(10), userId || null)
        .input("offset", sql.Int, (page - 1) * limit)
        .input("limit", sql.Int, limit)
        .query(topupLogQuery);

    return buildPageResult(queryResult.recordset, page, limit);
};

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
