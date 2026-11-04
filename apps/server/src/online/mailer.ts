/**
 * Sending email (password-reset codes). With RESEND_API_KEY set it sends
 * through Resend (https://resend.com) from MAIL_FROM; otherwise it writes
 * the message to the server log, which is enough for local testing.
 */
export interface Mail {
  to: string;
  subject: string;
  text: string;
}

export type Mailer = (m: Mail) => Promise<void>;

export function makeMailer(log: (...a: unknown[]) => void = console.log): Mailer {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.MAIL_FROM ?? 'ChessFront <no-reply@chessfront.app>';
  if (!key) {
    return async (m) => log(`[mail] to ${m.to}: ${m.subject}\n${m.text}`);
  }
  return async (m) => {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from, to: [m.to], subject: m.subject, text: m.text }),
    });
    if (!r.ok) throw new Error(`email failed: ${r.status} ${await r.text().catch(() => '')}`);
  };
}
