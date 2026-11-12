import { Router } from "express";
import { getHistoryTransfer, getHistoryByPhone } from "../controllers/transfer.controller.js";

const router = Router();

router.get("/historyTransfer", getHistoryTransfer);
router.get("/historyTransfer/:phone", getHistoryByPhone);

export default router;
