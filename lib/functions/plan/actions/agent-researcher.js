/**
 * AgentResearcher - Handles "Research a topic" action
 *
 * This action:
 * 1. Triggers AI search agent to collect relevant notes from user's notebook
 * 2. Uses LLM to provide its own knowledge about the topic
 * 3. Creates a note with findings when the goal is to produce a document
 *
 * Research purposes:
 * - "clarify": Clarify what is being asked by the task
 * - "gather_info": Interpret how to make progress on a well-understood task
 * - "produce_document": Create a document with data on a subject
 */

export class AgentResearcher {
  constructor(app, plugin, progressNote) {
    this.app = app;
    this.plugin = plugin;
    this.progressNote = progressNote;
  }

  /**
   * Execute the research action
   * @param {Object} params - Research parameters
   * @param {string} params.query - The research query/topic
   * @param {string} params.purpose - Purpose: 'clarify', 'gather_info', 'produce_document'
   * @param {string} params.outputNoteName - Optional name for output note
   * @returns {Promise<Object>} - Research results
   */
  async execute(params) {
    const { query, purpose = 'gather_info', outputNoteName } = params;

    // Document research start
    await this._documentResearchStart(query, purpose);

    const results = {
      noteSearchResults: [],
      llmKnowledge: null,
      outputNoteUUID: null,
      summary: '',
      llmCallsMade: 0
    };

    // 1. Search user's notes via AI search agent
    try {
      const noteResults = await this._searchNotes(query);
      results.noteSearchResults = noteResults;
      await this._documentNoteSearchResults(noteResults);
    } catch (error) {
      console.error('Note search failed:', error);
      await this._documentError('Note search', error);
    }

    // 2. Get LLM's knowledge about the topic
    try {
      const llmResponse = await this._getLLMKnowledge(query, purpose, results.noteSearchResults);
      results.llmKnowledge = llmResponse;
      results.llmCallsMade = 1;
      await this._documentLLMKnowledge(llmResponse);
    } catch (error) {
      console.error('LLM knowledge retrieval failed:', error);
      await this._documentError('LLM knowledge', error);
    }

    // 3. If purpose is to produce a document, create output note
    if (purpose === 'produce_document') {
      try {
        const noteUUID = await this._createOutputNote(
          query,
          results.noteSearchResults,
          results.llmKnowledge,
          outputNoteName
        );
        results.outputNoteUUID = noteUUID;
        await this._documentOutputNote(noteUUID);
      } catch (error) {
        console.error('Output note creation failed:', error);
        await this._documentError('Output note creation', error);
      }
    }

    // Generate summary
    results.summary = this._generateSummary(results);

    return results;
  }

  /**
   * Search user's notes using the AI search agent
   */
  async _searchNotes(query) {
    // Check if searchAgent is available on plugin
    if (this.plugin.searchAgent?.search) {
      try {
        const searchResult = await this.plugin.searchAgent.search(query, {
          options: { resultCount: 20 }
        });

        // searchAgent.search returns a result note with links
        // Parse the results and retrieve content from relevant notes
        return await this._processSearchResults(searchResult);

      } catch (error) {
        console.warn('SearchAgent not available, falling back to app.searchNotes:', error);
      }
    }

    // Fallback: use app.searchNotes
    const noteHandles = await this.app.searchNotes(query);
    const results = [];

    // Limit to top 10 results
    for (let i = 0; i < Math.min(noteHandles.length, 10); i++) {
      const handle = noteHandles[i];
      try {
        const content = await this.app.getNoteContent(handle);
        const noteInfo = await this.app.findNote(handle);

        results.push({
          uuid: handle.uuid,
          name: noteInfo?.name || 'Untitled',
          tags: noteInfo?.tags || [],
          content: content,
          relevanceScore: 1 - (i * 0.1) // Approximate relevance
        });
      } catch (err) {
        // Skip notes that can't be read
      }
    }

    return results;
  }

  /**
   * Process search results from searchAgent
   */
  async _processSearchResults(searchResult) {
    const results = [];

    // searchAgent typically returns a note with links to relevant notes
    // Parse the result to extract note references
    if (typeof searchResult === 'string') {
      // Extract note links from markdown
      const linkPattern = /\[([^\]]+)\]\(https:\/\/www\.amplenote\.com\/notes\/([a-f0-9-]+)\)/gi;
      const matches = [...searchResult.matchAll(linkPattern)];

      for (const match of matches) {
        const [, name, uuid] = match;
        try {
          const content = await this.app.getNoteContent({ uuid });
          const noteInfo = await this.app.findNote({ uuid });

          results.push({
            uuid,
            name: noteInfo?.name || name,
            tags: noteInfo?.tags || [],
            content,
            relevanceScore: 0.8
          });
        } catch (err) {
          // Skip notes that can't be read
        }
      }
    } else if (searchResult?.noteUUID) {
      // searchAgent returned a note UUID
      const resultNoteContent = await this.app.getNoteContent({ uuid: searchResult.noteUUID });
      return await this._processSearchResults(resultNoteContent);
    }

