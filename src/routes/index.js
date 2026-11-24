import { Router } from "express";
import packageRoutes from "./package.routes.js";
import pinpukRoutes from "./pinpuk.routes.js";
import topupRoutes from "./topup.routes.js";
import transferRoutes from "./transfer.routes.js";

// All API routes, mounted under /api in index.js
const router = Router();

router.use("/package", packageRoutes);
router.use("/pinpuk", pinpukRoutes);
router.use("/topup", topupRoutes);
router.use("/transfer", transferRoutes);

export default router;
 