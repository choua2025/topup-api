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
