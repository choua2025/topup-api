import {
    getDailyTopupsByReceiver,
    getTopupHistory,
    getTopupHistoryByPhone,
    getTopupLogsByDay,
} from "../services/topup.service.js";
import {
    BadRequestError,
    normalizePhone,
    parseDateRange,
    parsePagination,
    parseStatus,
    sendErrorResponse,
} from "../utils/request.helpers.js";

// Top-up log tables have no indexes, so keep the date range short
const MAX_RANGE_DAYS = 31;
const PHONE_DIGITS_PATTERN = /^\d{8,10}$/;
const FAILURE_MESSAGE = "Failed to get top-up history";

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
        const phone = normalizePhone(req.params.phone);
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
        sendErrorResponse(res, "GET /api/topup/history/:phone", error, FAILURE_MESSAGE);
    }
};

const DAY_PATTERN = /^(\d{4})-?(\d{2})-?(\d{2})$/; // "YYYY-MM-DD" or "YYYYMMDD"

// Returns the day as "YYYY-MM-DD" (default: today). Throws if the format or date is invalid.
const parseDay = (dayInput) => {
    if (!dayInput) {
        const today = new Date();
        return [
            today.getFullYear(),
            String(today.getMonth() + 1).padStart(2, "0"),
            String(today.getDate()).padStart(2, "0"),
        ].join("-");
    }

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
