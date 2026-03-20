// ============================================
// Blue Sky Cattery - Email Worker
// Routes kittens@blueskycattery.com emails:
// 1. Forward to Gmail (Kevin only for now)
// 2. Forward to Brevo inbound for CRM + photo processing
// ============================================

export default {
  async email(message, env, ctx) {
    // Forward to Gmail (Kevin only - Deanna removed to avoid photo spam)
    await message.forward('kkomlosy@gmail.com');

    // Forward to Brevo inbound for CRM tracking + photo processing
    // Brevo parses the email and triggers webhook to portal-worker
    await message.forward('kittens@reply.blueskycattery.com');
  }
};
