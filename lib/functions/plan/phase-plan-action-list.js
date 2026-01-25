// --------------------------------------------------------------------------
// PhasePlanActionList - Calls LLM to interpret gathered evidence and plan actions
//
// This phase:
// 1. Analyzes the gathered context from the gather phase
// 2. Determines if user prompting is needed for clarification
// 3. Creates a list of actionable items the TaskAgent can execute
// --------------------------------------------------------------------------

export class PhasePlanActionList {
  // Action types the TaskAgent supports
  static ACTION_TYPES = {
    RESEARCH: "research",
    EMAIL: "email",
    PLAN: "plan",
    JIRA: "jira"
  };

  constructor(app, plugin, progressNote) {
    this.app = app;
    this.plugin = plugin;
    this.progressNote = progressNote;
  }

  // --------------------------------------------------------------------------
  // Execute the planning phase
  //
  // @param {string} taskContent - Original task content
  // @param {Object} gatheredContext - Context from the gather phase
  // @param {Array} gatheredContext.footnotes - Array of Rich Footnote objects
  // @param {Array} gatheredContext.noteLinks - Array of linked note objects
  // @param {Array} gatheredContext.taskLinks - Array of task link objects
  // @param {Array} gatheredContext.websiteLinks - Array of website link objects
  // @param {string} gatheredContext.plainText - Plain text extracted from task
  // @returns {Promise<Object>} - Plan result with:
  //   - needsUserInput: Whether user clarification is required
  //   - questions: Array of question objects if needsUserInput is true
  //   - actionItems: Array of action item objects
  //   - llmCallsMade: Number of LLM calls made
  // --------------------------------------------------------------------------
  async execute(taskContent, gatheredContext) {
    const prompt = this._buildPlanningPrompt(taskContent, gatheredContext);

    // Call LLM
    const response = await this.plugin.llm(prompt);

    // Parse LLM response
    const parsedResponse = this._parseLLMResponse(response);

    return {
      needsUserInput: parsedResponse.needsUserInput,
      questions: parsedResponse.questions || [],
      actionItems: parsedResponse.actionItems || [],
      llmCallsMade: 1
    };
  }

  // --------------------------------------------------------------------------
  // Re-execute planning with user input
  //
  // @param {string} taskContent - Original task content
  // @param {Object} gatheredContext - Context from gather phase
  // @param {Object} userResponses - User's answers to clarifying questions
  //   Keys are question strings, values are user responses
  // @returns {Promise<Object>} - Revised plan with:
  //   - actionItems: Array of action item objects
  //   - llmCallsMade: Number of LLM calls made
  // --------------------------------------------------------------------------
  async executeWithUserInput(taskContent, gatheredContext, userResponses) {
    const prompt = this._buildRefinedPlanningPrompt(taskContent, gatheredContext, userResponses);

    // Call LLM
    const response = await this.plugin.llm(prompt);

    // Parse LLM response
    const parsedResponse = this._parseLLMResponse(response);

    // Record the clarification in progress note
    await this._documentUserClarifications(userResponses);

    return {
      actionItems: parsedResponse.actionItems || [],
      llmCallsMade: 1
    };
  }

  // --------------------------------------------------------------------------
  // Local helpers
  // --------------------------------------------------------------------------

