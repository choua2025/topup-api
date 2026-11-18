import { Router } from "express";
import { getDailyByPhone, getHistory, getHistoryByPhone, getLogsByDay, getRefillCardHistory } from "../controllers/topup.controller.js";

const router = Router();

router.get("/history", getHistory);
router.get("/historyByPhone/", getHistoryByPhone);
router.get("/daily", getDailyByPhone);
router.get("/logs", getLogsByDay);
router.get("/refillcard", getRefillCardHistory);

export default router;
