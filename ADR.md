# Architecture Decision Record — SMDE

## Question 1 — Sync vs Async

I kept the sync approach as the default mainly because it makes development a lot smoother — you upload a file, get the result back, and move on. No need to deal with job IDs, polling, or extra state management while you're just trying to test things quickly. For a use case like a Manning Agent uploading one document at a time, it also feels more intuitive.

That said, in a production setup with real traffic, async should absolutely be the default. LLM calls can easily take anywhere between 3 to 8 seconds, and holding an HTTP connection open that long isn’t ideal. You start running into timeouts from load balancers, dropped connections on mobile, and if multiple users are uploading simultaneously, you end up with a bunch of requests just sitting idle. That doesn’t scale well.

So realistically, I’d enforce async in cases like:

When the file size exceeds 2MB, since larger files naturally take longer to process
When there are more than 5 concurrent requests from the same session, which likely means batch uploads

---

## Question 2 — Queue Choice

Went with a **simple in-process queue** — just an array with a concurrency limiter, max 3 parallel extractions running at a time. No Redis, no BullMQ, nothing fancy.

The idea was to keep things lightweight. For a system handling around 50–100 documents a day, introducing Redis or BullMQ felt like unnecessary overhead — more infrastructure, more monitoring, and more things that can fail.

But the failure modes are real:
- **Process restart = everything in queue is gone** — I do recover `PROCESSING` jobs on startup and mark them `FAILED`, but `QUEUED` jobs sitting in memory? Finished, over, goodbye
- **No persistence** — server crashes, queue disappears
- **Single instance only** — can't run two instances and share a queue, doesn't work like that

At **500 concurrent extractions per minute** At higher scale — say hundreds of extractions per minute — this approach won’t hold up. That’s where something like BullMQ with Redis becomes the right choice, with proper persistence, retries, and the ability to scale workers independently.

---

## Question 3 — LLM Provider Abstraction

Built a proper abstraction. Every provider implements one interface:

```typescript
interface LLMProvider {
  complete(messages: LLMMessage[], timeoutMs?: number): Promise<LLMResponse>;
}
```

One method. That's the whole contract. The extraction pipeline doesn't know or care if it's talking to Claude, Gemini, Groq, or a local Ollama instance running on someone's laptop. Swapping providers is literally two env var changes — `LLM_PROVIDER` and `LLM_MODEL` — zero code changes.

Implemented six providers: Anthropic, Google Gemini, Groq, Mistral, OpenAI, and Ollama. Each one handles its own message format and error handling internally so the business logic stays clean.

This was worth building properly. Maritime document processing is exactly the kind of domain where you'll want to compare providers — Gemini might be cheaper per token, Claude might handle scanned STCW certificates better, Groq might be faster for high-volume batch processing. Without the abstraction you're doing a surgery every time you want to try a different model. With it you just change the env and run your benchmarks.


---

## Question 4 — Schema Design

The current schema stores `fields`, `validity`, `compliance`, `medicalData`, and `flags` as JSON strings in TEXT columns. It works fine for the current use case — store it, retrieve it, return it — but it has real problems at scale.

The main risks:
- **No queryability** — you can't do `WHERE validity_json->>'isExpired' = true` in SQLite without pulling everything into memory first. Want all sessions with an expired COC? You're doing a full table scan and filtering in application code.
- **No indexing** — you can't index inside a JSON string in SQLite
- **Schema drift** — the JSON shape can change silently. Old records have one shape, new ones have another, and your application code has to handle both.

If this needed full-text search across extracted fields or proper COC expiry queries, I'd migrate to **PostgreSQL** and use proper JSONB columns which support GIN indexes and JSON path queries. Or better yet, pull the most-queried fields out of JSON entirely — `is_expired`, `document_type`, `expiry_date` are already top-level columns, and that's exactly the right call for fields you'll filter on.

---


## Question 5 — What I Skipped

**Authentication and multi-tenancy** — right now anyone who knows a sessionId can read it. No API key, no user concept, no ownership check, nothing. In production you'd need at minimum API key auth and session scoping per organization. Skipped because it's straightforward but time-consuming plumbing that doesn't demonstrate anything interesting about the extraction pipeline itself. Will implement if taken forward.

**File storage** — files are processed in memory and discarded immediately after. No S3, no disk storage, kuch nahi. This is exactly why the retry endpoint asks you to re-upload the file instead of actually retrying — the original bytes are long gone. In production you'd store the file encrypted in S3 with a proper retention policy so you can retry failed jobs, audit what was processed, and reprocess old extractions when the prompt gets updated.

**Observability** — there's no structured logging, no metrics, no distributed tracing. The debug console.logs I added during development definitely don't count as observability. In production you'd want request IDs propagated through the entire LLM pipeline, processing time histograms, LLM error rate alerts, and notifications when parse failure rate suddenly spikes. Skipped because setting up proper observability infrastructure takes longer than it looks and the assignment is already covering a lot of ground.