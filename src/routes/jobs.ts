import { Router, Request, Response } from 'express';
import { getJobById, getQueuePosition, getExtractionById } from '../db/index';

const router = Router();

// GET /api/jobs/:jobId
router.get('/:jobId', (req: Request, res: Response): void => {
  const jobId = req.params.jobId as string;
  const job = getJobById(jobId);

  if (!job) {
    res.status(404).json({ error: 'JOB_NOT_FOUND', message: `Job ${jobId} not found.` });
    return;
  }

  if (job.status === 'QUEUED') {
    const position = getQueuePosition(jobId);
    res.json({
      jobId: job.id,
      status: 'QUEUED',
      queuePosition: position,
      queuedAt: job.queuedAt,
      estimatedWaitMs: position * 6000,
    });
    return;
  }

  if (job.status === 'PROCESSING') {
    res.json({
      jobId: job.id,
      status: 'PROCESSING',
      queuePosition: 0,
      startedAt: job.startedAt,
      estimatedCompleteMs: 3200,
    });
    return;
  }

  if (job.status === 'COMPLETE') {
    const { extractionId } = job;
    const extraction = extractionId ? getExtractionById(extractionId) : null;
    res.json({
      jobId: job.id,
      status: 'COMPLETE',
      extractionId: job.extractionId,
      result: extraction ? {
        id: extraction.id,
        sessionId: extraction.sessionId,
        fileName: extraction.fileName,
        documentType: extraction.documentType,
        documentName: extraction.documentName,
        applicableRole: extraction.applicableRole,
        category: extraction.category,
        confidence: extraction.confidence,
        holderName: extraction.holderName,
        dateOfBirth: extraction.dateOfBirth,
        sirbNumber: extraction.sirbNumber,
        passportNumber: extraction.passportNumber,
        fields: extraction.fields,
        validity: extraction.validity,
        compliance: extraction.compliance,
        medicalData: extraction.medicalData,
        flags: extraction.flags,
        isExpired: extraction.isExpired,
        processingTimeMs: extraction.processingTimeMs,
        summary: extraction.summary,
        promptVersion: extraction.promptVersion,
        createdAt: extraction.createdAt,
      } : null,
      completedAt: job.completedAt,
    });
    return;
  }

  // FAILED
  res.json({
    jobId: job.id,
    status: 'FAILED',
    error: job.errorCode,
    message: job.errorMessage,
    failedAt: job.completedAt,
    retryable: true,
  });
});

// POST /api/jobs/:jobId/retry
router.post('/:jobId/retry', async (req: Request, res: Response): Promise<void> => {
  const jobId = req.params.jobId as string;
  const job = getJobById(jobId);

  if (!job) {
    res.status(404).json({ error: 'JOB_NOT_FOUND', message: `Job ${jobId} not found.` });
    return;
  }

  if (job.status !== 'FAILED') {
    res.status(422).json({
      error: 'INVALID_JOB_STATE',
      message: `Cannot retry a job in ${job.status} state. Only FAILED jobs can be retried.`,
    });
    return;
  }

  res.status(422).json({
    error: 'INVALID_JOB_STATE',
    message: 'Retry requires the original file to be re-uploaded. Please POST to /api/extract with the same file to create a new job.',
    retryable: false,
  });
});

export default router;