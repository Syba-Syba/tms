import { lambdaJob } from '../lib/scheduler';

/**
 * The scheduled Lambda functions in serverless.yml point here, not at the job handlers: these
 * take no arguments from EventBridge and record each daily run for /health.
 */
export const notificationsDispatch = lambdaJob('notifications-dispatch');
export const uploadsSweep = lambdaJob('uploads-sweep');
export const leasesActivate = lambdaJob('leases-activate');
export const privacySweep = lambdaJob('privacy-sweep');
export const notificationsSweep = lambdaJob('notifications-sweep');
export const arrearsRun = lambdaJob('arrears-run');
export const interestRun = lambdaJob('interest-run');
export const invoicesRun = lambdaJob('invoices-run');
