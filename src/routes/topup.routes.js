import { Router } from "express";
import { getDailyByPhone, getHistory, getHistoryByPhone, getLogsByDay } from "../controllers/topup.controller.js";

const router = Router();

router.get("/history", getHistory);
router.get("/history/:phone", getHistoryByPhone);
router.get("/historyByPhone", getDailyByPhone);
router.get("/logs", getLogsByDay);

export default router;
