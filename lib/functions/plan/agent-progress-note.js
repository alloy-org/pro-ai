/**
 * AgentProgressNote - Interface for creating and managing the agent's progress note
 *
 * This class provides methods for creating a progress note, appending new sections,
 * or overwriting existing sections using app.replaceNoteContent
 */

export class AgentProgressNote {
  constructor(app, noteUUID) {
    this.app = app;
    this.noteUUID = noteUUID;
    this._sectionCache = new Map();
  }

  /**
   * Get the note handle for this progress note
   * @returns {Object} noteHandle
   */
  getNoteHandle() {
    return { uuid: this.noteUUID };
  }

  /**
   * Get the URL of this progress note
   * @returns {Promise<string>}
   */
  async getURL() {
    return await this.app.getNoteURL(this.getNoteHandle());
  }

  /**
   * Get the full content of the progress note
   * @returns {Promise<string>}
   */
  async getContent() {
    return await this.app.getNoteContent(this.getNoteHandle());
  }

  /**
   * Get all sections in the note
   * @returns {Promise<Array>}
   */
  async getSections() {
    return await this.app.getNoteSections(this.getNoteHandle());
  }

  /**
   * Append content to the end of the note
   * @param {string} sectionTitle - Title for reference (not added as heading if already exists)
   * @param {string} content - Markdown content to append
   */
  async appendSection(sectionTitle, content) {
    await this.app.insertNoteContent(
      this.getNoteHandle(),
      content,
      { atEnd: true }
    );

    // Update cache
    if (this._sectionCache.has(sectionTitle)) {
      this._sectionCache.set(
        sectionTitle,
        this._sectionCache.get(sectionTitle) + content
      );
    } else {
      this._sectionCache.set(sectionTitle, content);
    }
  }

  /**
   * Append content under a specific heading, creating the heading if needed
   * @param {string} heading - The heading text (without #)
   * @param {string} content - Content to add under the heading
   * @param {number} level - Heading level (1-3), defaults to 1
   */
  async appendUnderHeading(heading, content, level = 1) {
    const currentContent = await this.getContent();
    const headingMarker = '#'.repeat(level);
    const headingPattern = new RegExp(`^${headingMarker}\\s+${this._escapeRegex(heading)}\\s*$`, 'm');

    if (headingPattern.test(currentContent)) {
      // Heading exists - find it and append after
      const sections = await this.getSections();
      const targetSection = sections.find(
        s => s.heading && s.heading.text === heading && s.heading.level === level
      );

      if (targetSection) {
        // Get current section content and append to it
        const sectionContent = await this._getSectionContentByIndex(sections, targetSection);
        await this.app.replaceNoteContent(
          this.getNoteHandle(),
          sectionContent + '\n' + content,
          { section: { heading: { text: heading, level } } }
        );
      } else {
        // Fallback: append at end
        await this.appendSection(heading, content);
      }
    } else {
      // Create new heading section
      const newSection = `\n${headingMarker} ${heading}\n\n${content}\n`;
      await this.app.insertNoteContent(
        this.getNoteHandle(),
        newSection,
        { atEnd: true }
      );
    }
  }

  /**
   * Replace the content of a specific section
   * @param {string} sectionTitle - The heading text to identify the section
   * @param {string} newContent - New content for the section
   * @param {number} level - Heading level (1-3), defaults to 1
   * @returns {Promise<boolean>} - Whether replacement was successful
   */
  async replaceSection(sectionTitle, newContent, level = 1) {
    const result = await this.app.replaceNoteContent(
      this.getNoteHandle(),
      newContent,
      { section: { heading: { text: sectionTitle, level } } }
    );

    // Update cache
    this._sectionCache.set(sectionTitle, newContent);

    return result;
  }

  /**
   * Get the content of a specific section
   * @param {string} sectionTitle - The heading text
   * @returns {Promise<string|null>}
   */
  async getSectionContent(sectionTitle) {
    const content = await this.getContent();
    const sections = await this.getSections();

    const targetSection = sections.find(
      s => s.heading && s.heading.text === sectionTitle
    );

    if (!targetSection) {
      return null;
    }

    return await this._getSectionContentByIndex(sections, targetSection);
  }

  /**
   * Add a sub-section for analyzing an artifact
   * @param {string} artifactName - Name of the artifact being analyzed
   * @param {string} artifactType - Type: 'image', 'note', 'website', 'task', 'footnote'
   * @param {string} content - Analysis content
   */
  async addArtifactAnalysis(artifactName, artifactType, content) {
    const heading = `Analyze ${artifactName} ${artifactType}`;
    const sectionContent = `## ${heading}\n\n${content}\n\n`;

    await this.appendUnderHeading('Collect Rich Footnotes & other task context', sectionContent, 1);
  }

