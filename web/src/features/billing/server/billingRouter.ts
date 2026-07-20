import { auditLog } from "@/src/features/audit-logs/auditLog";
import {
  createTRPCRouter,
  protectedOrganizationProcedure,
} from "@/src/server/api/trpc";
import { z } from "zod/v4";
import { billingTargetPlanSchema } from "./billingCatalogue";
import {
  assertCanManageBilling,
  cancelSubscription,
  changePlan,
  clearScheduledChange,
  createCheckoutSession,
  createPortalSession,
  getBillingStatus,
  reactivateSubscription,
} from "./billingService";

const orgInput = z.object({ orgId: z.string() });

async function auditBillingAction(params: {
  userId: string;
  orgId: string;
  action: string;
  after?: unknown;
}) {
  await auditLog({
    userId: params.userId,
    orgId: params.orgId,
    resourceType: "stripeCheckoutSession",
    resourceId: params.orgId,
    action: params.action,
    after: params.after,
  });
}

export const billingRouter = createTRPCRouter({
  getBillingStatus: protectedOrganizationProcedure
    .input(orgInput)
    .query(async ({ input, ctx }) => {
      await assertCanManageBilling({
        session: ctx.session,
        orgId: input.orgId,
      });
      return getBillingStatus(input.orgId);
    }),
  createCheckoutSession: protectedOrganizationProcedure
    .input(orgInput.extend({ targetPlan: billingTargetPlanSchema }))
    .mutation(async ({ input, ctx }) => {
      await assertCanManageBilling({
        session: ctx.session,
        orgId: input.orgId,
      });
      const result = await createCheckoutSession({
        orgId: input.orgId,
        userId: ctx.session.user.id,
        userEmail: ctx.session.user.email,
        targetPlan: input.targetPlan,
      });
      await auditBillingAction({
        userId: ctx.session.user.id,
        orgId: input.orgId,
        action: "billing.checkout.create",
        after: { targetPlan: input.targetPlan },
      });
      return result;
    }),
  changePlan: protectedOrganizationProcedure
    .input(orgInput.extend({ targetPlan: billingTargetPlanSchema }))
    .mutation(async ({ input, ctx }) => {
      await assertCanManageBilling({
        session: ctx.session,
        orgId: input.orgId,
      });
      const result = await changePlan(input);
      await auditBillingAction({
        userId: ctx.session.user.id,
        orgId: input.orgId,
        action: "billing.plan.change",
        after: { targetPlan: input.targetPlan, ...result },
      });
      return result;
    }),
  cancelSubscription: protectedOrganizationProcedure
    .input(orgInput)
    .mutation(async ({ input, ctx }) => {
      await assertCanManageBilling({
        session: ctx.session,
        orgId: input.orgId,
      });
      const result = await cancelSubscription(input.orgId);
      await auditBillingAction({
        userId: ctx.session.user.id,
        orgId: input.orgId,
        action: "billing.subscription.cancel",
      });
      return result;
    }),
  reactivateSubscription: protectedOrganizationProcedure
    .input(orgInput)
    .mutation(async ({ input, ctx }) => {
      await assertCanManageBilling({
        session: ctx.session,
        orgId: input.orgId,
      });
      const result = await reactivateSubscription(input.orgId);
      await auditBillingAction({
        userId: ctx.session.user.id,
        orgId: input.orgId,
        action: "billing.subscription.reactivate",
      });
      return result;
    }),
  clearScheduledChange: protectedOrganizationProcedure
    .input(orgInput)
    .mutation(async ({ input, ctx }) => {
      await assertCanManageBilling({
        session: ctx.session,
        orgId: input.orgId,
      });
      const result = await clearScheduledChange(input.orgId);
      await auditBillingAction({
        userId: ctx.session.user.id,
        orgId: input.orgId,
        action: "billing.schedule.clear",
      });
      return result;
    }),
  createPortalSession: protectedOrganizationProcedure
    .input(orgInput)
    .mutation(async ({ input, ctx }) => {
      await assertCanManageBilling({
        session: ctx.session,
        orgId: input.orgId,
      });
      return createPortalSession({ orgId: input.orgId });
    }),
});
