/**
 * PhaseGather - Initial phase to decompose task links and Rich Footnotes
 *
 * This phase extracts and retrieves all artifacts from a task:
 * - Rich Footnotes (with images, descriptions, links)
 * - Links to notes (content retrieved via app.getNoteContent)
 * - Links to websites
 * - Links to specific tasks (retrieved via app.getTask)
 * - Embedded images
 *
 * This phase should NOT need to call an LLM - it's purely extraction and retrieval.
 */

export class PhaseGather {
  constructor(app, progressNote) {
    this.app = app;
    this.progressNote = progressNote;
  }

  /**
   * Execute the gather phase
   * @param {string} taskContent - The full task markdown content
   * @param {string} taskNoteUUID - UUID of the note containing the task
   * @returns {Promise<Object>} - Gathered context organized by type
   */
  async execute(taskContent, taskNoteUUID) {
    // Write section header to progress note
    await this.progressNote.appendUnderHeading(
      'Collect Rich Footnotes & other task context',
      'Analyzing task content to extract relevant context...\n\n',
      1
    );

    const context = {
      footnotes: [],
      noteLinks: [],
      websiteLinks: [],
      taskLinks: [],
      images: [],
      plainText: ''
    };

    // Parse Rich Footnotes
    const footnotes = this._parseRichFootnotes(taskContent);
    for (const footnote of footnotes) {
      const gatheredFootnote = await this._processFootnote(footnote);
      context.footnotes.push(gatheredFootnote);
    }

    // Parse inline links (not footnotes)
    const links = this._parseInlineLinks(taskContent);
    for (const link of links) {
      const gathered = await this._processLink(link, taskNoteUUID);
      if (gathered) {
        if (gathered.type === 'note') {
          context.noteLinks.push(gathered);
        } else if (gathered.type === 'task') {
          context.taskLinks.push(gathered);
        } else if (gathered.type === 'website') {
          context.websiteLinks.push(gathered);
        }
      }
    }

    // Extract plain text (without footnotes/links)
    context.plainText = this._extractPlainText(taskContent);

    // Generate summary section in progress note
    await this._writeSummary(context);

    return context;
  }

  /**
   * Parse Rich Footnotes from task content
   * Rich Footnotes format: [label][^N] with definition [^N]: [label](url)\ndescription\n![](image)
   */
  _parseRichFootnotes(content) {
    const footnotes = [];

    // Match footnote references: [text][^id] or [^id]
    const refPattern = /\[([^\]]*)\]\[\^(\w+)\]|\[\^(\w+)\]/g;
    const refMatches = [...content.matchAll(refPattern)];

    // Match footnote definitions: [^id]: content
    const defPattern = /\[\^(\w+)\]:\s*([\s\S]*?)(?=\n\[\^|\n#|\n---|\n\n\n|$)/g;
    const defMatches = [...content.matchAll(defPattern)];

    const definitions = new Map();
    for (const match of defMatches) {
      definitions.set(match[1], match[2].trim());
    }

    for (const ref of refMatches) {
      const id = ref[2] || ref[3];
      const label = ref[1] || '';
      const definition = definitions.get(id) || '';

      footnotes.push({
        id,
        label,
        definition,
        raw: ref[0]
      });
    }

    return footnotes;
  }

  /**
   * Process a single Rich Footnote and extract its contents
   */
  async _processFootnote(footnote) {
    const result = {
      id: footnote.id,
      label: footnote.label,
      description: '',
      images: [],
      links: [],
      noteContent: null
    };

    const definition = footnote.definition;

    // Extract images from footnote
    const imagePattern = /!\[([^\]]*)\]\(([^)]+)\)/g;
    const imageMatches = [...definition.matchAll(imagePattern)];
    for (const match of imageMatches) {
      result.images.push({
        alt: match[1],
        url: match[2]
      });
    }

