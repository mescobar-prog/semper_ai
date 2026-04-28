import { Router, type IRouter } from "express";
import healthRouter from "./health";
import authRouter from "./auth";
import profileRouter from "./profile";
import presetsRouter from "./presets";
import catalogRouter from "./catalog";
import libraryRouter from "./library";
import launchesRouter from "./launches";
import adminRouter from "./admin";
import submissionsRouter from "./submissions";
import dashboardRouter from "./dashboard";
import storageRouter from "./storage";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
router.use(profileRouter);
router.use(presetsRouter);
router.use(catalogRouter);
router.use(libraryRouter);
router.use(launchesRouter);
router.use(adminRouter);
router.use(submissionsRouter);
router.use(dashboardRouter);
router.use(storageRouter);

export default router;
