/**
 * AgentEmailer - Handles "Write an email" action
 *
 * Creates a clickable mailto: link that pre-populates an email with:
 * - Recipient (To)
 * - Subject
 * - Body
 * - CC (optional)
 * - BCC (optional)
 */

import PhasePromptUser from "functions/plan/phase-prompt-user.js"

export class AgentEmailer {
  constructor(app, progressNote) {
    this.app = app;
    this.progressNote = progressNote;
    this.promptUser = new PhasePromptUser(app);
  }

  /**
   * Execute the email action
   * @param {Object} params - Email parameters
   * @param {string} params.to - Recipient email address(es) or "ASK_USER"
   * @param {string} params.subject - Email subject
   * @param {Array} params.bodyOutline - Key points for email body
   * @param {string} params.cc - CC recipients (optional)
   * @param {string} params.bcc - BCC recipients (optional)
   * @param {string} params.context - Additional context for composing
   * @returns {Promise<Object>} - Result with mailto link
   */
  async execute(params) {
    let { to, subject, bodyOutline, cc, bcc, context } = params;

    const results = {
      mailtoLink: null,
      summary: '',
      llmCallsMade: 0
    };

    // Handle "ASK_USER" for recipient
    if (to === 'ASK_USER' || !to) {
      to = await this.promptUser.promptSingle(
        'Who should receive this email?',
        'string',
        { placeholder: 'email@example.com' }
      );

      if (!to) {
        results.summary = 'Email cancelled - no recipient provided';
        return results;
      }
    }

    // Prompt user to review/edit email details
    const emailDetails = await this._promptForEmailDetails({
      to,
      subject,
      bodyOutline,
      cc,
      bcc
    });

    if (!emailDetails) {
      results.summary = 'Email cancelled by user';
      return results;
    }

    // Build the mailto link
    const mailtoLink = this._buildMailtoLink(emailDetails);
    results.mailtoLink = mailtoLink;

    // Document in progress note
    await this._documentEmail(emailDetails, mailtoLink);

    results.summary = `Created email to ${emailDetails.to} with subject "${emailDetails.subject}"`;

    return results;
  }

  /**
   * Prompt user to review and edit email details
   */
  async _promptForEmailDetails(params) {
    const { to, subject, bodyOutline, cc, bcc } = params;

    // Build body text from outline
    let bodyText = '';
    if (Array.isArray(bodyOutline) && bodyOutline.length > 0) {
      bodyText = bodyOutline.map(point => `• ${point}`).join('\n');
    } else if (typeof bodyOutline === 'string') {
      bodyText = bodyOutline;
    }

    // Create form for user to edit
    const result = await this.app.prompt('Review and edit the email details:', {
      inputs: [
        {
          label: 'To (recipients)',
          type: 'string',
          value: to,
          placeholder: 'email@example.com, another@example.com'
        },
        {
          label: 'Subject',
          type: 'string',
          value: subject || '',
          placeholder: 'Email subject'
        },
        {
          label: 'Body',
          type: 'text',
          value: bodyText,
          placeholder: 'Email body content...'
        },
        {
          label: 'CC (optional)',
          type: 'string',
          value: cc || '',
          placeholder: 'cc@example.com'
        },
        {
          label: 'BCC (optional)',
          type: 'string',
          value: bcc || '',
          placeholder: 'bcc@example.com'
        }
      ]
    });

    if (!result) {
      return null;
    }

    const [toResult, subjectResult, bodyResult, ccResult, bccResult] = result;

    return {
      to: toResult,
      subject: subjectResult,
      body: bodyResult,
      cc: ccResult || null,
      bcc: bccResult || null
    };
  }

  /**
   * Build a mailto: link from email details
   * @param {Object} details - Email details
   * @returns {string} - Complete mailto: URL
   */
  _buildMailtoLink(details) {
    const { to, subject, body, cc, bcc } = details;

    // Start with recipient
    let mailto = `mailto:${this._encodeRecipients(to)}`;

    // Build query parameters
    const params = [];

    if (subject) {
      params.push(`subject=${this._encodeParam(subject)}`);
    }

    if (body) {
      params.push(`body=${this._encodeParam(body)}`);
    }

    if (cc) {
      params.push(`cc=${this._encodeRecipients(cc)}`);
    }

    if (bcc) {
      params.push(`bcc=${this._encodeRecipients(bcc)}`);
    }

    if (params.length > 0) {
      mailto += '?' + params.join('&');
    }

    return mailto;
  }

  /**
   * Encode a parameter value for URL
   */
  _encodeParam(value) {
    return encodeURIComponent(value);
  }

  /**
   * Encode recipient email addresses
   */
  _encodeRecipients(recipients) {
    // Handle multiple recipients separated by comma or semicolon
    const emails = recipients
      .split(/[,;]/)
      .map(e => e.trim())
      .filter(e => e.length > 0);

    return emails.map(e => encodeURIComponent(e)).join(',');
  }

  /**
   * Document the email in progress note
   */
  async _documentEmail(details, mailtoLink) {
    let content = `\n### Email Composed\n\n`;

    content += `**To:** ${details.to}\n`;
    content += `**Subject:** ${details.subject}\n\n`;

    if (details.cc) {
      content += `**CC:** ${details.cc}\n`;
    }
    if (details.bcc) {
      content += `**BCC:** ${details.bcc}\n`;
    }

    content += `**Body Preview:**\n`;
    content += `> ${details.body?.substring(0, 200)?.replace(/\n/g, '\n> ')}${details.body?.length > 200 ? '...' : ''}\n\n`;

    // Create clickable link
    content += `📧 **[Click here to open email](${mailtoLink})**\n\n`;

    await this.progressNote.appendUnderHeading('Action Items', content, 1);
  }

  /**
   * Quick method to compose a simple email
   * @param {string} to - Recipient
   * @param {string} subject - Subject line
   * @param {string} body - Email body
   * @returns {string} - Mailto link
   */
  static quickCompose(to, subject, body) {
    const params = [];

    if (subject) {
      params.push(`subject=${encodeURIComponent(subject)}`);
    }

    if (body) {
      params.push(`body=${encodeURIComponent(body)}`);
    }

    let mailto = `mailto:${encodeURIComponent(to)}`;
    if (params.length > 0) {
      mailto += '?' + params.join('&');
    }

    return mailto;
  }
}

export default AgentEmailer;
