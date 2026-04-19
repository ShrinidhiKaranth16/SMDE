# SMDE — Smart Maritime Document Extractor

A production-oriented backend service that accepts seafarer certification documents and extracts structured data from them using a vision-capable LLM.

## What It Does

- Upload maritime documents (certificates, passports, medical exams) via REST API
- Automatically identifies document type, extracts fields, and flags compliance issues
- Supports both sync and async processing modes
- Cross-document validation to assess overall seafarer compliance
- Deduplication, rate limiting, and job queue built in

## Stack

- **Runtime**: Node.js + TypeScript
- **Database**: SQLite (via better-sqlite3)
- **Queue**: In-process queue with concurrency control
- **LLM**: Configurable — Anthropic, Google Gemini, Groq, Mistral, OpenAI, or Ollama

---

## Setup

### 1. Clone the repo

```bash
git clone <your-repo-url>
cd smde-service
```

### 2. Install dependencies

```bash
npm install
```

### 3. Configure environment

```bash
cp .env.example .env
```

Open `.env` and fill in your API key:

```env
LLM_PROVIDER=groq
LLM_MODEL=meta-llama/llama-4-scout-17b-16e-instruct
LLM_API_KEY=your_api_key_here
```

Supported providers and their free tiers:

| Provider | Sign Up | Recommended Model |
|---|---|---|
| Anthropic | console.anthropic.com | claude-haiku-4-5-20251001 |
| Google Gemini | aistudio.google.com | gemini-2.0-flash |
| Groq | console.groq.com | meta-llama/llama-4-scout-17b-16e-instruct |
| Mistral | console.mistral.ai | pixtral-12b-2409 |
| OpenAI | platform.openai.com | gpt-4o-mini |
| Ollama (local) | ollama.ai | llava |

### 4. Run the server

```bash
npm run dev
```

Server starts on `http://localhost:3000`. The SQLite database and `data/` folder are created automatically on first run — no manual setup needed.

---

## Running Tests

```bash
npm test
```

Tests cover:
- JSON extraction and parsing logic (unit tests)
- All API endpoints (integration tests)
- Error cases — invalid file type, file too large, session not found, rate limiting

---

## API Endpoints

### POST /api/extract
Upload a document for extraction.

```bash
# Sync mode (default) — waits for result
curl -X POST http://localhost:3000/api/extract \
  -F "document=@/path/to/certificate.pdf"

# Async mode — returns immediately with jobId
curl -X POST "http://localhost:3000/api/extract?mode=async" \
  -F "document=@/path/to/certificate.pdf"

# With existing session
curl -X POST http://localhost:3000/api/extract \
  -F "document=@/path/to/certificate.pdf" \
  -F "sessionId=your-session-id"
```

Accepted file types: `image/jpeg`, `image/png`, `application/pdf`  
Max file size: 10MB  
Rate limit: 10 requests per minute per IP

**Sync response (200):**
```json
{
  "id": "uuid",
  "sessionId": "uuid",
  "fileName": "PEME_Sample.pdf",
  "documentType": "PEME",
  "documentName": "Pre-Employment Medical Examination",
  "applicableRole": "ENGINE",
  "category": "MEDICAL",
  "confidence": "HIGH",
  "holderName": "Samuel P. Samoya",
  "dateOfBirth": "12/03/1988",
  "sirbNumber": "C0869326",
  "fields": [...],
  "validity": { "isExpired": false, "daysUntilExpiry": 660 },
  "medicalData": { "fitnessResult": "FIT", "drugTestResult": "NEGATIVE" },
  "flags": [],
  "isExpired": false,
  "processingTimeMs": 2300
}
```

**Async response (202):**
```json
{
  "jobId": "uuid",
  "sessionId": "uuid",
  "status": "QUEUED",
  "pollUrl": "/api/jobs/uuid",
  "estimatedWaitMs": 6000
}
```

---

### GET /api/jobs/:jobId
Poll the status of an async extraction job.

```bash
curl http://localhost:3000/api/jobs/<jobId>
```

