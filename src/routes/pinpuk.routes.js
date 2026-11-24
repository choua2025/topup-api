import { Router } from "express";
import { getDailySms, getSimPin } from "../controllers/pinpuk.controller.js";

const router = Router();

router.get("/sim", getSimPin);
router.get("/sms", getDailySms);

export default router;
