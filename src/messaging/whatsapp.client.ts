import { Injectable, Logger } from '@nestjs/common';

/**
 * §7.8 — the WhatsApp Cloud API client.
 *
 * "`institute_settings` holds `whatsapp_business_phone`,
 * `whatsapp_phone_number_id` and `whatsapp_owner_user_id` — **identifiers
 * only. The access token lives in env, never in the database.**"
 *
 * The token is read from `process.env` at call time, so it never lands in a
 * database row, an audit entry, or a log line.
 */

const GRAPH_VERSION = 'v21.0';
const SEND_TIMEOUT_MS = 15_000;

export interface SendResult {
  status: 'sent' | 'failed';
  providerMessageId: string | null;
  errorCode: string | null;
  errorMessage: string | null;
}

export interface TemplateMessage {
  /** Digits, no leading '+' — see toWhatsAppRecipient. */
  to: string;
  /** The Meta-approved template name (§7.8: approval takes days). */
  templateName: string;
  languageCode: string;
  /** Positional body parameters, in the order the approved template declares. */
  bodyParameters: string[];
}

@Injectable()
export class WhatsAppClient {
  private readonly logger = new Logger(WhatsAppClient.name);

  /**
   * True when the integration is actually wired up. §7.8 warns that Meta
   * approval "takes days", so the rest of Phase 5 has to be usable before it
   * lands — the campaign, the idempotency guards and the delivery records all
   * work without it.
   */
  isConfigured(phoneNumberId: string | null): boolean {
    return Boolean(process.env.WHATSAPP_ACCESS_TOKEN && phoneNumberId);
  }

  /**
   * Never throws. A transport failure is a `failed` result with its reason, so
   * one unreachable number cannot abort a section's send — the caller records
   * per-message status and retries only the failed rows (§7.7).
   */
  async sendTemplate(
    phoneNumberId: string,
    message: TemplateMessage,
  ): Promise<SendResult> {
    const token = process.env.WHATSAPP_ACCESS_TOKEN;
    if (!token) {
      return failure('not_configured', 'WHATSAPP_ACCESS_TOKEN is not set');
    }

    // F11c: the id is interpolated into the Graph API URL path. Meta phone
    // number ids are numeric; refusing anything else stops a value like `../`
    // (set through institute settings) from redirecting the call to another
    // Graph endpoint.
    if (!/^\d+$/.test(phoneNumberId)) {
      return failure(
        'invalid_phone_number_id',
        'whatsapp_phone_number_id must be numeric',
      );
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
    try {
      const response = await fetch(
        `https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/messages`,
        {
          method: 'POST',
          signal: controller.signal,
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            messaging_product: 'whatsapp',
            to: message.to,
            type: 'template',
            template: {
              name: message.templateName,
              language: { code: message.languageCode },
              components: [
                {
                  type: 'body',
                  parameters: message.bodyParameters.map((text) => ({
                    type: 'text',
                    text,
                  })),
                },
              ],
            },
          }),
        },
      );

      const payload = (await response.json()) as {
        messages?: Array<{ id?: string }>;
        error?: { code?: number; message?: string };
      };

      if (!response.ok) {
        // Meta's error message is recorded verbatim: it names the actual
        // reason (unapproved template, number not on WhatsApp, 24-hour window)
        // and guessing at it later is impossible.
        return failure(
          String(payload.error?.code ?? response.status),
          payload.error?.message ?? `HTTP ${response.status}`,
        );
      }
      return {
        status: 'sent',
        providerMessageId: payload.messages?.[0]?.id ?? null,
        errorCode: null,
        errorMessage: null,
      };
    } catch (error) {
      // Includes the abort on timeout. The token is never logged.
      const reason = error instanceof Error ? error.message : 'unknown error';
      this.logger.warn(`WhatsApp send to ${message.to} failed: ${reason}`);
      return failure('transport_error', reason);
    } finally {
      clearTimeout(timer);
    }
  }
}

function failure(code: string, message: string): SendResult {
  return {
    status: 'failed',
    providerMessageId: null,
    errorCode: code,
    errorMessage: message,
  };
}
