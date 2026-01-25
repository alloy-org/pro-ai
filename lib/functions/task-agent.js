// --------------------------------------------------------------------------
// TaskAgent - An agentic AI system for helping users progress on Amplenote tasks
//
// This class manages the state for the task agent's progress and handles directing
// agent progress to the AgentProgressNote. It follows patterns from the AmpleAI SearchAgent.
// --------------------------------------------------------------------------
import AgentProgressNote from "functions/plan/agent-progress-note"
import PhaseGather from "functions/plan/phase-gather"
import PhasePlanActionList from "functions/plan/phase-plan-action-list"
import PhasePromptUser from "functions/plan/phase-prompt-user"
import AgentResearcher from "functions/plan/actions/agent-researcher"
import AgentEmailer from "functions/plan/actions/agent-emailer"
import AgentPlanMaker from "functions/plan/agent-plan-maker"
import AgentJiraWriter from "functions/plan/actions/agent-jira-writer"

// --------------------------------------------------------------------------
export class TaskAgent {
  static PROGRESS_NOTE_TAG = "plugins/task-agent";
  static MAX_LLM_CALLS = 5;

  // --------------------------------------------------------------------------
  constructor(app, plugin) {
    this.app = app;
    this.plugin = plugin;

    // Agent state
    this.taskUUID = null;
    this.taskContent = null;
    this.taskNoteUUID = null;
    this.progressNoteUUID = null;
    this.progressNote = null;

    // Tracking
    this.llmCallCount = 0;
    this.gatheredContext = {};
    this.actionItems = [];
    this.userResponses = {};
    this.isRunning = false;
  }

  // --------------------------------------------------------------------------
  // Main entry point - starts the agent to work on a task
  //
  // @param {string} taskUUID - The UUID of the task to work on
  // @returns {Promise<string>} - UUID of the progress note
  // --------------------------------------------------------------------------
  async run(taskUUID) {
    if (this.isRunning) {
      throw new Error("TaskAgent is already running");
    }

    this.isRunning = true;

    try {
      // 1. Load the task
      await this._loadTask(taskUUID);

      // 2. Create the progress note
      await this._createProgressNote();

      // 3. Phase: Gather context from Rich Footnotes and links
      await this._executeGatherPhase();

      // 4. Phase: Plan action list (may prompt user)
      await this._executePlanPhase();

      // 5. Execute action items
      await this._executeActionItems();

      // 6. Link progress note back to original task
      await this._linkProgressNoteToTask();

      return this.progressNoteUUID;

    } catch (error) {
      await this._logError(error);
      throw error;
    } finally {
      this.isRunning = false;
    }
  }

  // --------------------------------------------------------------------------
  // Call LLM with tracking
  //
  // @param {string} query - The prompt to send to the LLM
  // @returns {Promise<string>} - The LLM response
  // @throws {Error} - If LLM call limit has been reached
  // --------------------------------------------------------------------------
  async callLLM(query) {
    if (this.llmCallCount >= TaskAgent.MAX_LLM_CALLS) {
      throw new Error(`LLM call limit (${ TaskAgent.MAX_LLM_CALLS }) reached`);
    }

    this.llmCallCount++;
    console.log(`TaskAgent: LLM call #${ this.llmCallCount }: ${ query.substring(0, 100) }...`);

    return await this.plugin.llm(query);
  }

  // --------------------------------------------------------------------------
  // Local helpers
  // --------------------------------------------------------------------------

  // --------------------------------------------------------------------------
  // Load the task and extract its content
  //
  // @param {string} taskUUID - The UUID of the task to load
  // @returns {Promise<void>}
  // @throws {Error} - If task is not found
  // --------------------------------------------------------------------------
  async _loadTask(taskUUID) {
    this.taskUUID = taskUUID;
    const task = await this.app.getTask(taskUUID);

    if (!task) {
      throw new Error(`Task not found: ${ taskUUID }`);
    }

    this.taskContent = task.content;
    this.taskNoteUUID = task.noteUUID;

    console.log(`TaskAgent: Loaded task "${ this._summarizeTaskText(this.taskContent) }"`);
  }

