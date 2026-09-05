import { Injectable, Logger } from '@nestjs/common';
import { Resend } from 'resend';
import type {
  IEmailSender,
  OtpEmail,
} from '../interfaces/email-sender.interface';
import { OTP_TTL_MS } from '../auth.constants';

/**
 * Delivers a one-time code over Resend.
 *
 * Mirrors WhatsAppClient (§7.8): the API key is read from `process.env` at call
 * time, so it never lands in a database row, an audit entry, or a log line —
 * and the code itself is never logged in production, since a log is not a place
 * for a live second factor. `OTP_EMAIL_FROM` must be an address on a
 * Resend-verified domain, or Resend rejects the send.
 *
 * Dev fallback: when Resend is not configured AND this is not production, the
 * code is logged to the server console instead of emailed, so the flow can be
 * exercised before a sending domain exists. In production, an unconfigured
 * sender fails closed — it never silently skips the second factor.
 */
@Injectable()
export class ResendEmailSender implements IEmailSender {
  private readonly logger = new Logger(ResendEmailSender.name);

  async sendOtp(email: OtpEmail): Promise<void> {
    const apiKey = process.env.RESEND_API_KEY;
    const from = process.env.OTP_EMAIL_FROM;
    const minutes = Math.round(OTP_TTL_MS / 60_000);

    if (!apiKey || !from) {
      if (process.env.NODE_ENV === 'production') {
        throw new Error(
          'Email OTP is not configured: set RESEND_API_KEY and OTP_EMAIL_FROM',
        );
      }
      // Local/testing only: surface the code so login can be tested end to end
      // without a live sending domain.
      this.logger.warn(
        `[dev] OTP for ${email.to} (${email.purpose}): ${email.code} — valid ${minutes} min`,
      );
      return;
    }

    const { error } = await new Resend(apiKey).emails.send({
      from,
      to: email.to,
      subject: subjectFor(email.purpose),
      html: renderOtpHtml(email.fullName, email.code, minutes),
    });

    if (error) {
      // Resend's message names the real reason (unverified domain, invalid
      // recipient); the code is not part of it, so this is safe to log.
      this.logger.warn(`OTP email to ${email.to} failed: ${error.message}`);
      throw new Error(`Could not send the code: ${error.message}`);
    }
  }
}

function subjectFor(purpose: OtpEmail['purpose']): string {
  return purpose === 'password_reset'
    ? 'رمز إعادة تعيين كلمة المرور — معهد الفرقان'
    : 'رمز الدخول إلى معهد الفرقان';
}

function renderOtpHtml(fullName: string, code: string, minutes: number): string {
  // A right-to-left Arabic body with the code as Latin digits, spaced so it
  // reads as a code and not a number.
  return `<div dir="rtl" style="font-family:system-ui,Arial,sans-serif;text-align:right">
  <p>مرحباً ${escapeHtml(fullName)}،</p>
  <p>رمزك لمرة واحدة هو:</p>
  <p style="font-size:28px;font-weight:700;letter-spacing:6px;direction:ltr;text-align:center">${code}</p>
  <p>هذا الرمز صالح لمدة ${minutes} دقائق. إذا لم تطلب ذلك، تجاهل هذه الرسالة.</p>
</div>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
