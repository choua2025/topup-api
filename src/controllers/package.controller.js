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

// .env is loaded once at startup: change REGISTER_HISTORY_MIN_DATE and restart (no code change needed)
const getMinHistoryDate = () => {
    const configuredDate = process.env.REGISTER_HISTORY_MIN_DATE;
    if (!MIN_DATE_PATTERN.test(configuredDate || "")) return DEFAULT_MIN_HISTORY_DATE;
    try {
        return parseDay(configuredDate); // rejects impossible dates like 2026-13-45
    } catch {
        return DEFAULT_MIN_HISTORY_DATE;
    }
};

const historyNotAvailableMessage = (minHistoryDate) => `History before ${minHistoryDate} is not available`;

const parseChannel = (channelInput) => {
    if (!channelInput) return null;
    if (typeof channelInput !== "string") throw new BadRequestError("channel must be a single value");
    if (channelInput.length > MAX_CHANNEL_LENGTH) {
        throw new BadRequestError(`channel must be at most ${MAX_CHANNEL_LENGTH} characters`);
    }
    return channelInput;
};

const parsePackageCode = (packageCodeInput) => {
    if (!packageCodeInput) return null;
    if (typeof packageCodeInput !== "string") throw new BadRequestError("packageCode must be a single value");
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
