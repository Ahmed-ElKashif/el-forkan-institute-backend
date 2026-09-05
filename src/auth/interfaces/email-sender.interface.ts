import type { OtpPurpose } from '../otp.service';

export const EMAIL_SENDER = Symbol('EMAIL_SENDER');

export interface OtpEmail {
  /** The staff member's email address (already normalised, verified to exist). */
  to: string;
  /** The staff member's display name, for the greeting. */
  fullName: string;
  /** The one-time code to deliver. Six digits; never persisted in the clear. */
  code: string;
  /** Login vs password reset — decides the subject/wording only. */
  purpose: OtpPurpose;
}

/**
 * The email boundary, declared where it is consumed (AuthModule) rather than
 * beside the Resend concrete — so the login flow depends on this contract, not
 * on a provider, and a test can send OTPs to an in-memory sink. Concrete:
 * {@link ../providers/resend-email-sender.ts}.
 */
export interface IEmailSender {
  /** Delivers a one-time code. Rejects if the message could not be handed off,
   *  so the caller never tells a user "check your email" for a mail that failed. */
  sendOtp(email: OtpEmail): Promise<void>;
}
