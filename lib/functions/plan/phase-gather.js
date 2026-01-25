// --------------------------------------------------------------------------
// PhaseGather - Initial phase to decompose task links and Rich Footnotes
//
// This phase extracts and retrieves all artifacts from a task:
// - Rich Footnotes (with images, descriptions, links)
// - Links to notes (content retrieved via app.getNoteContent)
// - Links to websites
// - Links to specific tasks (retrieved via app.getTask)
// - Embedded images
//
// This phase should NOT need to call an LLM - it's purely extraction and retrieval.
// --------------------------------------------------------------------------

export class PhaseGather {
  constructor(app, progressNote) {
    this.app = app;
    this.progressNote = progressNote;
  }

  // --------------------------------------------------------------------------
  // Execute the gather phase
  //
  // @param {string} taskContent - The full task markdown content
  // @param {string} taskNoteUUID - UUID of the note containing the task
  // @returns {Promise<Object>} - Gathered context organized by type:
  //   - footnotes: Array of processed Rich Footnote objects
  //   - noteLinks: Array of linked note objects
  //   - websiteLinks: Array of external link objects
  //   - taskLinks: Array of linked task objects
  //   - images: Array of image objects
  //   - plainText: Plain text extracted from task content
  // --------------------------------------------------------------------------
  async execute(taskContent, taskNoteUUID) {
    // Write section header to progress note
    await this.progressNote.appendUnderHeading(
      "Collect Rich Footnotes & other task context",
      "Analyzing task content to extract relevant context...\n\n",
      1
    );

    const context = {
      footnotes: [],
      noteLinks: [],
      websiteLinks: [],
      taskLinks: [],
      images: [],
      plainText: ""
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
        if (gathered.type === "note") {
          context.noteLinks.push(gathered);
        } else if (gathered.type === "task") {
          context.taskLinks.push(gathered);
        } else if (gathered.type === "website") {
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

  // --------------------------------------------------------------------------
  // Local helpers
  // --------------------------------------------------------------------------

  // --------------------------------------------------------------------------
  // Document a Rich Footnote analysis in the progress note
  //
  // @param {Object} footnote - The original footnote object
  // @param {string} footnote.id - The footnote ID
  // @param {Object} result - The processed footnote result
  // @param {string} result.label - The footnote label
  // @param {string} result.description - The footnote description
  // @param {Array} result.images - Array of image objects with alt and url
  // @param {Array} result.links - Array of link objects with text and url
  // @returns {Promise<void>}
  // --------------------------------------------------------------------------
  async _documentFootnote(footnote, result) {
    let content = `### Rich Footnote: "${ result.label || footnote.id }"\n\n`;

    if (result.description) {
      content += `**Description:** ${ result.description }\n\n`;
    }

    if (result.images.length > 0) {
      content += "**Images:**\n";
      for (const img of result.images) {
        content += `![${ img.alt }](${ img.url })\n`;
        content += "*Image to be analyzed for task context*\n\n";
      }
    }

    if (result.links.length > 0) {
      content += "**Embedded Links:**\n";
      for (const link of result.links) {
        content += `- [${ link.text }](${ link.url })\n`;
      }
      content += "\n";
    }

    await this.progressNote.appendUnderHeading(
      "Collect Rich Footnotes & other task context",
      content,
      1
    );
  }

  // --------------------------------------------------------------------------
  // Document a note link in the progress note
  //
  // @param {Object} result - The processed note link result
  // @param {string} result.uuid - UUID of the linked note
  // @param {string} result.name - Name of the linked note
  // @param {Array} result.tags - Array of tags on the note
  // @param {string} result.content - Content of the note
  // @returns {Promise<void>}
  // --------------------------------------------------------------------------
  async _documentNoteLink(result) {
    let content = `### Linked Note: "${ result.name }"\n\n`;

    const noteLink = await this.progressNote.createNoteLink(result.uuid, result.name);
    content += `**Source:** ${ noteLink }\n\n`;

    if (result.tags && result.tags.length > 0) {
      content += `**Tags:** ${ result.tags.join(", ") }\n\n`;
    }

    // Include truncated content preview
    if (result.content) {
      const preview = result.content.substring(0, 500);
      content += `**Content Preview:**\n> ${ preview.replace(/\n/g, "\n> ") }${ result.content.length > 500 ? "..." : "" }\n\n`;
    }

    content += "*This note's content will inform the agent's understanding of the task.*\n\n";

    await this.progressNote.appendUnderHeading(
      "Collect Rich Footnotes & other task context",
      content,
      1
    );
  }

  // --------------------------------------------------------------------------
  // Document a section link in the progress note
  //
  // @param {Object} result - The processed section link result
  // @param {string} result.sectionTitle - Title of the linked section
  // @param {string} result.content - Content of the section
  // @returns {Promise<void>}
  // --------------------------------------------------------------------------
  async _documentSectionLink(result) {
    let content = `### Linked Section: "${ result.sectionTitle }"\n\n`;

    if (result.content) {
      const preview = result.content.substring(0, 500);
      content += `**Content Preview:**\n> ${ preview.replace(/\n/g, "\n> ") }${ result.content.length > 500 ? "..." : "" }\n\n`;
    }

    content += "*This section's content provides specific context for the task.*\n\n";

    await this.progressNote.appendUnderHeading(
      "Collect Rich Footnotes & other task context",
      content,
      1
    );
  }

  // --------------------------------------------------------------------------
  // Document a task link in the progress note
  //
  // @param {Object} result - The processed task link result
  // @param {string} result.content - Content of the linked task
  // @param {Object} result.task - The task object
  // @param {number} result.task.completedAt - Timestamp when task was completed
  // @param {number} result.task.dismissedAt - Timestamp when task was dismissed
  // @returns {Promise<void>}
  // --------------------------------------------------------------------------
  async _documentTaskLink(result) {
    let content = "### Connected Task\n\n";

    content += `**Task Content:** ${ result.content }\n\n`;

    if (result.task) {
      if (result.task.completedAt) {
        content += "*Status: Completed*\n\n";
      } else if (result.task.dismissedAt) {
        content += "*Status: Dismissed*\n\n";
      } else {
        content += "*Status: Open*\n\n";
      }
    }

    content += "*This connected task may provide additional context or dependencies.*\n\n";

    await this.progressNote.appendUnderHeading(
      "Collect Rich Footnotes & other task context",
      content,
      1
    );
  }

  // --------------------------------------------------------------------------
  // Document a website link in the progress note
  //
  // @param {Object} result - The processed website link result
  // @param {string} result.text - Display text of the link
  // @param {string} result.url - URL of the website
  // @returns {Promise<void>}
  // --------------------------------------------------------------------------
  async _documentWebsiteLink(result) {
    let content = `### External Link: "${ result.text }"\n\n`;
    content += `**URL:** [${ result.url }](${ result.url })\n\n`;
    content += "*This website may be consulted during the research phase if needed.*\n\n";

    await this.progressNote.appendUnderHeading(
      "Collect Rich Footnotes & other task context",
      content,
      1
    );
  }

  // --------------------------------------------------------------------------
  // Escape regex special characters
  //
  // @param {string} string - The string to escape
  // @returns {string} - The escaped string with special regex characters prefixed with backslash
  // --------------------------------------------------------------------------
  _escapeRegex(string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  // --------------------------------------------------------------------------
  // Extract plain text from task content
  //
  // @param {string} content - The task markdown content
  // @returns {string} - Plain text with footnotes, images, links, and formatting removed
  // --------------------------------------------------------------------------
  _extractPlainText(content) {
    return content
      .replace(/\[\^[^\]]+\](:[\s\S]*?(?=\n\[\^|\n#|\n---|$))?/g, "") // Remove footnotes
      .replace(/!\[[^\]]*\]\([^)]+\)/g, "") // Remove images
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1") // Extract link text
      .replace(/[*_`#]/g, "") // Remove formatting
      .trim();
  }

  // --------------------------------------------------------------------------
  // Extract content for a specific section
  //
  // @param {string} noteContent - Full content of the note
  // @param {Object} targetSection - The target section object
  // @param {Object} targetSection.heading - The heading object
  // @param {string} targetSection.heading.text - The heading text
  // @param {number} targetSection.heading.level - The heading level
  // @param {Array} allSections - Array of all section objects in the note
  // @returns {string} - The content of the section including its heading
  // --------------------------------------------------------------------------
  _extractSectionContent(noteContent, targetSection, allSections) {
    const lines = noteContent.split("\n");
    const targetIndex = allSections.indexOf(targetSection);
    const nextSection = allSections[targetIndex + 1];

    let startLine = 0;
    let endLine = lines.length;

    // Find section boundaries
    if (targetSection.heading) {
      const headingPattern = new RegExp(
        `^#{${ targetSection.heading.level }}\\s+${ this._escapeRegex(targetSection.heading.text) }\\s*$`
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
        `^#{${ nextSection.heading.level }}\\s+`
      );
      for (let i = startLine + 1; i < lines.length; i++) {
        if (nextHeadingPattern.test(lines[i])) {
          endLine = i;
          break;
        }
      }
    }

    return lines.slice(startLine, endLine).join("\n").trim();
  }

  // --------------------------------------------------------------------------
  // Parse inline links (not Rich Footnotes)
  //
  // @param {string} content - The task markdown content
  // @returns {Array} - Array of link objects with:
  //   - text: Display text of the link
  //   - url: URL of the link
  //   - raw: The raw markdown link string
  // --------------------------------------------------------------------------
  _parseInlineLinks(content) {
    const links = [];

    // Remove footnote definitions first
    const contentWithoutDefs = content.replace(/\[\^\w+\]:[\s\S]*?(?=\n\[\^|\n#|\n---|$)/g, "");

    // Match markdown links: [text](url)
    const linkPattern = /\[([^\]]+)\]\(([^)]+)\)/g;
    const matches = [...contentWithoutDefs.matchAll(linkPattern)];

    for (const match of matches) {
      // Skip if it's a footnote reference
      if (match[1].startsWith("^")) continue;
      // Skip if it's an image
      if (match[0].startsWith("!")) continue;

      links.push({
        text: match[1],
        url: match[2],
        raw: match[0]
      });
    }

    return links;
  }

  // --------------------------------------------------------------------------
  // Parse Rich Footnotes from task content
  //
  // Rich Footnotes format: [label][^N] with definition [^N]: [label](url)\ndescription\n![](image)
  //
  // @param {string} content - The task markdown content
  // @returns {Array} - Array of footnote objects with:
  //   - id: The footnote ID
  //   - label: The footnote label
  //   - definition: The footnote definition content
  //   - raw: The raw footnote reference string
  // --------------------------------------------------------------------------
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
      const label = ref[1] || "";
      const definition = definitions.get(id) || "";

      footnotes.push({
        id,
        label,
        definition,
        raw: ref[0]
      });
    }

    return footnotes;
  }

  // --------------------------------------------------------------------------
  // Process a single Rich Footnote and extract its contents
  //
  // @param {Object} footnote - The footnote object to process
  // @param {string} footnote.id - The footnote ID
  // @param {string} footnote.label - The footnote label
  // @param {string} footnote.definition - The footnote definition content
  // @returns {Promise<Object>} - Processed footnote with:
  //   - id: The footnote ID
  //   - label: The footnote label
  //   - description: Extracted description text
  //   - images: Array of image objects with alt and url
  //   - links: Array of link objects with text and url
  //   - noteContent: Content from linked notes (if any)
  // --------------------------------------------------------------------------
  async _processFootnote(footnote) {
    const result = {
      id: footnote.id,
      label: footnote.label,
      description: "",
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
      .replace(/!\[[^\]]*\]\([^)]+\)/g, "")
      .replace(/\[[^\]]+\]\([^)]+\)/g, "")
      .replace(/\[[^\]]+\]\(\)/g, "") // Empty link brackets
      .trim();
    result.description = descText;

    // Write to progress note
    await this._documentFootnote(footnote, result);

    return result;
  }

