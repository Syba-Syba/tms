/**
 * WhatsApp through Meta's Cloud API. A business may only start a conversation with an approved
 * template, so every notice goes out through one: WHATSAPP_TEMPLATE, a Utility template whose
 * body has one parameter, for example "Threshold update: {{1}} Open the app for the details."
 *
 * Template parameters may not hold line breaks, tabs or long runs of spaces, so the message is
 * flattened into one paragraph and kept well under the 1024-character limit.
 */

export interface WhatsappConfig {
  token: string;
  phoneNumberId: string;
  template: string;
  language: string;
  apiVersion: string;
}

export function whatsappConfig(): WhatsappConfig | null {
  const token = process.env.WHATSAPP_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  if (!token || !phoneNumberId) return null;
  return {
    token,
    phoneNumberId,
    template: process.env.WHATSAPP_TEMPLATE || 'threshold_update',
    language: process.env.WHATSAPP_TEMPLATE_LANGUAGE || 'en',
    // Meta retires Graph API versions about two years after release; move this up when it does.
    apiVersion: process.env.WHATSAPP_API_VERSION || 'v23.0',
  };
}

export const MAX_PARAMETER = 900;

/** Subject and body as one line a template parameter accepts. */
export function flatten(subject: string, body: string): string {
  const text = `${subject}. ${body}`
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/ {2,}/g, ' ')
    .replace(/\.\s*\./g, '.')
    .trim();
  return text.length > MAX_PARAMETER ? `${text.slice(0, MAX_PARAMETER - 1).trimEnd()}…` : text;
}

/** +27821234567 as WhatsApp wants it: digits only, country code first. */
export const waNumber = (phone: string) => phone.replace(/\D/g, '');

/** Meta's codes for a number that cannot get the message at all: trying again will not help. */
const PERMANENT = new Set([131026, 131030, 131009, 132000, 132001]);

export async function sendWhatsapp(config: WhatsappConfig, to: string, subject: string, body: string): Promise<void> {
  const response = await fetch(`https://graph.facebook.com/${config.apiVersion}/${config.phoneNumberId}/messages`, {
    method: 'POST',
    headers: { authorization: `Bearer ${config.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: waNumber(to),
      type: 'template',
      template: {
        name: config.template,
        language: { code: config.language },
        components: [{ type: 'body', parameters: [{ type: 'text', text: flatten(subject, body) }] }],
      },
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (response.ok) return;
  const detail = (await response.json().catch(() => ({}))) as { error?: { code?: number; message?: string } };
  const error = new Error(`WhatsApp ${response.status}: ${detail.error?.message ?? 'no detail'}`);
  // A number not on WhatsApp is parked, not retried: email still reaches the person.
  if (detail.error?.code !== undefined && PERMANENT.has(detail.error.code)) Object.assign(error, { skip: true });
  throw error;
}
