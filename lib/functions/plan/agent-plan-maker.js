// --------------------------------------------------------------------------
// AgentPlanMaker - Handles "Make a plan" action
//
// Creates a note with multiple phases/sections designed for the user to browse
// through the evidence gathered by the LLM. Unlike "Research", this action
// focuses on creating specific, actionable phases necessary to finish the task.
//
// Each phase section contains:
// - Pending tasks
// - Completed tasks (as progress is made)
// --------------------------------------------------------------------------

export class AgentPlanMaker {
  constructor(app, plugin, progressNote) {
    this.app = app;
    this.plugin = plugin;
    this.progressNote = progressNote;
  }

  // --------------------------------------------------------------------------
  // Execute the plan-making action
  //
  // @param {Object} params - Plan parameters
  // @param {string} params.goalSummary - What the plan aims to achieve
  // @param {Array} params.suggestedPhases - Optional suggested phase names
  // @param {Object} params.context - Additional context for planning
  // @param {string} params.taskContent - Original task content
  // @returns {Promise<Object>} - Result object containing:
  //   - planNoteUUID: UUID of the created plan note
  //   - phases: Array of phase objects
  //   - summary: Description of what was created
  //   - llmCallsMade: Number of LLM calls made
  // --------------------------------------------------------------------------
  async execute(params) {
    const { context, goalSummary, suggestedPhases, taskContent } = params;

    const results = {
      planNoteUUID: null,
      phases: [],
      summary: "",
      llmCallsMade: 0
    };

    // Generate plan structure via LLM
    const planStructure = await this._generatePlanStructure(goalSummary, suggestedPhases, context, taskContent);
    results.phases = planStructure.phases;
    results.llmCallsMade = 1;

    // Create the plan note
    const noteUUID = await this._createPlanNote(goalSummary, planStructure);
    results.planNoteUUID = noteUUID;

    // Document in progress note
    await this._documentPlan(goalSummary, planStructure, noteUUID);

    results.summary = `Created plan with ${ planStructure.phases.length } phases`;

    return results;
  }

  // --------------------------------------------------------------------------
  // Update a phase's task status in the plan note
  //
  // @param {string} planNoteUUID - UUID of the plan note
  // @param {string} phaseName - Name of the phase containing the task
  // @param {string} taskTitle - Title of the task to update
  // @param {string} newStatus - New status: "pending", "completed", or "cancelled"
  // @returns {Promise<void>}
  // --------------------------------------------------------------------------
  async updateTaskStatus(planNoteUUID, phaseName, taskTitle, newStatus) {
    const content = await this.app.getNoteContent({ uuid: planNoteUUID });

    // Find and update the task checkbox
    let newContent = content;

    if (newStatus === "completed") {
      // Change from pending to completed
      const pendingPattern = new RegExp(
        `- \\[ \\] \\*\\*${ this._escapeRegex(taskTitle) }\\*\\*`,
        "g"
      );
      newContent = newContent.replace(pendingPattern, `- [x] ~~${ taskTitle }~~`);
    } else if (newStatus === "pending") {
      // Change from completed to pending
      const completedPattern = new RegExp(
        `- \\[x\\] ~~${ this._escapeRegex(taskTitle) }~~`,
        "g"
      );
      newContent = newContent.replace(completedPattern, `- [ ] **${ taskTitle }**`);
    }

    if (newContent !== content) {
      await this.app.replaceNoteContent({ uuid: planNoteUUID }, newContent);
    }
  }

  // --------------------------------------------------------------------------
  // Local helpers
  // --------------------------------------------------------------------------