  // --------------------------------------------------------------------------
  // Process a link and retrieve its content based on type
  //
  // @param {Object} link - The link object to process
  // @param {string} link.url - URL of the link
  // @param {string} link.text - Display text of the link
  // @param {string} taskNoteUUID - UUID of the note containing the task
  // @returns {Promise<Object|null>} - Processed link result or null if invalid
  // --------------------------------------------------------------------------
  async _processLink(link, taskNoteUUID) {
    const { url, text } = link;

    // Check if it's an Amplenote note link
    if (url.includes("amplenote.com/notes/")) {
      return await this._processNoteLink(link);
    }

    // Check if it's a task link
    if (url.includes("amplenote.com/notes/tasks/")) {
      return await this._processTaskLink(link);
    }

    // Check if it's a section link within the same note
    if (url.startsWith("#")) {
      return await this._processSectionLink(link, taskNoteUUID);
    }

    // It's an external website link
    return await this._processWebsiteLink(link);
  }

  // --------------------------------------------------------------------------
  // Process a link to an Amplenote note
  //
  // @param {Object} link - The link object to process
  // @param {string} link.url - URL of the Amplenote note
  // @param {string} link.text - Display text of the link
  // @returns {Promise<Object>} - Processed note link with:
  //   - type: "note"
  //   - uuid: UUID of the note
  //   - name: Name of the note
  //   - text: Display text of the link
  //   - content: Content of the note
  //   - tags: Array of tags on the note
  //   - error: Error message if retrieval failed
  // --------------------------------------------------------------------------
  async _processNoteLink(link) {
    const { url, text } = link;

    // Extract note UUID from URL
    const uuidMatch = url.match(/notes\/([a-f0-9-]+)/i);
    if (!uuidMatch) return null;

    const noteUUID = uuidMatch[1];

    try {
      const noteHandle = await this.app.findNote({ uuid: noteUUID });
      if (!noteHandle) {
        return { type: "note", uuid: noteUUID, text, content: null, error: "Note not found" };
      }

      const content = await this.app.getNoteContent({ uuid: noteUUID });

      const result = {
        type: "note",
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
      return { type: "note", uuid: noteUUID, text, content: null, error: error.message };
    }
  }

  // --------------------------------------------------------------------------
  // Process a section link within the same note
  //
  // @param {Object} link - The link object to process
  // @param {string} link.url - Section anchor (starting with #)
  // @param {string} link.text - Display text of the link
  // @param {string} taskNoteUUID - UUID of the note containing the task
  // @returns {Promise<Object|null>} - Processed section link with:
  //   - type: "note"
  //   - uuid: UUID of the note
  //   - section: Section anchor
  //   - sectionTitle: Title of the section
  //   - text: Display text of the link
  //   - content: Content of the section
  // --------------------------------------------------------------------------
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
        type: "note",
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

  // --------------------------------------------------------------------------
  // Process a link to a specific task
  //
  // @param {Object} link - The link object to process
  // @param {string} link.url - URL of the task
  // @param {string} link.text - Display text of the link
  // @returns {Promise<Object>} - Processed task link with:
  //   - type: "task"
  //   - uuid: UUID of the task
  //   - text: Display text of the link
  //   - task: The task object
  //   - content: Content of the task
  //   - noteUUID: UUID of the note containing the task
  //   - error: Error message if retrieval failed
  // --------------------------------------------------------------------------
  async _processTaskLink(link) {
    const { url, text } = link;

    // Extract task UUID from URL
    const uuidMatch = url.match(/tasks\/([a-f0-9-]+)/i);
    if (!uuidMatch) return null;

    const taskUUID = uuidMatch[1];

    try {
      const task = await this.app.getTask(taskUUID);
      if (!task) {
        return { type: "task", uuid: taskUUID, text, task: null, error: "Task not found" };
      }

      const result = {
        type: "task",
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
      return { type: "task", uuid: taskUUID, text, task: null, error: error.message };
    }
  }

  // --------------------------------------------------------------------------
  // Process an external website link
  //
  // @param {Object} link - The link object to process
  // @param {string} link.url - URL of the website
  // @param {string} link.text - Display text of the link
  // @returns {Promise<Object>} - Website link object with:
  //   - type: "website"
  //   - url: URL of the website
  //   - text: Display text of the link
  //   - fetched: Whether the content has been fetched (always false at this stage)
  // --------------------------------------------------------------------------
  async _processWebsiteLink(link) {
    const { url, text } = link;

    // Just record it - actual fetching happens during research phase if needed
    const result = {
      type: "website",
      url,
      text,
      fetched: false
    };

    // Document in progress note
    await this._documentWebsiteLink(result);

    return result;
  }

  // --------------------------------------------------------------------------
  // Write summary of gathered context
  //
  // @param {Object} context - The gathered context object
  // @param {Array} context.footnotes - Array of Rich Footnote objects
  // @param {Array} context.noteLinks - Array of note link objects
  // @param {Array} context.taskLinks - Array of task link objects
  // @param {Array} context.websiteLinks - Array of website link objects
  // @returns {Promise<void>}
  // --------------------------------------------------------------------------
  async _writeSummary(context) {
    let summary = "---\n\n### Gathered Context Summary\n\n";

    const counts = [
      context.footnotes.length > 0 ? `${ context.footnotes.length } Rich Footnotes` : null,
      context.noteLinks.length > 0 ? `${ context.noteLinks.length } linked notes` : null,
      context.taskLinks.length > 0 ? `${ context.taskLinks.length } connected tasks` : null,
      context.websiteLinks.length > 0 ? `${ context.websiteLinks.length } external links` : null,
    ].filter(Boolean);

    if (counts.length > 0) {
      summary += `Found: ${ counts.join(", ") }\n\n`;
    } else {
      summary += "No additional context found in task links or footnotes.\n\n";
    }

    await this.progressNote.appendUnderHeading(
      "Collect Rich Footnotes & other task context",
      summary,
      1
    );
  }
}

export default PhaseGather;