States: `QUEUED` → `PROCESSING` → `COMPLETE` | `FAILED`

---

### GET /api/sessions/:sessionId
Get a summary of all documents uploaded in a session.

```bash
curl http://localhost:3000/api/sessions/<sessionId>
```

---

### POST /api/sessions/:sessionId/validate
Cross-document compliance validation. Requires at least 2 documents in the session.

```bash
curl -X POST http://localhost:3000/api/sessions/<sessionId>/validate
```

Returns consistency checks, missing documents, medical flags, overall score, and hire/no-hire recommendation.

---

### GET /api/sessions/:sessionId/report
Get a structured compliance report derived from all extractions and the latest validation result.

```bash
curl http://localhost:3000/api/sessions/<sessionId>/report
```

---

### GET /api/sessions/:sessionId/expiring
Get all documents expiring within a given number of days, sorted by urgency.

```bash
curl "http://localhost:3000/api/sessions/<sessionId>/expiring?withinDays=90"
```

---

### GET /api/health
Health check with dependency status.

```bash
curl http://localhost:3000/api/health
```

```json
{
  "status": "OK",
  "version": "1.0.0",
  "uptime": 3612,
  "dependencies": {
    "database": "OK",
    "llmProvider": "OK",
    "queue": "OK"
  }
}
```

---

## Error Responses

All errors follow a consistent shape:

```json
{
  "error": "ERROR_CODE",
  "message": "Human readable message",
  "retryAfterMs": null
}
```

| Status | Code | Condition |
|---|---|---|
| 400 | `UNSUPPORTED_FORMAT` | File type not accepted |
| 400 | `INSUFFICIENT_DOCUMENTS` | Validate called with fewer than 2 documents |
| 413 | `FILE_TOO_LARGE` | File exceeds 10MB |
| 404 | `SESSION_NOT_FOUND` | Session ID does not exist |
| 404 | `JOB_NOT_FOUND` | Job ID does not exist |
| 422 | `LLM_JSON_PARSE_FAIL` | LLM returned unparseable response after retry |
| 429 | `RATE_LIMITED` | Too many requests |
| 500 | `INTERNAL_ERROR` | Unexpected server error |

---

## Project Structure

```
src/
├── index.ts                 # Entry point
├── app.ts                   # Express app setup
├── db/
│   └── index.ts             # SQLite database and all queries
├── routes/
│   ├── extract.ts           # POST /api/extract
│   ├── jobs.ts              # GET /api/jobs/:jobId
│   ├── sessions.ts          # Session endpoints
│   └── health.ts            # GET /api/health
├── services/
│   ├── extraction.ts        # LLM pipeline, JSON parsing, PDF text extraction
│   ├── llmProvider.ts       # Provider abstraction (Anthropic, Gemini, Groq etc.)
│   ├── queue.ts             # In-process job queue
│   ├── validation.ts        # Cross-document compliance validation
│   └── report.ts            # Report builder
├── middleware/
│   └── rateLimiter.ts       # Token bucket rate limiter
├── types/
│   └── index.ts             # All TypeScript types
└── tests/
    ├── extraction.test.ts   # Unit tests for JSON parsing logic
    └── api.test.ts          # Integration tests for all endpoints
```

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `LLM_PROVIDER` | `anthropic` | LLM provider to use |
| `LLM_MODEL` | `claude-haiku-4-5-20251001` | Model name |
| `LLM_API_KEY` | — | API key for the provider |
| `PORT` | `3000` | Server port |
| `NODE_ENV` | `development` | Environment |
| `DB_PATH` | `./data/smde.db` | SQLite database path |
| `RATE_LIMIT_WINDOW_MS` | `60000` | Rate limit window in ms |
| `RATE_LIMIT_MAX` | `10` | Max requests per window per IP |
| `WEBHOOK_SECRET` | — | HMAC secret for webhook signatures |
| `OLLAMA_BASE_URL` | `http://localhost:11434` | Ollama base URL (if using Ollama) |