  // --------------------------------------------------------------------------
  // Create the AgentProgressNote to track progress
  //
  // @returns {Promise<void>}
  // --------------------------------------------------------------------------
  async _createProgressNote() {
    const today = new Date().toLocaleDateString("en-US", {
      year: "numeric",
      month: "long",
      day: "numeric"
    });

    const taskSummary = this._summarizeTaskText(this.taskContent);
    const noteName = `TaskAgent progress on "${ taskSummary }" from ${ today }`;

    this.progressNoteUUID = await this.app.createNote(noteName, [TaskAgent.PROGRESS_NOTE_TAG]);

    this.progressNote = new AgentProgressNote(this.app, this.progressNoteUUID);

    // Initialize with header section
    const initialContent = `# Task Overview

**Original Task:**
${ this.taskContent }

---

`;
    await this.progressNote.appendSection("Task Overview", initialContent);

    console.log(`TaskAgent: Created progress note "${ noteName }"`);
  }

  // --------------------------------------------------------------------------
  // Document action items in the progress note
  //
  // @returns {Promise<void>}
  // --------------------------------------------------------------------------
  async _documentActionItems() {
    let content = "# Action Items\n\n";

    for (let i = 0; i < this.actionItems.length; i++) {
      const item = this.actionItems[i];
      content += `- [ ] **${ item.title }**\n`;
      if (item.description) {
        content += `  ${ item.description }\n`;
      }
      content += "\n";
    }

    await this.progressNote.appendSection("Action Items", content);
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
  // Execute a single action item
  //
  // @param {Object} actionItem - The action item to execute
  // @param {string} actionItem.type - The type of action: "research", "email", "plan", or "jira"
  // @param {Object} actionItem.params - Parameters specific to the action type
  // @returns {Promise<Object>} - Result object with llmCallsMade and action-specific data
  // @throws {Error} - If action type is unknown
  // --------------------------------------------------------------------------
  async _executeAction(actionItem) {
    const { type, params } = actionItem;

    switch (type) {
      case "research":
        const researcher = new AgentResearcher(this.app, this.plugin, this.progressNote);
        return await researcher.execute(params);

      case "email":
        const emailer = new AgentEmailer(this.app, this.progressNote);
        return await emailer.execute(params);

      case "plan":
        const planMaker = new AgentPlanMaker(this.app, this.plugin, this.progressNote);
        return await planMaker.execute(params);

      case "jira":
        const jiraWriter = new AgentJiraWriter(this.app, this.progressNote);
        return await jiraWriter.execute(params);

      default:
        throw new Error(`Unknown action type: ${ type }`);
    }
  }

  // --------------------------------------------------------------------------
  // Execute each action item
  //
  // @returns {Promise<void>}
  // --------------------------------------------------------------------------
  async _executeActionItems() {
    for (let i = 0; i < this.actionItems.length; i++) {
      const actionItem = this.actionItems[i];

      if (this.llmCallCount >= TaskAgent.MAX_LLM_CALLS) {
        await this.progressNote.appendSection(
          "Notice",
          `\n\n> ⚠️ Reached maximum LLM call limit (${ TaskAgent.MAX_LLM_CALLS }). Some actions may be incomplete.\n`
        );
        break;
      }

      try {
        const result = await this._executeAction(actionItem);
        this.llmCallCount += result.llmCallsMade || 0;

        // Mark action as complete in progress note
        await this._markActionComplete(i, actionItem, result);

      } catch (error) {
        await this._markActionFailed(i, actionItem, error);
      }
    }
  }

  // --------------------------------------------------------------------------
  // Execute the gather phase to collect Rich Footnotes and other context
  //
  // @returns {Promise<void>}
  // --------------------------------------------------------------------------
  async _executeGatherPhase() {
    const gatherPhase = new PhaseGather(this.app, this.progressNote);
    this.gatheredContext = await gatherPhase.execute(this.taskContent, this.taskNoteUUID);

    console.log(`TaskAgent: Gathered ${ Object.keys(this.gatheredContext).length } context items`);
  }

  // --------------------------------------------------------------------------
  // Execute the planning phase to determine action items
  //
  // @returns {Promise<void>}
  // --------------------------------------------------------------------------
  async _executePlanPhase() {
    const planPhase = new PhasePlanActionList(this.app, this.plugin, this.progressNote);

    // This may call LLM
    const planResult = await planPhase.execute(this.taskContent, this.gatheredContext);
    this.llmCallCount += planResult.llmCallsMade || 0;

    // Check if user prompting is needed
    if (planResult.needsUserInput) {
      const promptPhase = new PhasePromptUser(this.app);
      this.userResponses = await promptPhase.execute(planResult.questions);

      // Re-plan with user responses
      const revisedPlan = await planPhase.executeWithUserInput(
        this.taskContent,
        this.gatheredContext,
        this.userResponses
      );
      this.llmCallCount += revisedPlan.llmCallsMade || 0;
      this.actionItems = revisedPlan.actionItems;
    } else {
      this.actionItems = planResult.actionItems;
    }

    // Document action items in progress note
    await this._documentActionItems();

    console.log(`TaskAgent: Planned ${ this.actionItems.length } action items`);
  }

  // --------------------------------------------------------------------------
  // Link the progress note back to the original task
  //
  // @returns {Promise<void>}
  // --------------------------------------------------------------------------
  async _linkProgressNoteToTask() {
    const progressNoteURL = await this.app.getNoteURL({ uuid: this.progressNoteUUID });

    // Append link to task content
    const updatedContent = `${ this.taskContent }\n\n[View TaskAgent Progress](${ progressNoteURL })`;

    await this.app.updateTask(this.taskUUID, { content: updatedContent });

    console.log("TaskAgent: Linked progress note to task");
  }

  // --------------------------------------------------------------------------
  // Log an error to the progress note
  //
  // @param {Error} error - The error to log
  // @param {string} error.message - The error message
  // @param {string} error.stack - The error stack trace
  // @returns {Promise<void>}
  // --------------------------------------------------------------------------
  async _logError(error) {
    if (this.progressNote) {
      await this.progressNote.appendSection(
        "Errors",
        `\n# Error\n\n> ❌ ${ error.message }\n\n\`\`\`\n${ error.stack }\n\`\`\`\n`
      );
    }
    console.error("TaskAgent error:", error);
  }

  // --------------------------------------------------------------------------
  // Mark an action item as complete
  //
  // @param {number} index - The index of the action item in the actionItems array
  // @param {Object} actionItem - The action item that was completed
  // @param {string} actionItem.title - The title of the action item
  // @param {Object} result - The result of executing the action
  // @param {string} result.summary - Optional summary of what was accomplished
  // @returns {Promise<void>}
  // --------------------------------------------------------------------------
  async _markActionComplete(index, actionItem, result) {
    const sectionContent = await this.progressNote.getSectionContent("Action Items");

    // Replace unchecked checkbox with checked
    const pattern = new RegExp(`- \\[ \\] \\*\\*${ this._escapeRegex(actionItem.title) }\\*\\*`);
    const newContent = sectionContent.replace(pattern, `- [x] **${ actionItem.title }**`);

    await this.progressNote.replaceSection("Action Items", newContent);

    // Add result details if present
    if (result.summary) {
      await this.progressNote.appendSection(
        "Action Items",
        `\n  ✓ *Completed:* ${ result.summary }\n`
      );
    }
  }

  // --------------------------------------------------------------------------
  // Mark an action item as failed
  //
  // @param {number} index - The index of the action item in the actionItems array
  // @param {Object} actionItem - The action item that failed
  // @param {string} actionItem.title - The title of the action item
  // @param {Error} error - The error that caused the failure
  // @param {string} error.message - The error message
  // @returns {Promise<void>}
  // --------------------------------------------------------------------------
  async _markActionFailed(index, actionItem, error) {
    const sectionContent = await this.progressNote.getSectionContent("Action Items");

    // Replace unchecked checkbox with failed marker
    const pattern = new RegExp(`- \\[ \\] \\*\\*${ this._escapeRegex(actionItem.title) }\\*\\*`);
    const newContent = sectionContent.replace(pattern, `- [-] **${ actionItem.title }** ❌`);

    await this.progressNote.replaceSection("Action Items", newContent);

    await this.progressNote.appendSection(
      "Action Items",
      `\n  ⚠️ *Failed:* ${ error.message }\n`
    );
  }

  // --------------------------------------------------------------------------
  // Summarize task text for display
  //
  // @param {string} content - The task content to summarize
  // @param {number} maxLength - Maximum length of the summary (default: 50)
  // @returns {string} - The summarized text, truncated with "..." if needed
  // --------------------------------------------------------------------------
  _summarizeTaskText(content, maxLength = 50) {
    // Strip Rich Footnotes and markdown formatting for summary
    const plainText = content
      .replace(/\[\^[^\]]+\](:.*)?/g, "") // Remove footnotes
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1") // Extract link text
      .replace(/[*_`#]/g, "") // Remove formatting
      .trim();

    if (plainText.length <= maxLength) {
      return plainText;
    }

    return plainText.substring(0, maxLength - 3) + "...";
  }
}

export default TaskAgent;