  // --------------------------------------------------------------------------
  // Create fallback plan structure when LLM parsing fails
  //
  // @param {string} goalSummary - What the plan aims to achieve
  // @param {Array} suggestedPhases - Optional array of suggested phase names
  // @returns {Object} - Fallback plan structure with:
  //   - planTitle: Title for the plan
  //   - planDescription: Description of the plan
  //   - phases: Array of phase objects with name, description, order, tasks, dependencies, estimatedEffort
  //   - successCriteria: Array of success criteria strings
  //   - risks: Array of risk objects (empty for fallback)
  // --------------------------------------------------------------------------
  _createFallbackStructure(goalSummary, suggestedPhases) {
    const phaseNames = (suggestedPhases?.length > 0 ? suggestedPhases : ["Planning", "Execution", "Review"]);
    const phases = phaseNames.map((name, index) => ({
        name,
        description: `${ name } phase for: ${ goalSummary }`,
        order: index + 1,
        tasks: [
          {
            title: `Define ${ name.toLowerCase() } requirements`,
            description: "Identify what needs to be done in this phase",
            status: "pending"
          },
          {
            title: `Complete ${ name.toLowerCase() } activities`,
            description: "Execute the phase activities",
            status: "pending"
          }
        ],
        dependencies: index > 0 ? [suggestedPhases?.[index - 1] || "Previous phase"] : [],
        estimatedEffort: "Medium"
      }));

    return {
      planTitle: `Plan: ${ goalSummary }`,
      planDescription: `Action plan to accomplish: ${ goalSummary }`,
      phases,
      successCriteria: ["All phases completed", "Goal achieved"],
      risks: []
    };
  }

  // --------------------------------------------------------------------------
  // Create the plan note with structured content
  //
  // @param {string} goalSummary - What the plan aims to achieve
  // @param {Object} planStructure - The plan structure from LLM or fallback
  // @param {string} planStructure.planTitle - Title for the plan note
  // @param {string} planStructure.planDescription - Description of the plan
  // @param {Array} planStructure.phases - Array of phase objects
  // @param {Array} planStructure.successCriteria - Array of success criteria
  // @param {Array} planStructure.risks - Array of risk objects
  // @returns {Promise<string>} - UUID of the created note
  // --------------------------------------------------------------------------
  async _createPlanNote(goalSummary, planStructure) {
    const today = new Date().toLocaleDateString("en-US", {
      year: "numeric",
      month: "long",
      day: "numeric"
    });

    const noteName = planStructure.planTitle || `Plan: ${ goalSummary.substring(0, 50) }`;

    // Create note
    const noteUUID = await this.app.createNote(noteName, ["plan", "task-agent"]);

    // Build content
    let content = `# ${ noteName }\n\n`;
    content += `*Created by TaskAgent on ${ today }*\n\n`;

    if (planStructure.planDescription) {
      content += `${ planStructure.planDescription }\n\n`;
    }

    content += "---\n\n";

    // Progress overview
    content += "## Progress Overview\n\n";
    content += "| Phase | Status | Effort |\n";
    content += "|-------|--------|--------|\n";
    for (const phase of planStructure.phases) {
      const completedTasks = phase.tasks.filter(t => t.status === "completed").length;
      const totalTasks = phase.tasks.length;
      const status = completedTasks === totalTasks ? "✅ Complete" :
        completedTasks > 0 ? "🔄 In Progress" : "⏳ Pending";
      content += `| ${ phase.name } | ${ status } (${ completedTasks }/${ totalTasks }) | ${ phase.estimatedEffort || "-" } |\n`;
    }
    content += "\n";

    // Phase sections
    for (const phase of planStructure.phases) {
      content += `## Phase ${ phase.order }: ${ phase.name }\n\n`;

      if (phase.description) {
        content += `${ phase.description }\n\n`;
      }

      if (phase.dependencies?.length > 0) {
        content += `*Dependencies: ${ phase.dependencies.join(", ") }*\n\n`;
      }

      // Tasks - using Amplenote checkbox syntax
      content += "### Tasks\n\n";

      // Pending tasks
      const pendingTasks = phase.tasks.filter(t => t.status !== "completed");
      for (const task of pendingTasks) {
        content += `- [ ] **${ task.title }**\n`;
        if (task.description) {
          content += `  ${ task.description }\n`;
        }
      }

      // Completed tasks
      const completedTasks = phase.tasks.filter(t => t.status === "completed");
      for (const task of completedTasks) {
        content += `- [x] ~~${ task.title }~~\n`;
        if (task.description) {
          content += `  ${ task.description }\n`;
        }
      }

      content += "\n";
    }

    // Success criteria
    if (planStructure.successCriteria?.length > 0) {
      content += "## Success Criteria\n\n";
      for (const criterion of planStructure.successCriteria) {
        content += `- [ ] ${ criterion }\n`;
      }
      content += "\n";
    }

    // Risks
    if (planStructure.risks?.length > 0) {
      content += "## Risks & Mitigations\n\n";
      for (const risk of planStructure.risks) {
        content += `**Risk:** ${ risk.description }\n`;
        content += `**Mitigation:** ${ risk.mitigation }\n\n`;
      }
    }

    // Write content to note
    await this.app.insertNoteContent({ uuid: noteUUID }, content);

    return noteUUID;
  }

