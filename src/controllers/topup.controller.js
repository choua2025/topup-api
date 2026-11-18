import {
    getDailyTopupsByReceiver,
    getRefillCardHistory as getRefillCardHistoryPage,
    getTopupHistory,
    getTopupHistoryByPhone,
    getTopupLogsByDay,
} from "../services/topup.service.js";
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

// Top-up log tables have no indexes, so keep the date range short
const MAX_RANGE_DAYS = 31;
const PHONE_DIGITS_PATTERN = /^\d{8,10}$/;
const FAILURE_MESSAGE = "Failed to get top-up history";

// Refill card log (MBAPP.dbo.Tb_Refillcard on server 100)
const REFILL_CARD_FAILURE_MESSAGE = "Failed to get refill card history";
const REFILL_CARD_DEFAULT_DAYS = 1;
const REFILL_CARD_PHONE_DEFAULT_DAYS = 30;
const REFILL_CARD_PHONE_MAX_RANGE_DAYS = 366;

/**
 * GET /api/topup/history
 * Query params:
 *   from, to   - "YYYY-MM-DD" or "YYYY-MM-DD HH:mm:ss" (default: today). `to` date-only = end of that day.
 *   receiver   - receiving phone number, e.g. 2077861223
 *   masterSim  - sender master SIM
 *   userId     - partner/user id, e.g. LDB, SOKXAY
 *   transId    - exact transaction id
 *   status     - success | failed
 *   page, limit (default 1, 20; max limit 100)
 */
export const getHistory = async (req, res) => {
    try {
        const queryParams = req.query;
        const dateRange = parseDateRange(queryParams, { defaultDays: 1, maxRangeDays: MAX_RANGE_DAYS });

        for (const phoneParamName of ["receiver", "masterSim"]) {
            const phoneValue = queryParams[phoneParamName];
            if (phoneValue && !PHONE_DIGITS_PATTERN.test(phoneValue)) {
                throw new BadRequestError(`${phoneParamName} must be 8-10 digits`);
            }
        }

        const historyPage = await getTopupHistory({
            ...dateRange,
            receiver: queryParams.receiver || null,
            masterSim: queryParams.masterSim || null,
            userId: queryParams.userId || null,
            transId: queryParams.transId || null,
            status: parseStatus(queryParams.status),
            ...parsePagination(queryParams),
        });

        res.json({ success: true, filter: dateRange, ...historyPage });
    } catch (error) {
        sendErrorResponse(res, "GET /api/topup/history", error, FAILURE_MESSAGE);
    }
};

/**
 * GET /api/topup/history/:phone
 * Top-up history received by one phone number.
 * Query params:
 *   from, to    - same format as above (default: last 30 days)
 *   status      - success | failed
 *   page, limit (default 1, 20; max limit 100)
 */
export const getHistoryByPhone = async (req, res) => {
    try {
        const phone = normalizePhone(req.query.phone);
        if (!phone) {
            throw new BadRequestError("Invalid phone number.");
        }

        const queryParams = req.query;
        const dateRange = parseDateRange(queryParams, { defaultDays: 30, maxRangeDays: MAX_RANGE_DAYS });

        const historyPage = await getTopupHistoryByPhone({
            phone,
            ...dateRange,
            status: parseStatus(queryParams.status),
            ...parsePagination(queryParams),
        });
      

        res.json({ success: true, phone, filter: dateRange, ...historyPage });
    } catch (error) {
        sendErrorResponse(res, "GET /api/topup/historyByPhone/", error, FAILURE_MESSAGE);
    }
};

/**
 * GET /api/topup/daily?phone=2076327321&date=20261110
 * Top-ups received by one phone number on one day (from V_TRANSFER_LOG).
 * Query params:
 *   phone - receiver phone number (required)
 *   date  - "YYYY-MM-DD" or "YYYYMMDD" (default: today)
 *   page, limit (default 1, 20; max limit 100)
 */
export const getDailyByPhone = async (req, res) => {
    try {
        if (!req.query.phone) {
            throw new BadRequestError("phone is required");
        }
        const receiverPhone = normalizePhone(req.query.phone);
        if (!receiverPhone) {
            throw new BadRequestError("Invalid phone number.");
        }

        const day = parseDay(req.query.date);
        const dailyTopupPage = await getDailyTopupsByReceiver({
            receiverPhone,
            day,
            ...parsePagination(req.query),
        });

        res.json({
            success: true,
            phone: receiverPhone,
            date: day,
            ...dailyTopupPage,
        });
    } catch (error) {
        sendErrorResponse(res, "GET /api/topup/daily", error, FAILURE_MESSAGE);
    }
};

/**
 * GET /api/topup/logs?date=20261110&page=1&limit=20
 * All top-up logs for one day (from V_TRANSFER_LOG), newest first.
 * Query params:
 *   date    - "YYYY-MM-DD" or "YYYYMMDD" (default: today)
 *   userId  - optional partner filter, e.g. LDB, SOKXAY
 *   page, limit (default 1, 20; max limit 100)
 */
export const getLogsByDay = async (req, res) => {
    try {
        const day = parseDay(req.query.date);
        const topupLogPage = await getTopupLogsByDay({
            day,
            userId: req.query.userId || null,
            ...parsePagination(req.query),
        });

        res.json({ success: true, date: day, ...topupLogPage });
    } catch (error) {
        sendErrorResponse(res, "GET /api/topup/logs", error, FAILURE_MESSAGE);
    }
};

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
