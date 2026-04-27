import { Router, type IRouter } from "express";
import healthRouter from "./health";
import authRouter from "./auth";
import profileRouter from "./profile";
import catalogRouter from "./catalog";
import libraryRouter from "./library";
import launchesRouter from "./launches";
import adminRouter from "./admin";
import dashboardRouter from "./dashboard";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
router.use(profileRouter);
router.use(catalogRouter);
router.use(libraryRouter);
router.use(launchesRouter);
router.use(adminRouter);
router.use(dashboardRouter);

export default router;
