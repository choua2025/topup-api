import { getDb125, sql, VAS_DATABASE } from "../config/db.js";

// SIM PIN/PUK and daily SMS data from the VAS database, queried through the linked server on db125

// Looks up SIM PIN/PUK rows by PUK2
export const getSimPinByPuk2 = async ({ puk2, limit }) => {
    const db125Pool = await getDb125();

    const simPinQuery = `
        SELECT TOP (@limit)
            simPin.[IMSI] AS imsi,
            simPin.[PIN1] AS pin1,
            simPin.[PUK1] AS puk1,
            simPin.[PIN2] AS pin2,
            simPin.[PUK2] AS puk2
        FROM ${VAS_DATABASE}.[TBL_SIM_PIN] simPin
        WHERE simPin.[PUK2] = @puk2;`;

    const queryResult = await db125Pool
        .request()
        .input("puk2", sql.VarChar(20), puk2)
        .input("limit", sql.Int, limit)
        .query(simPinQuery);

    return queryResult.recordset;
};

// Latest daily SMS records for one msisdn, newest first
export const getDailySmsByMsisdn = async ({ msisdn, limit }) => {
    const db125Pool = await getDb125();

    const dailySmsQuery = `
        SELECT TOP (@limit)
            dailySms.[adate]              AS adate,
            dailySms.[date]               AS date,
            dailySms.[msisdn]             AS msisdn,
            dailySms.[MainOfferingID]     AS mainOfferingId,
            dailySms.[CallingPartyNumber] AS callingPartyNumber,
            dailySms.[DestinationNumber]  AS destinationNumber,
            dailySms.[CallingType]        AS callingType,
            dailySms.[Balance_Type]       AS balanceType,
            dailySms.[Destination]        AS destination
        FROM ${VAS_DATABASE}.[tbl_daily_sms] dailySms
        WHERE dailySms.[msisdn] = @msisdn
        ORDER BY dailySms.[date] DESC;`;

    const queryResult = await db125Pool
        .request()
        .input("msisdn", sql.VarChar(15), msisdn)
        .input("limit", sql.Int, limit)
        .query(dailySmsQuery);

    return queryResult.recordset;
};
