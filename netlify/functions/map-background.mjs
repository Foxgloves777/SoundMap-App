// Mapping a sound takes longer than an ordinary Netlify Function is allowed to
// run, so it runs here: the "-background" suffix gives it 15 minutes. Netlify
// answers the caller with 202 straight away; progress is read via /api/job.
import { runMapJob } from "../../lib/core.mjs";

export default async req => {
  await runMapJob(await req.json().catch(() => ({})));
};