  // --------------------------------------------------------------------------
  // Build the initial planning prompt for the LLM
  //
  // @param {string} taskContent - Original task content
  // @param {Object} gatheredContext - Context from the gather phase
  // @returns {string} - The formatted prompt for the LLM
  // --------------------------------------------------------------------------
  _buildPlanningPrompt(taskContent, gatheredContext) {
    const contextSummary = this._formatContextForPrompt(gatheredContext);

    return `You are a task analysis assistant helping a user make progress on their todo item. Analyze the following task and its associated context to determine the best course of action.

## Original Task
${ taskContent }

## Gathered Context
${ contextSummary }

## Available Actions
The TaskAgent can perform these actions:
1. **research** - Research a topic by searching the user's notes and the web. Use for:
   - Clarifying unclear aspects of the task
   - Gathering background information
   - Producing a document with data on a subject
   
2. **email** - Create a mailto: link to compose an email. Use when the task involves:
   - Communicating with someone
   - Sending information or requests
   
3. **plan** - Create a detailed action plan with phases. Use when the task:
   - Is complex with multiple steps
   - Requires coordination of multiple activities
   - Benefits from a structured approach
   
4. **jira** - Create a Jira ticket link. Use when the task:
   - Involves development work
   - Needs to be tracked in a project management system

## Your Task
Analyze this task and respond in JSON format with the following structure:

\`\`\`json
{
  "taskAnalysis": "Brief analysis of what the task is asking for",
  "needsUserInput": true/false,
  "questions": [
    {
      "question": "The clarifying question to ask",
      "type": "string|text|select",
      "options": ["option1", "option2"]  // Only if type is "select"
    }
  ],
  "actionItems": [
    {
      "type": "research|email|plan|jira",
      "title": "Short title for this action",
      "description": "What this action will accomplish",
      "params": {
        // Type-specific parameters
      }
    }
  ]
}
\`\`\`

Set "needsUserInput" to true ONLY if:
- The task uses acronyms or terms that are unclear
- Critical information is missing (like recipient email, project name)
- The goal is ambiguous and multiple interpretations exist

For research actions, params should include:
- "query": The research query/topic
- "purpose": "clarify" | "gather_info" | "produce_document"

For email actions, params should include:
- "to": Recipient email (or "ASK_USER" if unknown)
- "subject": Email subject
- "bodyOutline": Key points for the email body

For plan actions, params should include:
- "goalSummary": What the plan aims to achieve
- "suggestedPhases": Array of phase names

For jira actions, params should include:
- "summary": Ticket summary
- "descriptionOutline": Key points for description

Important: Only include actions that will meaningfully help complete this task. Don't add unnecessary actions.`;
  }

  // --------------------------------------------------------------------------
  // Build refined planning prompt after user input
  //
  // @param {string} taskContent - Original task content
  // @param {Object} gatheredContext - Context from gather phase
  // @param {Object} userResponses - User's answers to clarifying questions
  // @returns {string} - The formatted prompt for the LLM
  // --------------------------------------------------------------------------
  _buildRefinedPlanningPrompt(taskContent, gatheredContext, userResponses) {
    const contextSummary = this._formatContextForPrompt(gatheredContext);
    const clarifications = this._formatUserResponses(userResponses);

    return `You are a task analysis assistant. The user has provided clarifications for a task. Now create a concrete action plan.

## Original Task
${ taskContent }

## Gathered Context
${ contextSummary }

## User Clarifications
${ clarifications }

## Available Actions
- **research**: Research topics by searching notes and web
- **email**: Create mailto: links for composing emails
- **plan**: Create detailed multi-phase action plans
- **jira**: Create Jira ticket links

## Your Task
Based on the clarifications provided, create a specific action plan. Respond in JSON format:

\`\`\`json
{
  "taskAnalysis": "Updated analysis incorporating user clarifications",
  "actionItems": [
    {
      "type": "research|email|plan|jira",
      "title": "Short title for this action",
      "description": "What this action will accomplish",
      "params": {
        // Type-specific parameters
      }
    }
  ]
}
\`\`\`

Create concrete, actionable items based on the user's input. Include all necessary details.`;
  }

  // --------------------------------------------------------------------------
  // Document user clarifications in the progress note
  //
  // @param {Object} userResponses - User's answers to clarifying questions
  //   Keys are question strings, values are user responses
  // @returns {Promise<void>}
  // --------------------------------------------------------------------------
  async _documentUserClarifications(userResponses) {
    let content = "# What to clarify with the user\n\n";

    for (const [question, answer] of Object.entries(userResponses)) {
      content += `**Q:** ${ question }\n**A:** ${ answer }\n\n`;
    }

    await this.progressNote.appendUnderHeading("What to clarify with the user", content, 1);
  }

  // --------------------------------------------------------------------------
  // Fallback parsing when JSON parsing fails
  //
  // @param {string} response - The LLM response text
  // @returns {Object} - Parsed result with:
  //   - needsUserInput: Whether user input is needed
  //   - questions: Array of question objects
  //   - actionItems: Array of action item objects
  // --------------------------------------------------------------------------
  _fallbackParsing(response) {
    const result = {
      needsUserInput: false,
      questions: [],
      actionItems: []
    };

    // Look for action keywords
    const lowerResponse = response.toLowerCase();

    if (lowerResponse.includes("research") || lowerResponse.includes("investigate")) {
      result.actionItems.push({
        type: "research",
        title: "Research task context",
        description: "Gather more information about the task",
        params: { query: "task context", purpose: "gather_info" }
      });
    }

    if (lowerResponse.includes("email") || lowerResponse.includes("message")) {
      result.actionItems.push({
        type: "email",
        title: "Draft communication",
        description: "Compose an email related to the task",
        params: { to: "ASK_USER", subject: "Task-related", bodyOutline: [] }
      });
      result.needsUserInput = true;
      result.questions.push({
        question: "Who should receive this email?",
        type: "string"
      });
    }

    if (lowerResponse.includes("plan") || lowerResponse.includes("steps")) {
      result.actionItems.push({
        type: "plan",
        title: "Create action plan",
        description: "Break down the task into manageable steps",
        params: { goalSummary: "Complete the task", suggestedPhases: [] }
      });
    }

    // If no actions detected, default to research
    if (result.actionItems.length === 0) {
      result.actionItems.push({
        type: "research",
        title: "Analyze task requirements",
        description: "Research to better understand task requirements",
        params: { query: "task requirements", purpose: "clarify" }
      });
    }

    return result;
  }