    return results;
  }

  /**
   * Get LLM's knowledge about the topic
   */
  async _getLLMKnowledge(query, purpose, noteResults) {
    const noteContext = noteResults
      .slice(0, 5) // Use top 5 notes for context
      .map(n => `**${n.name}:**\n${n.content?.substring(0, 500)}...`)
      .join('\n\n');

    const purposeInstructions = {
      clarify: `The goal is to clarify what the user means by "${query}". 
        Provide definitions, context, and help interpret the request.`,
      gather_info: `The goal is to gather information about "${query}" to help complete a task.
        Provide practical, actionable information.`,
      produce_document: `The goal is to help the user produce a document about "${query}".
        Provide comprehensive information organized for inclusion in a document.`
    };

    const prompt = `You are a research assistant helping a user understand and make progress on a topic.

## Research Query
${query}

## Purpose
${purposeInstructions[purpose] || purposeInstructions.gather_info}

## User's Notes on This Topic
${noteContext || 'No relevant notes found in the user\'s notebook.'}

## Your Task
Provide your knowledge about this topic that would be helpful for the user. 
Include:
1. Key concepts and definitions
2. Important considerations
3. Practical recommendations
4. Any caveats or warnings

If this involves web research, note that you should include LINKS and CITATIONS to validate conclusions, as humans are naturally skeptical of information without sources.

Format your response in clear markdown with appropriate headings.`;

    return await this.plugin.llm(prompt);
  }

  /**
   * Create an output note with research findings
   */
  async _createOutputNote(query, noteResults, llmKnowledge, customName) {
    const today = new Date().toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    });

    const noteName = customName || `Research: ${query} (${today})`;

    // Create the note
    const noteUUID = await this.app.createNote(noteName, ['research', 'task-agent']);

    // Build content
    let content = `# Research: ${query}\n\n`;
    content += `*Generated by TaskAgent on ${today}*\n\n`;
    content += `---\n\n`;

    // LLM Knowledge section
    if (llmKnowledge) {
      content += `## Analysis & Insights\n\n`;
      content += llmKnowledge + '\n\n';
    }

    // Related notes section
    if (noteResults.length > 0) {
      content += `## Related Notes from Your Notebook\n\n`;
      for (const note of noteResults.slice(0, 10)) {
        const noteURL = await this.app.getNoteURL({ uuid: note.uuid });
        content += `### [${note.name}](${noteURL})\n\n`;

        if (note.tags?.length > 0) {
          content += `*Tags: ${note.tags.join(', ')}*\n\n`;
        }

        // Include excerpt
        const excerpt = note.content?.substring(0, 300)?.replace(/\n/g, ' ') || '';
        content += `> ${excerpt}...\n\n`;
      }
    }

    // Write content to note
    await this.app.insertNoteContent({ uuid: noteUUID }, content);

    return noteUUID;
  }

  /**
   * Document research start in progress note
   */
  async _documentResearchStart(query, purpose) {
    const purposeDescriptions = {
      clarify: 'clarify the task requirements',
      gather_info: 'gather information for task progress',
      produce_document: 'produce a comprehensive document'
    };

    const content = `\n## Research: "${query}"\n\n`;
    const purposeText = `**Purpose:** ${purposeDescriptions[purpose] || purpose}\n\n`;

    await this.progressNote.appendUnderHeading('Action Items', content + purposeText, 1);
  }

  /**
   * Document note search results
   */
  async _documentNoteSearchResults(noteResults) {
    let content = `**Notes Found:** ${noteResults.length}\n\n`;

    if (noteResults.length > 0) {
      content += `Relevant notes from your notebook:\n`;
      for (const note of noteResults.slice(0, 5)) {
        const noteLink = await this.progressNote.createNoteLink(note.uuid, note.name);
        content += `- ${noteLink}\n`;
      }
      content += '\n';
    }

    await this.progressNote.appendUnderHeading('Action Items', content, 1);
  }

  /**
   * Document LLM knowledge response
   */
  async _documentLLMKnowledge(llmResponse) {
    const preview = llmResponse?.substring(0, 300)?.replace(/\n/g, ' ') || '';
    const content = `**Research Insights:** ${preview}...\n\n`;

    await this.progressNote.appendUnderHeading('Action Items', content, 1);
  }

  /**
   * Document output note creation
   */
  async _documentOutputNote(noteUUID) {
    const noteURL = await this.app.getNoteURL({ uuid: noteUUID });
    const content = `**Research Document Created:** [View Document](${noteURL})\n\n`;

    await this.progressNote.appendUnderHeading('Action Items', content, 1);
  }

  /**
   * Document an error
   */
  async _documentError(context, error) {
    const content = `⚠️ *${context} failed: ${error.message}*\n\n`;
    await this.progressNote.appendUnderHeading('Action Items', content, 1);
  }

  /**
   * Generate a summary of the research results
   */
  _generateSummary(results) {
    const parts = [];

    if (results.noteSearchResults.length > 0) {
      parts.push(`Found ${results.noteSearchResults.length} relevant notes`);
    }

    if (results.llmKnowledge) {
      parts.push('gathered AI insights');
    }

    if (results.outputNoteUUID) {
      parts.push('created research document');
    }

    return parts.length > 0 ?
      `Research completed: ${parts.join(', ')}` :
      'Research completed with no results';
  }
}

export default AgentResearcher;
