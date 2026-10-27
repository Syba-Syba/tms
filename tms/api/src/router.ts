import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { handler as applications_create } from './handlers/applications-create';
import { handler as auth_login } from './handlers/auth-login';
import { handler as auth_register } from './handlers/auth-register';
import { handler as auth_password } from './handlers/auth-password';
import { handler as auth_reset_request } from './handlers/auth-reset-request';
import { handler as auth_reset_confirm } from './handlers/auth-reset-confirm';
import { handler as applications_documents } from './handlers/applications-documents';
import { handler as contractors_list } from './handlers/contractors-list';
import { handler as files_view } from './handlers/files-view';
import { handler as inspections_get } from './handlers/inspections-get';
import { handler as inspections_render } from './handlers/inspections-render';
import { handler as properties_create } from './handlers/properties-create';
import { handler as properties_delete } from './handlers/properties-delete';
import { handler as properties_list } from './handlers/properties-list';
import { handler as properties_update } from './handlers/properties-update';
import { handler as units_available } from './handlers/units-available';
import { handler as units_create } from './handlers/units-create';
import { handler as units_delete } from './handlers/units-delete';
import { handler as units_update } from './handlers/units-update';
import { handler as applications_decide } from './handlers/applications-decide';
import { handler as applications_list } from './handlers/applications-list';
import { handler as documents_presign } from './handlers/documents-presign';
import { handler as inspections_create } from './handlers/inspections-create';
import { handler as inspections_findings } from './handlers/inspections-findings';
import { handler as inspections_photo_presign } from './handlers/inspections-photo-presign';
import { handler as inspections_sign } from './handlers/inspections-sign';
import { handler as invoices_render } from './handlers/invoices-render';
import { handler as leases_generate } from './handlers/leases-generate';
import { handler as leases_get } from './handlers/leases-get';
import { handler as leases_list } from './handlers/leases-list';
import { handler as leases_render } from './handlers/leases-render';
import { handler as leases_sign } from './handlers/leases-sign';
import { handler as leases_statement } from './handlers/leases-statement';
import { handler as notifications_preferences } from './handlers/notifications-preferences';
import { handler as payments_record } from './handlers/payments-record';
import { handler as payment_proofs_create } from './handlers/payment-proofs-create';
import { handler as payment_proofs_submit } from './handlers/payment-proofs-submit';
import { handler as payment_proofs_list } from './handlers/payment-proofs-list';
import { handler as payment_proofs_decide } from './handlers/payment-proofs-decide';
import { handler as bank_imports_create } from './handlers/bank-imports-create';
import { handler as bank_imports_list } from './handlers/bank-imports-list';
import { handler as bank_imports_get } from './handlers/bank-imports-get';
import { handler as bank_imports_resolve } from './handlers/bank-imports-resolve';
import { handler as expenses_create } from './handlers/expenses-create';
import { handler as expenses_list } from './handlers/expenses-list';
import { handler as expenses_update } from './handlers/expenses-update';
import { handler as reports_income_expense } from './handlers/reports-income-expense';
import { handler as reports_arrears } from './handlers/reports-arrears';
import { handler as photos_confirm } from './handlers/photos-confirm';
import { handler as renewals_decide } from './handlers/renewals-decide';
import { handler as renewals_offer } from './handlers/renewals-offer';
import { handler as terminations_comparison } from './handlers/terminations-comparison';
import { handler as terminations_deduction } from './handlers/terminations-deduction';
import { handler as terminations_serve } from './handlers/terminations-serve';
import { handler as terminations_settle } from './handlers/terminations-settle';
import { handler as tickets_action } from './handlers/tickets-action';
import { handler as tickets_close } from './handlers/tickets-close';
import { handler as tickets_comment } from './handlers/tickets-comment';
import { handler as tickets_create } from './handlers/tickets-create';
import { handler as tickets_get } from './handlers/tickets-get';
import { handler as tickets_list } from './handlers/tickets-list';
import { handler as tickets_photo_presign } from './handlers/tickets-photo-presign';

type Handler = (
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
) => Promise<APIGatewayProxyResultV2>;

/**
 * One Lambda serves every route.
 *
 * A function per route looked tidy and was wrong at this traffic. At roughly a request a
 * minute, no single function stayed warm, so nearly every call paid a cold start. One function
 * means any request keeps the whole API warm, there is one log group to search instead of
 * thirty-eight, and the same process runs locally as an ordinary server.
 *
 * The handlers themselves are untouched. They still take the API Gateway event and read
 * event.pathParameters, so this only has to match the path and fill those in.
 */
