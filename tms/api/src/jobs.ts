import { JOBS, runJob } from './lib/scheduler';

/**
 * Runs one scheduled job by hand: `npm run jobs -- invoices-run`. For an install that would
 * rather drive the jobs from cron than from the server's own timer (RUN_JOBS=false), and for
 * checking a job's output after a change.
 */
const name = process.argv[2];
if (!name) {
  console.error(`Usage: npm run jobs -- <job>\nJobs: ${JOBS.map((job) => job.name).join(', ')}`);
  process.exit(1);
}

try {
  const result = await runJob(name);
  console.log(JSON.stringify({ job: name, result }, null, 2));
  process.exit(0);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
