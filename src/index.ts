import 'dotenv/config';
import express from 'express';
import { getDb } from "./db"
import { recoverStalledJobs } from './services/queue';
import extractRouter from './routes/extract';
import jobsRouter from './routes/jobs';
import sessionsRouter from './routes/sessions';
import healthRouter from './routes/health';

const app = express();
const PORT = parseInt(process.env.PORT || '3000', 10);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Routes
app.use('/api', extractRouter);
app.use('/api/jobs', jobsRouter);
app.use('/api/sessions', sessionsRouter);
app.use('/api', healthRouter);

// Global error handler
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('[error]', err);
  res.status(500).json({
    error: 'INTERNAL_ERROR',
    message: err.message || 'An unexpected error occurred.',
    retryAfterMs: null,
  });
});

// 404
app.use((_req, res) => {
  res.status(404).json({ error: 'INTERNAL_ERROR', message: 'Route not found.' });
});

export function createApp() {
  return app;
}

if (require.main === module) {
  // Initialize DB and recover stalled jobs before accepting traffic
  getDb();
  recoverStalledJobs();

  app.listen(PORT, () => {
    console.log(`[smde] Server running on port ${PORT}`);
    console.log(`[smde] LLM provider: ${process.env.LLM_PROVIDER || 'anthropic'} / ${process.env.LLM_MODEL || 'claude-haiku-4-5-20251001'}`);
  });
}