const ROUTES: Array<[string, string, Handler]> = [
  ['POST', '/auth/login', auth_login],
  ['POST', '/auth/register', auth_register],
  ['POST', '/auth/password', auth_password],
  ['POST', '/auth/reset/request', auth_reset_request],
  ['POST', '/auth/reset/confirm', auth_reset_confirm],
  ['POST', '/applications', applications_create],
  ['GET', '/applications', applications_list],
  ['POST', '/applications/{id}/decision', applications_decide],
  ['POST', '/applications/{id}/documents/presign', documents_presign],
  ['POST', '/applications/{id}/lease', leases_generate],
  ['POST', '/leases/{id}/signature', leases_sign],
  ['POST', '/leases/{id}/render', leases_render],
  ['POST', '/leases/{id}/inspections', inspections_create],
  ['PUT', '/inspections/{id}/findings', inspections_findings],
  ['POST', '/inspections/{id}/photos/presign', inspections_photo_presign],
  ['POST', '/inspections/{id}/signature', inspections_sign],
  ['POST', '/leases/{id}/payments', payments_record],
  ['GET', '/leases', leases_list],
  ['GET', '/leases/{id}', leases_get],
  ['GET', '/leases/{id}/statement', leases_statement],
  ['POST', '/invoices/{id}/render', invoices_render],
  ['POST', '/leases/{id}/tickets', tickets_create],
  ['GET', '/tickets', tickets_list],
  ['GET', '/tickets/{id}', tickets_get],
  ['POST', '/tickets/{id}/actions', tickets_action],
  ['POST', '/tickets/{id}/comments', tickets_comment],
  ['POST', '/tickets/{id}/close', tickets_close],
  ['POST', '/tickets/{id}/photos/presign', tickets_photo_presign],
  ['POST', '/photos/confirm', photos_confirm],
  ['POST', '/leases/{id}/termination', terminations_serve],
  ['GET', '/terminations/{id}/comparison', terminations_comparison],
  ['POST', '/terminations/{id}/deductions', terminations_deduction],
  ['DELETE', '/terminations/{id}/deductions/{deductionId}', terminations_deduction],
  ['POST', '/terminations/{id}/settle', terminations_settle],
  ['GET', '/notifications/preferences', notifications_preferences],
  ['PUT', '/notifications/preferences', notifications_preferences],
  ['POST', '/leases/{id}/renewal', renewals_offer],
  ['GET', '/properties', properties_list],
  ['POST', '/properties', properties_create],
  ['PUT', '/properties/{id}', properties_update],
  ['DELETE', '/properties/{id}', properties_delete],
  ['POST', '/properties/{id}/units', units_create],
  ['PUT', '/units/{id}', units_update],
  ['DELETE', '/units/{id}', units_delete],
  ['GET', '/units/available', units_available],
  ['GET', '/contractors', contractors_list],
  ['GET', '/applications/{id}/documents', applications_documents],
  ['GET', '/inspections/{id}', inspections_get],
  ['POST', '/inspections/{id}/render', inspections_render],
  ['POST', '/files/view', files_view],
  ['POST', '/renewals/{id}/decision', renewals_decide],
  ['POST', '/leases/{id}/payment-proofs', payment_proofs_create],
  ['POST', '/payment-proofs/{id}/submit', payment_proofs_submit],
  ['GET', '/payment-proofs', payment_proofs_list],
  ['POST', '/payment-proofs/{id}/decision', payment_proofs_decide],
  ['POST', '/bank-imports', bank_imports_create],
  ['GET', '/bank-imports', bank_imports_list],
  ['GET', '/bank-imports/{id}', bank_imports_get],
  ['POST', '/bank-imports/{id}/resolve', bank_imports_resolve],
  ['POST', '/expenses', expenses_create],
  ['GET', '/expenses', expenses_list],
  ['PUT', '/expenses/{id}', expenses_update],
  ['DELETE', '/expenses/{id}', expenses_update],
  ['GET', '/reports/income-expense', reports_income_expense],
  ['GET', '/reports/arrears', reports_arrears],
];

interface Compiled {
  method: string;
  pattern: RegExp;
  names: string[];
  handler: Handler;
  literal: number;
}

// Compiled once per container, not per request.
const COMPILED: Compiled[] = ROUTES.map(([method, path, handler]) => {
  const names: string[] = [];
  const pattern = path.replace(/\{([^}]+)\}/g, (_, name: string) => {
    names.push(name);
    return '([^/]+)';
  });
  return {
    method,
    pattern: new RegExp(`^${pattern}$`),
    names,
    handler,
    // A literal segment beats a parameter, so /notifications/preferences never gets captured
    // by a route ending in one.
    literal: path.split('/').filter((part) => part && !part.startsWith('{')).length,
  };
}).sort((a, b) => b.literal - a.literal);

export function match(method: string, path: string) {
  for (const route of COMPILED) {
    if (route.method !== method) continue;
    const found = route.pattern.exec(path);
    if (!found) continue;
    const params: Record<string, string> = {};
    route.names.forEach((name, index) => {
      params[name] = decodeURIComponent(found[index + 1]!);
    });
    return { handler: route.handler, params };
  }
  return null;
}

export const routeCount = COMPILED.length;

/** Used by the development server to show what exists. Not exposed in production. */
export const routeList = () =>
  ROUTES.map(([method, path]) => `${method} ${path}`).sort();
