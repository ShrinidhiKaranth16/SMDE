# Code Review — feat: add document extraction endpoint

## Critical Issues

### 1. Hardcoded API Key 🚨

```ts
const client = new Anthropic({ apiKey: 'sk-ant-REDACTED' });
```

This is the most urgent thing to fix. Even though you've written `REDACTED` here, if the real key was ever committed to git — even for one second — it needs to be rotated immediately. Git history doesn't forget.

API keys should always come from environment variables:

```ts
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
```

And add `.env` to `.gitignore` right now if it isn't already. This is non-negotiable on any team.

**Teaching moment:** Once a secret is committed to a git repo, it's compromised — even if you delete it in the next commit. Services like GitGuardian scan public repos constantly and will find it within minutes. Always use env vars, always.

---

### 2. Saving User Files to Disk Without Any Plan

```ts
const savedPath = path.join('./uploads', file.originalname);
fs.copyFileSync(file.path, savedPath);
```

A few problems here:

- **PII risk** — maritime documents contain passport numbers, dates of birth, medical data. Saving them to a local `./uploads` folder with zero access control, no encryption, no retention policy is a compliance nightmare. GDPR, PDPA, you name it — this will cause issues.
- **Filename collision** — two people upload a file called `passport.pdf` and the second one silently overwrites the first. Data loss, no error.
- **Disk fills up** — files accumulate forever with no cleanup. In production this will eventually crash the server.

If we need to store files, they go to S3 with proper access controls and a retention policy. For now, processing in memory and discarding is actually the safer default.

---

### 3. Using Opus for Everything

```ts
model: 'claude-opus-4-6',
```

I get it — Opus gave better results in your testing. But Opus is significantly more expensive than Haiku or Sonnet. Running every document extraction through Opus will burn through API credits very fast, especially at scale.

Use `claude-haiku-4-5-20251001` for this — it handles structured document extraction well and costs a fraction of Opus. If we find specific document types where Haiku struggles, we can selectively upgrade those. Don't default to the most expensive option.

---

## Reliability Issues

### 4. JSON.parse Will Crash on Bad LLM Output

```ts
const result = JSON.parse(response.content[0].text);
```

LLMs don't always return clean JSON. Sometimes they wrap it in markdown fences like ` ```json ... ``` `, sometimes they add an explanation before the JSON, sometimes the JSON is just malformed. This line will throw an exception on any of those cases and the user gets a 500 error with zero useful information.

You need to:
1. Extract JSON robustly — find the outermost `{` and `}` regardless of surrounding text
2. Wrap in try/catch with a specific error code
3. Store the raw LLM response even on failure so we can debug what went wrong

---

### 5. No Timeout on the LLM Call

```ts
const response = await client.messages.create({ ... });
```

If Anthropic's API is slow or hanging, this request will just wait forever. Set a timeout — 30 seconds is reasonable. Without it you'll have requests piling up during any API degradation.

---

### 6. Global State for Storage

```ts
global.extractions = global.extractions || [];
global.extractions.push(result);
```

This is fine for a quick local test but it's not something we can ship. Problems:
- Every server restart wipes all data
- Memory grows unboundedly — never gets cleaned up
- Doesn't work with multiple server instances at all
- No way to query, filter, or retrieve specific extractions

We have a proper SQLite DB set up for this. Extractions should go in the `extractions` table.

---

## Minor Things

### 7. Vague Error Message

```ts
res.status(500).json({ error: 'Something went wrong' });
```

This tells the client nothing useful. Use consistent error codes like `INTERNAL_ERROR` or `LLM_JSON_PARSE_FAIL` so the frontend can handle different errors differently. Also `console.log` for errors should be `console.error`.

### 8. No File Type Validation

There's no check on what file type is being uploaded. Someone could send a `.exe` or a 100MB video and this endpoint would happily try to process it. Add mimetype validation and a file size limit.

---

## What's Good

- The basic flow is correct — read file, convert to base64, send to LLM, return result
- You thought about not losing uploaded files, which shows the right instinct — just needs to be done properly
- Tested it with a real document before raising the PR, appreciated

Fix the API key thing first — everything else can be iterated on but that one needs to happen right now. Happy to pair on the storage and JSON parsing bits if helpful.