  // --------------------------------------------------------------------------
  // Document the plan creation in progress note
  //
  // @param {string} goalSummary - What the plan aims to achieve
  // @param {Object} planStructure - The plan structure
  // @param {Array} planStructure.phases - Array of phase objects
  // @param {string} noteUUID - UUID of the created plan note
  // @returns {Promise<void>}
  // --------------------------------------------------------------------------
  async _documentPlan(goalSummary, planStructure, noteUUID) {
    let content = "\n### Plan Created\n\n";

    content += `**Goal:** ${ goalSummary }\n\n`;
    content += "**Phases:**\n";

    for (const phase of planStructure.phases) {
      const taskCount = phase.tasks?.length || 0;
      content += `${ phase.order }. **${ phase.name }** (${ taskCount } tasks)\n`;
    }

    content += "\n";

    // Link to plan note
    const noteURL = await this.app.getNoteURL({ uuid: noteUUID });
    content += `📋 **[View Full Plan](${ noteURL })**\n\n`;

    await this.progressNote.appendUnderHeading("Action Items", content, 1);
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
  // Generate plan structure using LLM
  //
  // @param {string} goalSummary - What the plan aims to achieve
  // @param {Array} suggestedPhases - Optional suggested phase names
  // @param {Object} context - Additional context for planning
  // @param {string} taskContent - Original task content
  // @returns {Promise<Object>} - Plan structure with:
  //   - planTitle: Title for the plan
  //   - planDescription: Description of the plan
  //   - phases: Array of phase objects
  //   - successCriteria: Array of success criteria
  //   - risks: Array of risk objects
  // --------------------------------------------------------------------------
  async _generatePlanStructure(goalSummary, suggestedPhases, context, taskContent) {
    const prompt = `You are a project planning assistant. Create a detailed action plan for the following goal.

## Goal
${ goalSummary }

${ taskContent ? `## Original Task\n${ taskContent }\n` : "" }

${ suggestedPhases?.length > 0 ? `## Suggested Phases\n${ suggestedPhases.join(", ") }\n` : "" }

${ context ? `## Additional Context\n${ JSON.stringify(context) }\n` : "" }

## Your Task
Create a structured action plan with distinct phases. For each phase, include specific tasks that need to be completed.

Respond in JSON format:

\`\`\`json
{
  "planTitle": "Short title for the plan",
  "planDescription": "Brief overview of what this plan will accomplish",
  "phases": [
    {
      "name": "Phase name",
      "description": "What this phase accomplishes",
      "order": 1,
      "tasks": [
        {
          "title": "Task title",
          "description": "What needs to be done",
          "status": "pending"
        }
      ],
      "dependencies": ["Phase names this depends on"],
      "estimatedEffort": "Low/Medium/High"
    }
  ],
  "successCriteria": [
    "Criterion for considering the plan complete"
  ],
  "risks": [
    {
      "description": "Potential risk",
      "mitigation": "How to mitigate it"
    }
  ]
}
\`\`\`

Important:
- Keep phases focused and achievable
- Each phase should have 2-5 specific tasks
- Order phases logically (dependencies should come first)
- Be specific and actionable in task descriptions`;

    const response = await this.plugin.llm(prompt);

    try {
      const jsonMatch = response.match(/```json\s*([\s\S]*?)\s*```/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[1]);
      }
      return JSON.parse(response);
    } catch (error) {
      // Fallback structure
      return this._createFallbackStructure(goalSummary, suggestedPhases);
    }
  }
}

export default AgentPlanMaker;
