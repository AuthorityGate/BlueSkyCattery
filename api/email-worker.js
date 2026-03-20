// ============================================
// Blue Sky Cattery - Email Worker
// Processes incoming emails to kittens@blueskycattery.com
// Handles: photo extraction, forwarding to Gmail + Brevo
// ============================================

export default {
  async email(message, env, ctx) {
    const from = message.from;
    const to = message.to;
    const subject = message.headers.get('subject') || '';

    // Always forward to Gmail recipients
    const forwards = [
      message.forward('stuckeydeanna3@gmail.com'),
      message.forward('kkomlosy@gmail.com'),
    ];

    // Check if sender is an admin (for photo processing)
    const adminEmails = ['deanna@blueskycattery.com', 'kkomlosy@gmail.com', 'stuckeydeanna3@gmail.com'];
    const isAdmin = adminEmails.includes(from.toLowerCase());

    // Forward to Brevo inbound for CRM tracking (all emails)
    // Brevo processes via reply.blueskycattery.com MX
    // We'll POST to our own webhook instead
    try {
      const rawEmail = await new Response(message.raw).arrayBuffer();
      const rawText = new TextDecoder().decode(rawEmail);

      // Extract basic info for webhook
      const webhookPayload = {
        items: [{
          From: { Address: from },
          Subject: subject,
          RawTextBody: extractTextFromEmail(rawText),
          Attachments: await extractAttachments(rawText)
        }]
      };

      // Send to our inbound webhook for photo processing + CRM
      forwards.push(
        fetch('https://portal.blueskycattery.com/api/webhook/inbound-email', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(webhookPayload)
        })
      );
    } catch (e) {
      console.error('Email processing error:', e);
    }

    // Execute all forwards in parallel
    await Promise.allSettled(forwards);
  }
};

// Extract plain text body from raw email
function extractTextFromEmail(raw) {
  // Simple extraction - find text/plain content
  const lines = raw.split('\n');
  let inBody = false;
  let body = '';
  let boundary = '';

  for (const line of lines) {
    if (line.match(/^Content-Type:.*boundary="?([^";\s]+)/i)) {
      boundary = line.match(/boundary="?([^";\s]+)/i)?.[1] || '';
    }
    if (!inBody && line.trim() === '') {
      inBody = true;
      continue;
    }
    if (inBody) {
      if (boundary && line.includes(boundary)) continue;
      if (line.match(/^Content-Type:/i)) { inBody = false; continue; }
      if (line.match(/^Content-Transfer-Encoding:/i)) continue;
      if (line.match(/^Content-Disposition:/i)) continue;
      body += line + '\n';
    }
  }
  return body.trim().slice(0, 5000); // Limit size
}

// Extract image attachments as base64 from raw MIME email
function extractAttachments(raw) {
  const attachments = [];
  const parts = raw.split(/--[^\r\n]+/);

  for (const part of parts) {
    // Check if this part is an image attachment
    const ctMatch = part.match(/Content-Type:\s*(image\/[^\s;]+)/i);
    const nameMatch = part.match(/(?:name|filename)="?([^";\r\n]+)"?/i);
    const encodingMatch = part.match(/Content-Transfer-Encoding:\s*base64/i);

    if (ctMatch && encodingMatch) {
      const contentType = ctMatch[1];
      const filename = nameMatch ? nameMatch[1].trim() : 'photo.jpg';

      // Extract base64 content (everything after the blank line in this MIME part)
      const blankLineIdx = part.indexOf('\r\n\r\n') !== -1 ? part.indexOf('\r\n\r\n') + 4 : part.indexOf('\n\n') + 2;
      if (blankLineIdx > 4) {
        const base64Content = part.slice(blankLineIdx).replace(/[\r\n\s]/g, '');
        if (base64Content.length > 100) { // Minimum viable image
          attachments.push({
            Name: filename,
            ContentType: contentType,
            Content: base64Content
          });
        }
      }
    }
  }

  return attachments;
}
