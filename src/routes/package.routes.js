import { Router } from "express";
import { getRegisterHistory, getRegisterHistoryByPhone } from "../controllers/package.controller.js";

const router = Router();

router.get("/registerHistory", getRegisterHistory);
router.get("/registerHistory/:phone", getRegisterHistoryByPhone);

export default router;
