import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import {
  getSessionById, getExtractionsBySession, getPendingJobs,
  insertValidation, getLatestValidationWithDate, getExpiringDocuments
} from '../db/index';
import { createLLMProvider } from '../services/llmProvider';
import { runValidation, deriveSessionHealth } from '../services/validation';
import { buildReport } from '../services/report';

const router = Router();

// GET /api/sessions/:sessionId
router.get('/:sessionId', (req: Request, res: Response): void => {
  const sessionId = req.params.sessionId as string;

  const session = getSessionById(sessionId);
  if (!session) {
    res.status(404).json({ error: 'SESSION_NOT_FOUND', message: `Session ${sessionId} not found.` });
    return;
  }

  const extractions = getExtractionsBySession(sessionId);
  const pending = getPendingJobs(sessionId);
  const overallHealth = deriveSessionHealth(extractions);

  const roleCounts: Record<string, number> = {};
  for (const e of extractions) {
    if (e.applicableRole && e.applicableRole !== 'N/A') {
      roleCounts[e.applicableRole] = (roleCounts[e.applicableRole] || 0) + 1;
    }
  }
  const detectedRole = Object.entries(roleCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || null;

  res.json({
    sessionId,
    documentCount: extractions.filter(e => e.status === 'COMPLETE').length,
    detectedRole,
    overallHealth,
    documents: extractions
      .filter(e => e.status === 'COMPLETE')
      .map(e => ({
        id: e.id,
        fileName: e.fileName,
        documentType: e.documentType,
        applicableRole: e.applicableRole,
        holderName: e.holderName,
        confidence: e.confidence,
        isExpired: e.isExpired,
        flagCount: e.flags.length,
        criticalFlagCount: e.flags.filter(f => f.severity === 'CRITICAL').length,
        createdAt: e.createdAt,
      })),
    pendingJobs: pending.map(j => ({
      jobId: j.id,
      status: j.status,
      queuedAt: j.queuedAt,
    })),
  });
});

// POST /api/sessions/:sessionId/validate
router.post('/:sessionId/validate', async (req: Request, res: Response): Promise<void> => {
  const sessionId = req.params.sessionId as string;

  const session = getSessionById(sessionId);
  if (!session) {
    res.status(404).json({ error: 'SESSION_NOT_FOUND', message: `Session ${sessionId} not found.` });
    return;
  }

  const extractions = getExtractionsBySession(sessionId).filter(e => e.status === 'COMPLETE');

  if (extractions.length < 2) {
    res.status(400).json({
      error: 'INSUFFICIENT_DOCUMENTS',
      message: 'Cross-document validation requires at least 2 successfully extracted documents.',
    });
    return;
  }

  try {
    const provider = createLLMProvider();
    const result = await runValidation(provider, sessionId, extractions);

    const validationId = uuidv4();
    insertValidation(validationId, sessionId, result);

    res.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message === 'INSUFFICIENT_DOCUMENTS') {
      res.status(400).json({ error: 'INSUFFICIENT_DOCUMENTS', message: 'At least 2 documents required.' });
    } else {
      res.status(500).json({ error: 'INTERNAL_ERROR', message });
    }
  }
});

// GET /api/sessions/:sessionId/report
router.get('/:sessionId/report', (req: Request, res: Response): void => {
  const sessionId = req.params.sessionId as string;

  const session = getSessionById(sessionId);
  if (!session) {
    res.status(404).json({ error: 'SESSION_NOT_FOUND', message: `Session ${sessionId} not found.` });
    return;
  }

  const extractions = getExtractionsBySession(sessionId);
  const validationRow = getLatestValidationWithDate(sessionId);

  const report = buildReport(
    sessionId,
    extractions,
    validationRow?.result || null,
    validationRow?.createdAt || null
  );

  res.json(report);
});

// GET /api/sessions/:sessionId/expiring
router.get('/:sessionId/expiring', (req: Request, res: Response): void => {
  const sessionId = req.params.sessionId as string;

  const session = getSessionById(sessionId);
  if (!session) {
    res.status(404).json({ error: 'SESSION_NOT_FOUND', message: `Session ${sessionId} not found.` });
    return;
  }

  const withinDays = parseInt((req.query.withinDays as string) || '90', 10);
  if (isNaN(withinDays) || withinDays < 1) {
    res.status(400).json({ error: 'INTERNAL_ERROR', message: 'withinDays must be a positive integer.' });
    return;
  }

  const expiring = getExpiringDocuments(sessionId, withinDays);

  res.json({
    sessionId,
    withinDays,
    count: expiring.length,
    documents: expiring.map(e => ({
      id: e.id,
      fileName: e.fileName,
      documentType: e.documentType,
      documentName: e.documentName,
      holderName: e.holderName,
      daysUntilExpiry: e.validity?.daysUntilExpiry,
      expiryDate: e.validity?.dateOfExpiry,
      applicableRole: e.applicableRole,
    })),
  });
});

export default router;