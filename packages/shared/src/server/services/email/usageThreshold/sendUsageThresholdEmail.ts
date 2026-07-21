import { createTransport } from "nodemailer";
import { parseConnectionUrl } from "nodemailer/lib/shared/index.js";
import { logger } from "../../../logger";

export async function sendUsageThresholdEmail(params: {
  env: Partial<
    Record<
      "EMAIL_FROM_ADDRESS" | "SMTP_CONNECTION_URL" | "NEXTAUTH_URL",
      string | undefined
    >
  >;
  receiverEmail: string;
  organizationName: string;
  orgId: string;
  currentUsage: number;
  blocked: boolean;
  resetDate: Date;
}) {
  if (!params.env.EMAIL_FROM_ADDRESS || !params.env.SMTP_CONNECTION_URL) {
    logger.warn(
      "Usage threshold email skipped because SMTP is not configured",
      {
        orgId: params.orgId,
      },
    );
    return;
  }
  const billingUrl = `${params.env.NEXTAUTH_URL?.replace(/\/$/, "") ?? ""}/organization/${params.orgId}/settings/billing`;
  const mailer = createTransport(
    parseConnectionUrl(params.env.SMTP_CONNECTION_URL),
  );
  await mailer.sendMail({
    to: params.receiverEmail,
    from: { address: params.env.EMAIL_FROM_ADDRESS, name: "Litefuse" },
    subject: params.blocked
      ? "Litefuse Developer usage limit reached"
      : "Litefuse Developer usage is at 80%",
    text: params.blocked
      ? `${params.organizationName} has used ${params.currentUsage.toLocaleString()} units. New ingestion is paused until ${params.resetDate.toISOString()} or until the organization upgrades. Manage billing: ${billingUrl}`
      : `${params.organizationName} has used ${params.currentUsage.toLocaleString()} of 100,000 included monthly units. Usage resets on ${params.resetDate.toISOString()}. Manage billing: ${billingUrl}`,
  });
}
