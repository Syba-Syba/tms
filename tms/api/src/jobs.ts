import { JOBS, runJob } from './lib/scheduler';

/**
 * Runs one scheduled job by hand: `npm run jobs -- invoices-run`. For an install that would
 * rather drive the jobs from cron than from the server's own timer (RUN_JOBS=false), and for
 * checking a job's output after a change.
 *
 * Not on PGlite. It is one process against one folder and the server holds that folder while
 * it runs, so a second process opening it from cron risks corrupting the database or losing
 * the invoices and interest it writes. Cron mode needs Postgres.
 */
const PGLITE_REFUSAL =
  'DB_DRIVER=pglite cannot be shared: the API server holds the PGlite folder while it runs,\n' +
  'and a second process opening it risks corrupting the database. On PGlite leave\n' +
  'RUN_JOBS=true and the server runs the jobs itself. To drive them from cron, use Postgres:\n' +
  'see "Running it for real without AWS" in the README.';

async function main(argv: string[]): Promise<number> {
  if (process.env.DB_DRIVER === 'pglite') {
    console.error(PGLITE_REFUSAL);
    return 1;
  }
  const name = argv[2];
  if (!name) {
    console.error(`Usage: npm run jobs -- <job>\nJobs: ${JOBS.map((job) => job.name).join(', ')}`);
    return 1;
  }
  try {
    const result = await runJob(name);
    console.log(JSON.stringify({ job: name, result }, null, 2));
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    return 1;
  }
}

process.exit(await main(process.argv));