  // --------------------------------------------------------------------------
  // Format gathered context for the prompt
  //
  // @param {Object} gatheredContext - Context from the gather phase
  // @param {string} gatheredContext.plainText - Plain text from task
  // @param {Array} gatheredContext.footnotes - Array of Rich Footnote objects
  // @param {Array} gatheredContext.noteLinks - Array of linked note objects
  // @param {Array} gatheredContext.taskLinks - Array of task link objects
  // @param {Array} gatheredContext.websiteLinks - Array of website link objects
  // @returns {string} - Formatted context summary for the prompt
  // --------------------------------------------------------------------------
  _formatContextForPrompt(gatheredContext) {
    const parts = [];

    // Plain text summary
    if (gatheredContext.plainText) {
      parts.push(`**Task Text:** ${ gatheredContext.plainText }`);
    }

    // Rich Footnotes
    if (gatheredContext.footnotes?.length > 0) {
      parts.push("\n**Rich Footnotes:**");
      for (const footnote of gatheredContext.footnotes) {
        let footnoteDescription = `- "${ footnote.label }": ${ footnote.description || "(no description)" }`;
        if (footnote.images?.length > 0) {
          footnoteDescription += ` [contains ${ footnote.images.length } image(s)]`;
        }
        if (footnote.links?.length > 0) {
          footnoteDescription += ` [contains ${ footnote.links.length } link(s)]`;
        }
        parts.push(footnoteDescription);
      }
    }

    // Linked notes
    if (gatheredContext.noteLinks?.length > 0) {
      parts.push("\n**Linked Notes:**");
      for (const note of gatheredContext.noteLinks) {
        const preview = note.content ?
          note.content.substring(0, 200).replace(/\n/g, " ") + "..." :
          "(content unavailable)";
        parts.push(`- "${ note.name }": ${ preview }`);
      }
    }

    // Connected tasks
    if (gatheredContext.taskLinks?.length > 0) {
      parts.push("\n**Connected Tasks:**");
      for (const task of gatheredContext.taskLinks) {
        parts.push(`- ${ task.content }`);
      }
    }

    // External links
    if (gatheredContext.websiteLinks?.length > 0) {
      parts.push("\n**External Links:**");
      for (const link of gatheredContext.websiteLinks) {
        parts.push(`- [${ link.text }](${ link.url })`);
      }
    }

    return parts.join("\n");
  }

  // --------------------------------------------------------------------------
  // Format user responses for the prompt
  //
  // @param {Object} userResponses - User's answers to clarifying questions
  //   Keys are question strings, values are user responses
  // @returns {string} - Formatted Q&A pairs for the prompt
  // --------------------------------------------------------------------------
  _formatUserResponses(userResponses) {
    const parts = [];
    for (const [question, answer] of Object.entries(userResponses)) {
      parts.push(`Q: ${ question }\nA: ${ answer }`);
    }
    return parts.join("\n\n");
  }

  // --------------------------------------------------------------------------
  // Parse the LLM response into structured data
  //
  // @param {string} response - The raw LLM response
  // @returns {Object} - Parsed response with:
  //   - taskAnalysis: Analysis of the task
  //   - needsUserInput: Whether user input is needed
  //   - questions: Array of question objects
  //   - actionItems: Array of action item objects
  // --------------------------------------------------------------------------
  _parseLLMResponse(response) {
    try {
      // Extract JSON from response
      const jsonMatch = response.match(/```json\s*([\s\S]*?)\s*```/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[1]);
      }

      // Try parsing the whole response as JSON
      return JSON.parse(response);

    } catch (error) {
      console.error("Failed to parse LLM response:", error);

      // Fallback: try to extract meaningful actions from text
      return this._fallbackParsing(response);
    }
  }
}

export default PhasePlanActionList;
