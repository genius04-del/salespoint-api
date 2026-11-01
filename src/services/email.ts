import { Resend } from "resend";

const apiKey = process.env.RESEND_API_KEY;
const resend = apiKey ? new Resend(apiKey) : null;

// Falls back to Resend's own onboarding sender if nothing is configured —
// that one works immediately with no domain setup, but can only deliver to
// the email address your Resend account itself is registered with. See
// RESEND_FROM_EMAIL in .env.example for switching to your own domain.
const FROM = process.env.RESEND_FROM_EMAIL || "SalesPoint <onboarding@resend.dev>";

// Never throws — a broken email provider must not break the password-reset
// flow's generic response (rule: never confirm/deny whether an email exists,
// and never let a third-party outage turn into a 500 for the user). Callers
// should still log the reset link themselves so the flow is testable even
// with no provider configured at all.
export async function sendPasswordResetEmail(to: string, resetUrl: string): Promise<boolean> {
  if (!resend) {
    console.warn(
      "[email] RESEND_API_KEY is not set — skipping actual send. " +
        "The reset link is still logged by the caller for local testing."
    );
    return false;
  }

  try {
    const result = await resend.emails.send({
      from: FROM,
      to,
      subject: "Reset your SalesPoint password",
      html: `
        <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
          <h2 style="color: #071A2F;">Reset your password</h2>
          <p>Someone requested a password reset for your SalesPoint account. If this was you, click below to set a new password. This link expires in 30 minutes.</p>
          <p style="margin: 24px 0;">
            <a href="${resetUrl}" style="background: #FF6B00; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block;">
              Reset Password
            </a>
          </p>
          <p style="color: #666; font-size: 14px;">If you didn't request this, you can safely ignore this email — your password will not be changed.</p>
          <p style="color: #999; font-size: 12px;">Or copy this link: ${resetUrl}</p>
        </div>
      `,
    });

    if (result.error) {
      console.error("[email] Resend returned an error:", result.error);
      return false;
    }
    return true;
  } catch (err) {
    console.error("[email] Failed to send password reset email:", err);
    return false;
  }
}
