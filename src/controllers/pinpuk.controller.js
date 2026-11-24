import { getDailySmsByMsisdn, getSimPinByPuk2 } from "../services/pinpuk.service.js";
import { BadRequestError, normalizePhone, parseLimit, sendErrorResponse } from "../utils/request.helpers.js";

const PUK2_PATTERN = /^\d{4,20}$/;
// Frontend sends the phone number (2077933417); PUK2 in DB is the 8 digits after "20" (77933417)
const PHONE_AS_PUK2_PATTERN = /^20(\d{8})$/;
const SIM_PIN_DEFAULT_LIMIT = 3;
const DAILY_SMS_DEFAULT_LIMIT = 10;

// "2077933417" -> "77933417"; other values (e.g. "76087895") are used as-is
const toPuk2 = (puk2Input) => {
    const puk2Digits = String(puk2Input || "").trim();
    const phoneMatch = PHONE_AS_PUK2_PATTERN.exec(puk2Digits);
    return phoneMatch ? phoneMatch[1] : puk2Digits;
};

/**
 * GET /api/pinpuk/sim?puk2=2077933417
 * SIM PIN/PUK lookup by PUK2 (VAS.dbo.TBL_SIM_PIN).
 * Query params:
 *   puk2  - phone number "20XXXXXXXX" (leading "20" is removed) or the PUK2 code itself (required)
 *   limit - max rows (default 3, max 100)
 */
export const getSimPin = async (req, res) => {
    try {
        const puk2 = toPuk2(req.query.puk2);
        if (!PUK2_PATTERN.test(puk2)) {
            throw new BadRequestError("puk2 is required and must be digits only");
        }
        const limit = parseLimit(req.query.limit, SIM_PIN_DEFAULT_LIMIT);

        const simPinRows = await getSimPinByPuk2({ puk2, limit });
        res.json({ success: true, puk2, data: simPinRows });
    } catch (error) {
        sendErrorResponse(res, "GET /api/pinpuk/sim", error, "Failed to get SIM PIN/PUK");
    }
};

/**
 * GET /api/pinpuk/sms?msisdn=2077117912
 * Latest daily SMS records for one number, newest first (VAS.dbo.tbl_daily_sms).
 * Query params:
 *   msisdn - phone number (required; 020…, +856…, 8 digits accepted)
 *   limit  - max rows (default 10, max 100)
 */
export const getDailySms = async (req, res) => {
    try {
        const msisdn = normalizePhone(req.query.msisdn);
        if (!msisdn) {
            throw new BadRequestError("msisdn is required and must be a valid phone number");
        }
        const limit = parseLimit(req.query.limit, DAILY_SMS_DEFAULT_LIMIT);

        const dailySmsRows = await getDailySmsByMsisdn({ msisdn, limit });
        res.json({ success: true, msisdn, data: dailySmsRows });
    } catch (error) {
        sendErrorResponse(res, "GET /api/pinpuk/sms", error, "Failed to get daily SMS");
    }
};