    // Extract links from footnote
    const linkPattern = /\[([^\]]+)\]\(([^)]+)\)/g;
    const linkMatches = [...definition.matchAll(linkPattern)];
    for (const match of linkMatches) {
      if (!match[2].match(/\.(png|jpg|jpeg|gif|webp)$/i)) {
        result.links.push({
          text: match[1],
          url: match[2]
        });
      }
    }

    // Extract description text (remove images and links)
    let descText = definition
      .replace(/!\[[^\]]*\]\([^)]+\)/g, '')
      .replace(/\[[^\]]+\]\([^)]+\)/g, '')
      .replace(/\[[^\]]+\]\(\)/g, '') // Empty link brackets
      .trim();
    result.description = descText;

    // Write to progress note
    await this._documentFootnote(footnote, result);

    return result;
  }

  /**
   * Parse inline links (not Rich Footnotes)
   */
  _parseInlineLinks(content) {
    const links = [];

    // Remove footnote definitions first
    const contentWithoutDefs = content.replace(/\[\^\w+\]:[\s\S]*?(?=\n\[\^|\n#|\n---|$)/g, '');

    // Match markdown links: [text](url)
    const linkPattern = /\[([^\]]+)\]\(([^)]+)\)/g;
    const matches = [...contentWithoutDefs.matchAll(linkPattern)];

    for (const match of matches) {
      // Skip if it's a footnote reference
      if (match[1].startsWith('^')) continue;
      // Skip if it's an image
      if (match[0].startsWith('!')) continue;

      links.push({
        text: match[1],
        url: match[2],
        raw: match[0]
      });
    }

    return links;
  }

  /**
   * Process a link and retrieve its content based on type
   */
  async _processLink(link, taskNoteUUID) {
    const { url, text } = link;

    // Check if it's an Amplenote note link
    if (url.includes('amplenote.com/notes/')) {
      return await this._processNoteLink(link);
    }

    // Check if it's a task link
    if (url.includes('amplenote.com/notes/tasks/')) {
      return await this._processTaskLink(link);
    }

    // Check if it's a section link within the same note
    if (url.startsWith('#')) {
      return await this._processSectionLink(link, taskNoteUUID);
    }

    // It's an external website link
    return await this._processWebsiteLink(link);
  }

  /**
   * Process a link to an Amplenote note
   */
  async _processNoteLink(link) {
    const { url, text } = link;

    // Extract note UUID from URL
    const uuidMatch = url.match(/notes\/([a-f0-9-]+)/i);
    if (!uuidMatch) return null;

    const noteUUID = uuidMatch[1];

    try {
      const noteHandle = await this.app.findNote({ uuid: noteUUID });
      if (!noteHandle) {
        return { type: 'note', uuid: noteUUID, text, content: null, error: 'Note not found' };
      }

      const content = await this.app.getNoteContent({ uuid: noteUUID });

      const result = {
        type: 'note',
        uuid: noteUUID,
        name: noteHandle.name,
        text,
        content,
        tags: noteHandle.tags
      };

      // Document in progress note
      await this._documentNoteLink(result);

      return result;

    } catch (error) {
      return { type: 'note', uuid: noteUUID, text, content: null, error: error.message };
    }
  }

  /**
   * Process a link to a specific task
   */
  async _processTaskLink(link) {
    const { url, text } = link;

    // Extract task UUID from URL
    const uuidMatch = url.match(/tasks\/([a-f0-9-]+)/i);
    if (!uuidMatch) return null;

    const taskUUID = uuidMatch[1];

    try {
      const task = await this.app.getTask(taskUUID);
      if (!task) {
        return { type: 'task', uuid: taskUUID, text, task: null, error: 'Task not found' };
      }

      const result = {
        type: 'task',
        uuid: taskUUID,
        text,
        task,
        content: task.content,
        noteUUID: task.noteUUID
      };

      // Document in progress note
      await this._documentTaskLink(result);

      return result;

    } catch (error) {
      return { type: 'task', uuid: taskUUID, text, task: null, error: error.message };
    }
  }

  /**
   * Process a section link within the same note
   */
  async _processSectionLink(link, taskNoteUUID) {
    const { url, text } = link;

    // Section anchor
    const anchor = url.substring(1);

    try {
      const sections = await this.app.getNoteSections({ uuid: taskNoteUUID });
      const targetSection = sections.find(s => s.heading && s.heading.anchor === anchor);

      if (!targetSection) {
        return null;
      }

      // Get the note content and extract section
      const noteContent = await this.app.getNoteContent({ uuid: taskNoteUUID });
      const sectionContent = this._extractSectionContent(noteContent, targetSection, sections);

      const result = {
        type: 'note',
        uuid: taskNoteUUID,
        section: anchor,
        sectionTitle: targetSection.heading?.text,
        text,
        content: sectionContent
      };

      // Document in progress note
      await this._documentSectionLink(result);

      return result;

    } catch (error) {
      return null;
    }
  }

  /**
   * Process an external website link
   */
  async _processWebsiteLink(link) {
    const { url, text } = link;

    // Just record it - actual fetching happens during research phase if needed
    const result = {
      type: 'website',
      url,
      text,
      fetched: false
    };

    // Document in progress note
    await this._documentWebsiteLink(result);

    return result;
  }

  /**
   * Extract plain text from task content
   */
  _extractPlainText(content) {
    return content
      .replace(/\[\^[^\]]+\](:[\s\S]*?(?=\n\[\^|\n#|\n---|$))?/g, '') // Remove footnotes
      .replace(/!\[[^\]]*\]\([^)]+\)/g, '') // Remove images
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // Extract link text
      .replace(/[*_`#]/g, '') // Remove formatting
      .trim();
  }

  /**
   * Extract content for a specific section
   */
  _extractSectionContent(noteContent, targetSection, allSections) {
    const lines = noteContent.split('\n');
    const targetIndex = allSections.indexOf(targetSection);
    const nextSection = allSections[targetIndex + 1];

    let startLine = 0;
    let endLine = lines.length;

    // Find section boundaries
    if (targetSection.heading) {
      const headingPattern = new RegExp(
        `^#{${targetSection.heading.level}}\\s+${this._escapeRegex(targetSection.heading.text)}\\s*$`
      );
      for (let i = 0; i < lines.length; i++) {
        if (headingPattern.test(lines[i])) {
          startLine = i;
          break;
        }
      }
    }

    if (nextSection && nextSection.heading) {
      const nextHeadingPattern = new RegExp(
        `^#{${nextSection.heading.level}}\\s+`
      );
      for (let i = startLine + 1; i < lines.length; i++) {
        if (nextHeadingPattern.test(lines[i])) {
          endLine = i;
          break;
        }
      }
    }

    return lines.slice(startLine, endLine).join('\n').trim();
  }

  /**
   * Document a Rich Footnote analysis in the progress note
   */
  async _documentFootnote(footnote, result) {
    let content = `### Rich Footnote: "${result.label || footnote.id}"\n\n`;

    if (result.description) {
      content += `**Description:** ${result.description}\n\n`;
    }

    if (result.images.length > 0) {
      content += `**Images:**\n`;
      for (const img of result.images) {
        content += `![${img.alt}](${img.url})\n`;
        content += `*Image to be analyzed for task context*\n\n`;
      }
    }

    if (result.links.length > 0) {
      content += `**Embedded Links:**\n`;
      for (const link of result.links) {
        content += `- [${link.text}](${link.url})\n`;
      }
      content += '\n';
    }

    await this.progressNote.appendUnderHeading(
      'Collect Rich Footnotes & other task context',
      content,
      1
    );
  }

  /**
   * Document a note link in the progress note
   */
  async _documentNoteLink(result) {
    let content = `### Linked Note: "${result.name}"\n\n`;

    const noteLink = await this.progressNote.createNoteLink(result.uuid, result.name);
    content += `**Source:** ${noteLink}\n\n`;

    if (result.tags && result.tags.length > 0) {
      content += `**Tags:** ${result.tags.join(', ')}\n\n`;
    }

    // Include truncated content preview
    if (result.content) {
      const preview = result.content.substring(0, 500);
      content += `**Content Preview:**\n> ${preview.replace(/\n/g, '\n> ')}${result.content.length > 500 ? '...' : ''}\n\n`;
    }

    content += `*This note's content will inform the agent's understanding of the task.*\n\n`;

    await this.progressNote.appendUnderHeading(
      'Collect Rich Footnotes & other task context',
      content,
      1
    );
  }

  /**
   * Document a section link in the progress note
   */
  async _documentSectionLink(result) {
    let content = `### Linked Section: "${result.sectionTitle}"\n\n`;

    if (result.content) {
      const preview = result.content.substring(0, 500);
      content += `**Content Preview:**\n> ${preview.replace(/\n/g, '\n> ')}${result.content.length > 500 ? '...' : ''}\n\n`;
    }

    content += `*This section's content provides specific context for the task.*\n\n`;

    await this.progressNote.appendUnderHeading(
      'Collect Rich Footnotes & other task context',
      content,
      1
    );
  }

  /**
   * Document a task link in the progress note
   */
  async _documentTaskLink(result) {
    let content = `### Connected Task\n\n`;

    content += `**Task Content:** ${result.content}\n\n`;

    if (result.task) {
      if (result.task.completedAt) {
        content += `*Status: Completed*\n\n`;
      } else if (result.task.dismissedAt) {
        content += `*Status: Dismissed*\n\n`;
      } else {
        content += `*Status: Open*\n\n`;
      }
    }

    content += `*This connected task may provide additional context or dependencies.*\n\n`;

    await this.progressNote.appendUnderHeading(
      'Collect Rich Footnotes & other task context',
      content,
      1
    );
  }

  /**
   * Document a website link in the progress note
   */
  async _documentWebsiteLink(result) {
    let content = `### External Link: "${result.text}"\n\n`;
    content += `**URL:** [${result.url}](${result.url})\n\n`;
    content += `*This website may be consulted during the research phase if needed.*\n\n`;

    await this.progressNote.appendUnderHeading(
      'Collect Rich Footnotes & other task context',
      content,
      1
    );
  }

  /**
   * Write summary of gathered context
   */
  async _writeSummary(context) {
    let summary = `---\n\n### Gathered Context Summary\n\n`;

    const counts = [
      context.footnotes.length > 0 ? `${context.footnotes.length} Rich Footnotes` : null,
      context.noteLinks.length > 0 ? `${context.noteLinks.length} linked notes` : null,
      context.taskLinks.length > 0 ? `${context.taskLinks.length} connected tasks` : null,
      context.websiteLinks.length > 0 ? `${context.websiteLinks.length} external links` : null,
    ].filter(Boolean);

    if (counts.length > 0) {
      summary += `Found: ${counts.join(', ')}\n\n`;
    } else {
      summary += `No additional context found in task links or footnotes.\n\n`;
    }

    await this.progressNote.appendUnderHeading(
      'Collect Rich Footnotes & other task context',
      summary,
      1
    );
  }

  /**
   * Helper: Escape regex special characters
   */
  _escapeRegex(string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
}

export default PhaseGather;
