import { getTransferHistory, getTransferSummaryByPhone } from "../services/transfer.service.js";
import {
    BadRequestError,
    normalizePhone,
    parseDateRange,
    parseOptionalPhone,
    parsePagination,
    parseStatus,
    sendErrorResponse,
} from "../utils/request.helpers.js";

// The transfer log table is small, so a year-long range is still fast
const MAX_RANGE_DAYS = 366;
const DEFAULT_RANGE_DAYS = 30;
const VALID_DIRECTIONS = ["all", "sent", "received"];
const FAILURE_MESSAGE = "Failed to get money transfer history";

/**
 * GET /api/transfer/history
 * Query params:
 *   from, to   - "YYYY-MM-DD" or "YYYY-MM-DD HH:mm:ss" (default: last 30 days, max 366 days)
 *   sender     - phone number that sent the money
 *   receiver   - phone number that received the money
 *   status     - success | failed
 *   page, limit (default 1, 20; max limit 100)
 */
export const getHistoryTransfer = async (req, res) => {
    try {
        const queryParams = req.query;
        const dateRange = parseDateRange(queryParams, {
            defaultDays: DEFAULT_RANGE_DAYS,
            maxRangeDays: MAX_RANGE_DAYS,
        });

        const historyPage = await getTransferHistory({
            ...dateRange,
            sender: parseOptionalPhone(queryParams.sender, "sender"),
            receiver: parseOptionalPhone(queryParams.receiver, "receiver"),
            status: parseStatus(queryParams.status),
            ...parsePagination(queryParams),
        });

        res.json({ success: true, filter: dateRange, ...historyPage });
    } catch (error) {
        sendErrorResponse(res, "GET /api/transfer/history", error, FAILURE_MESSAGE);
    }
};

/**
 * GET /api/transfer/history/:phone
 * Money transfers sent and/or received by one phone number, with totals.
 * Query params:
 *   from, to    - same format as above (default: last 30 days, max 366 days)
 *   direction   - all (default) | sent | received
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
        const direction = queryParams.direction || "all";
        if (!VALID_DIRECTIONS.includes(direction)) {
            throw new BadRequestError("direction must be all, sent or received");
        }

        const dateRange = parseDateRange(queryParams, {
            defaultDays: DEFAULT_RANGE_DAYS,
            maxRangeDays: MAX_RANGE_DAYS,
        });

        const [historyPage, summary] = await Promise.all([
            getTransferHistory({
                ...dateRange,
                phone,
                direction,
                status: parseStatus(queryParams.status),
                ...parsePagination(queryParams),
            }),
            getTransferSummaryByPhone({ ...dateRange, phone }),
        ]);

        res.json({ success: true, phone, filter: { ...dateRange, direction }, summary, ...historyPage });
    } catch (error) {
        sendErrorResponse(res, "GET /api/transfer/history/:phone", error, FAILURE_MESSAGE);
    }
};