  /**
   * Add an action item to the action list
   * @param {Object} actionItem - Action item with title, description, type
   */
  async addActionItem(actionItem) {
    const itemContent = `- [ ] **${actionItem.title}**\n  ${actionItem.description || ''}\n`;
    await this.appendUnderHeading('Action Items', itemContent, 1);
  }

  /**
   * Mark an action item as complete
   * @param {string} actionTitle - Title of the action to mark complete
   * @param {string} resultSummary - Optional summary of the result
   */
  async markActionComplete(actionTitle, resultSummary = '') {
    const sectionContent = await this.getSectionContent('Action Items');
    if (!sectionContent) return;

    const pattern = new RegExp(
      `- \\[ \\] \\*\\*${this._escapeRegex(actionTitle)}\\*\\*`,
      'g'
    );

    let newContent = sectionContent.replace(pattern, `- [x] **${actionTitle}**`);

    if (resultSummary) {
      newContent = newContent.replace(
        `- [x] **${actionTitle}**`,
        `- [x] **${actionTitle}**\n  ✓ ${resultSummary}`
      );
    }

    await this.replaceSection('Action Items', newContent);
  }

  /**
   * Add a clarification question record
   * @param {string} question - The question asked
   * @param {string} answer - The user's answer
   */
  async addClarificationRecord(question, answer) {
    const content = `**Q:** ${question}\n**A:** ${answer}\n\n`;
    await this.appendUnderHeading('What to clarify with the user', content, 1);
  }

  /**
   * Create a linked reference to another note
   * @param {string} noteUUID - UUID of the note to link
   * @param {string} linkText - Text for the link
   * @returns {Promise<string>} - Markdown link
   */
  async createNoteLink(noteUUID, linkText) {
    const noteURL = await this.app.getNoteURL({ uuid: noteUUID });
    return `[${linkText}](${noteURL})`;
  }

  /**
   * Create a Rich Footnote style reference
   * @param {string} linkText - Text for the footnote link
   * @param {string} description - Description/content of the footnote
   * @param {string} imageURL - Optional image URL
   * @returns {string} - Markdown footnote syntax
   */
  createRichFootnote(linkText, description, imageURL = null) {
    const footnoteId = this._generateFootnoteId();
    let footnoteContent = `[^${footnoteId}]: [${linkText}]()\n\n${description}\n`;

    if (imageURL) {
      footnoteContent += `\n![](${imageURL})\n`;
    }

    return {
      inline: `[${linkText}][^${footnoteId}]`,
      definition: footnoteContent
    };
  }

  /**
   * Helper: Extract section content by finding boundaries between sections
   */
  async _getSectionContentByIndex(sections, targetSection) {
    const content = await this.getContent();
    const lines = content.split('\n');

    const targetIndex = sections.indexOf(targetSection);
    const nextSection = sections[targetIndex + 1];

    let startLine = 0;
    let endLine = lines.length;

    // Find start of target section
    if (targetSection.heading) {
      const headingPattern = new RegExp(
        `^#{${targetSection.heading.level}}\\s+${this._escapeRegex(targetSection.heading.text)}\\s*$`
      );
      for (let i = 0; i < lines.length; i++) {
        if (headingPattern.test(lines[i])) {
          startLine = i + 1; // Start after heading
          break;
        }
      }
    }

    // Find end of target section (start of next section)
    if (nextSection) {
      if (nextSection.heading) {
        const nextHeadingPattern = new RegExp(
          `^#{${nextSection.heading.level}}\\s+${this._escapeRegex(nextSection.heading.text)}\\s*$`
        );
        for (let i = startLine; i < lines.length; i++) {
          if (nextHeadingPattern.test(lines[i])) {
            endLine = i;
            break;
          }
        }
      } else {
        // Next section starts with HR
        for (let i = startLine; i < lines.length; i++) {
          if (/^---+\s*$/.test(lines[i])) {
            endLine = i;
            break;
          }
        }
      }
    }

    return lines.slice(startLine, endLine).join('\n').trim();
  }

  /**
   * Helper: Escape regex special characters
   */
  _escapeRegex(string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /**
   * Helper: Generate unique footnote ID
   */
  _generateFootnoteId() {
    return Math.random().toString(36).substring(2, 8);
  }
}

export default AgentProgressNote;
