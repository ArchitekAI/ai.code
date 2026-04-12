import { httpRouter } from "convex/server";

import { normalizeLinearWebhookInput } from "../src/linear/ingress.ts";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";

const http = httpRouter();

http.route({
  path: "/health",
  method: "GET",
  handler: httpAction(async () => new Response("ok", { status: 200 })),
});

http.route({
  path: "/linear/webhook",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const payload = await request.json();
    const ingress = normalizeLinearWebhookInput(payload);
    const result = await ctx.runMutation(internal.controlThreads.upsertFromLinearIngress, ingress);

    return Response.json({
      accepted: true,
      ...result,
    });
  }),
});

export default http;
