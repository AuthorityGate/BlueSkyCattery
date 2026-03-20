// ============================================
// Blue Sky Cattery - Email Worker
// Routes kittens@blueskycattery.com emails:
// 1. Forward to Gmail (Kevin)
// 2. Parse attachments + POST to portal webhook
// ============================================

export default {
  async email(message, env, ctx) {
    const from = message.from;
    const to = message.to;
    const subject = message.headers.get('subject') || '';

    // Forward to Gmail
    try {
      await message.forward('kkomlosy@gmail.com');
    } catch(e) {}

    // Read the raw email into a buffer
    try {
      const rawBytes = await new Response(message.raw).arrayBuffer();
      const rawText = new TextDecoder('utf-8', { fatal: false }).decode(new Uint8Array(rawBytes));

      // Parse MIME to extract text body and image attachments
      const textBody = extractPlainText(rawText);
      const attachments = extractImageAttachments(rawText);

      // Build webhook payload matching Brevo's format
      const payload = {
        items: [{
          From: { Address: from },
          Subject: subject,
          RawTextBody: textBody,
          Attachments: attachments
        }]
      };

      // POST to portal webhook
      ctx.waitUntil(
        fetch('https://portal.blueskycattery.com/api/webhook/inbound-email', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        }).catch(e => console.error('Webhook failed:', e))
      );
    } catch(e) {
      console.error('Email parse error:', e);
    }
  }
};

function extractPlainText(raw) {
  // Find the first text/plain section
  const boundary = findBoundary(raw);
  if (!boundary) {
    // No multipart - just get body after headers
    const headerEnd = raw.indexOf('\r\n\r\n');
    if (headerEnd === -1) return '';
    return raw.slice(headerEnd + 4, headerEnd + 5004).trim();
  }

  const parts = raw.split('--' + boundary);
  for (const part of parts) {
    if (part.match(/Content-Type:\s*text\/plain/i)) {
      const bodyStart = part.indexOf('\r\n\r\n');
      if (bodyStart === -1) continue;
      let body = part.slice(bodyStart + 4).trim();
      // Handle base64 encoded text
      if (part.match(/Content-Transfer-Encoding:\s*base64/i)) {
        try { body = atob(body.replace(/\s/g, '')); } catch(e) {}
      }
      // Handle quoted-printable
      if (part.match(/Content-Transfer-Encoding:\s*quoted-printable/i)) {
        body = body.replace(/=\r?\n/g, '').replace(/=([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
      }
      return body.slice(0, 5000);
    }
  }
  return '';
}

function extractImageAttachments(raw) {
  const attachments = [];
  const boundary = findBoundary(raw);
  if (!boundary) return attachments;

  const parts = raw.split('--' + boundary);
  for (const part of parts) {
    // Check if this MIME part is an image
    const ctMatch = part.match(/Content-Type:\s*(image\/[^\s;\r\n]+)/i);
    if (!ctMatch) continue;

    // Must be base64 encoded
    if (!part.match(/Content-Transfer-Encoding:\s*base64/i)) continue;

    const contentType = ctMatch[1];

    // Get filename
    const nameMatch = part.match(/(?:file)?name=["']?([^"'\r\n;]+)/i);
    const filename = nameMatch ? nameMatch[1].trim() : 'photo.jpg';

    // Extract base64 content after the blank line
    const bodyStart = part.indexOf('\r\n\r\n');
    if (bodyStart === -1) continue;

    // Get the base64 data, strip whitespace
    let base64 = part.slice(bodyStart + 4).trim();
    // Remove any trailing boundary markers
    const boundaryIdx = base64.indexOf('--');
    if (boundaryIdx > 0) base64 = base64.slice(0, boundaryIdx);
    base64 = base64.replace(/[\r\n\s]/g, '');

    if (base64.length > 100) {
      attachments.push({
        Name: filename,
        ContentType: contentType,
        Content: base64
      });
    }
  }
  return attachments;
}

function findBoundary(raw) {
  const match = raw.match(/Content-Type:\s*multipart\/[^;]+;\s*boundary=["']?([^"'\r\n;]+)/i);
  return match ? match[1].trim() : null;
}
