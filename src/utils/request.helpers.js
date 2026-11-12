// Shared helpers for reading and validating request query params

const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 20;
const MILLISECONDS_PER_DAY = 86400000;
const DATE_ONLY_LENGTH = 10; // "YYYY-MM-DD"
const DATE_HOUR_MINUTE_LENGTH = 16; // "YYYY-MM-DD HH:mm"
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}( \d{2}:\d{2}(:\d{2})?)?$/;
const VALID_STATUSES = ["success", "failed"];

export class BadRequestError extends Error {}

const padTwoDigits = (number) => String(number).padStart(2, "0");

const formatDate = (date) =>
    `${date.getFullYear()}-${padTwoDigits(date.getMonth() + 1)}-${padTwoDigits(date.getDate())}`;

const addDays = (date, days) => {
    const shiftedDate = new Date(date);
    shiftedDate.setDate(shiftedDate.getDate() + days);
    return shiftedDate;
};

// Accepts "YYYY-MM-DD" or "YYYY-MM-DD HH:mm[:ss]" and returns "YYYY-MM-DD HH:mm:ss"
const toFullDateTime = (dateText) => {
    if (dateText.length === DATE_ONLY_LENGTH) return `${dateText} 00:00:00`;
    if (dateText.length === DATE_HOUR_MINUTE_LENGTH) return `${dateText}:00`;
    return dateText;
};

const parseDateTime = (dateTimeText) => new Date(dateTimeText.replace(" ", "T"));

/**
 * Builds a validated { from, to } range ("YYYY-MM-DD HH:mm:ss", `to` exclusive).
 * A date-only `to` includes that whole day. Without from/to, the last `defaultDays` days are used.
 */
export const parseDateRange = (queryParams, { defaultDays, maxRangeDays }) => {
    for (const dateParamName of ["from", "to"]) {
        const dateParamValue = queryParams[dateParamName];
        if (dateParamValue !== undefined && typeof dateParamValue !== "string") {
            throw new BadRequestError(`${dateParamName} must be a single value`);
        }
    }
    const today = new Date();
    const fromInput = queryParams.from || queryParams.to || formatDate(addDays(today, 1 - defaultDays));
    const toInput = queryParams.to || queryParams.from || formatDate(today);

    if (!DATE_PATTERN.test(fromInput) || !DATE_PATTERN.test(toInput)) {
        throw new BadRequestError("from/to must be YYYY-MM-DD or YYYY-MM-DD HH:mm:ss");
    }

    const fromDateTime = toFullDateTime(fromInput);
    const isToDateOnly = toInput.length === DATE_ONLY_LENGTH;
    const toDateTime = isToDateOnly
        ? `${formatDate(addDays(parseDateTime(toInput), 1))} 00:00:00`
        : toFullDateTime(toInput);

    const rangeInDays = (parseDateTime(toDateTime) - parseDateTime(fromDateTime)) / MILLISECONDS_PER_DAY;
    if (!(rangeInDays > 0)) {
        throw new BadRequestError("`to` must be after `from`");
    }
    if (rangeInDays > maxRangeDays) {
        throw new BadRequestError(`Date range cannot exceed ${maxRangeDays} days`);
    }

    return { from: fromDateTime, to: toDateTime };
};

export const parsePagination = (queryParams) => {
    const pageNumber = Math.max(parseInt(queryParams.page) || 1, 1);
    const pageSize = Math.min(Math.max(parseInt(queryParams.limit) || DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
    return { page: pageNumber, limit: pageSize };
};

const DAY_PATTERN = /^(\d{4})-?(\d{2})-?(\d{2})$/; // "YYYY-MM-DD" or "YYYYMMDD"

// Returns the day as "YYYY-MM-DD" (default: today). Throws if the format or date is invalid.
export const parseDay = (dayInput) => {
    if (!dayInput) return formatDate(new Date());

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

// Turns a "YYYY-MM-DD" day into { from, to } covering that whole day ("YYYY-MM-DD HH:mm:ss", `to` exclusive)
export const dayToDateRange = (day) => ({
    from: `${day} 00:00:00`,
    to: `${formatDate(addDays(parseDateTime(`${day} 00:00:00`), 1))} 00:00:00`,
});

export const parseStatus = (statusInput) => {
    if (statusInput && !VALID_STATUSES.includes(statusInput)) {
        throw new BadRequestError("status must be success or failed");
    }
    return statusInput || null;
};

/**
 * Converts a Lao phone number to the stored format:
 *   20XXXXXXXX (mobile, 10 digits) or 30XXXXXXX (9 digits).
 * Accepts e.g. "2077861223", "02077861223", "+856 20 7786 1223", "8562077861223", "77861223".
 * Returns null when the number is not valid.
 */
export const normalizePhone = (phoneInput) => {
    let phoneDigits = String(phoneInput || "").replace(/\D/g, "");
    if (phoneDigits.startsWith("856")) phoneDigits = phoneDigits.slice(3); // country code
    if (phoneDigits.startsWith("0")) phoneDigits = phoneDigits.slice(1); // leading 0
    if (/^[2-9]\d{7}$/.test(phoneDigits)) phoneDigits = `20${phoneDigits}`; // 8-digit mobile number without "20"
    return /^(20\d{8}|30\d{7})$/.test(phoneDigits) ? phoneDigits : null;
};

// Normalizes an optional phone query param; throws if it was given but is invalid
export const parseOptionalPhone = (phoneInput, paramName) => {
    if (!phoneInput) return null;
    const phone = normalizePhone(phoneInput);
    if (!phone) throw new BadRequestError(`${paramName} is not a valid phone number`);
    return phone;
};

export const sendErrorResponse = (res, endpointName, error, failureMessage) => {
    if (error instanceof BadRequestError) {
        return res.status(400).json({ success: false, message: error.message });
    }
    console.error(`${endpointName} failed:`, error);
    res.status(500).json({ success: false, message: failureMessage });
};
