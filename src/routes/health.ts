import { Router, Request, Response } from 'express';
import { checkDbHealth } from "../db"
import { checkLLMHealth } from '../services/llmProvider';
import { queue } from "../services/queue"

const router = Router();
const startTime = Date.now();

router.get('/health', async (_req: Request, res: Response): Promise<void> => {
  const dbOk = checkDbHealth();
  let llmOk = true;

  // Only probe LLM in non-test envs to avoid latency on every health check
  if (process.env.NODE_ENV !== 'test') {
    llmOk = await checkLLMHealth().catch(() => false);
  }

  const queueOk = queue.isHealthy;

  const allOk = dbOk && queueOk; // LLM degraded is WARN not DOWN

  res.status(allOk ? 200 : 503).json({
    status: allOk ? 'OK' : 'DEGRADED',
    version: '1.0.0',
    uptime: Math.floor((Date.now() - startTime) / 1000),
    dependencies: {
      database: dbOk ? 'OK' : 'ERROR',
      llmProvider: llmOk ? 'OK' : 'ERROR',
      queue: queueOk ? 'OK' : 'ERROR',
    },
    timestamp: new Date().toISOString(),
  });
});

export default router;
