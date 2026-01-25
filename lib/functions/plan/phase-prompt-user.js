// --------------------------------------------------------------------------
// PhasePromptUser - Glue code for translating agent questions into app.prompt calls
//
// This phase translates a specific array of questions from the TaskAgent
// (or its agent actions) into an app.prompt call with proper input types,
// and returns the array of user responses.
// --------------------------------------------------------------------------

export class PhasePromptUser {
  constructor(app) {
    this.app = app;
  }

  // --------------------------------------------------------------------------
  // Execute the prompt phase
  //
  // @param {Array} questions - Array of question objects from the planning phase
  // @param {string} questions[].question - The question text
  // @param {string} questions[].type - Input type: "string", "text", "select", etc.
  // @param {Array} questions[].options - Options for select type questions
  // @returns {Promise<Object>} - Map of question text to user responses
  // @throws {Error} - If user cancels the clarification prompt
  // --------------------------------------------------------------------------
  async execute(questions) {
    if (!questions || questions.length === 0) {
      return {};
    }

    // Build the prompt inputs
    const inputs = questions.map(q => this._questionToInput(q));

    // Show the prompt to the user
    const result = await this.app.prompt(
      "TaskAgent needs clarification to help with your task:",
      { inputs }
    );

    // Handle cancellation
    if (result === null) {
      throw new Error("User cancelled the clarification prompt");
    }

    // Map results back to questions
    const responses = {};

    if (Array.isArray(result)) {
      // Multiple inputs - map each result to its question
      questions.forEach((q, index) => {
        responses[q.question] = this._normalizeResponse(result[index], q.type);
      });
    } else {
      // Single input
      responses[questions[0].question] = this._normalizeResponse(result, questions[0].type);
    }

    return responses;
  }

  // --------------------------------------------------------------------------
  // Prompt user for confirmation
  //
  // @param {string} question - The question to ask
  // @returns {Promise<boolean|null>} - User's confirmation, or null if cancelled
  // --------------------------------------------------------------------------
  async promptConfirm(question) {
    return await this.promptSingle(question, "checkbox");
  }

  // --------------------------------------------------------------------------
  // Prompt user for a date
  //
  // @param {string} question - The question to ask
  // @returns {Promise<number|null>} - Unix timestamp of selected date, or null if cancelled
  // --------------------------------------------------------------------------
  async promptDate(question) {
    return await this.promptSingle(question, "date");
  }

  // --------------------------------------------------------------------------
  // Build a form with multiple sections for complex prompts
  //
  // @param {string} message - Main prompt message
  // @param {Array} sections - Array of section objects
  // @param {string} sections[].title - Title of the section
  // @param {Array} sections[].questions - Array of question objects in this section
  // @returns {Promise<Object|null>} - Responses organized by section, or null if cancelled
  //   Keys are section titles, values are objects mapping question text to responses
  // --------------------------------------------------------------------------
  async promptForm(message, sections) {
    // Flatten all questions
    const allInputs = [];
    const questionMap = [];

    for (const section of sections) {
      for (const question of section.questions) {
        const input = this._questionToInput(question);
        // Add section context to label
        if (section.title) {
          input.label = `[${ section.title }] ${ input.label }`;
        }
        allInputs.push(input);
        questionMap.push({
          section: section.title || "default",
          question: question.question
        });
      }
    }

    const result = await this.app.prompt(message, { inputs: allInputs });

    if (result === null) {
      return null;
    }

    // Organize responses by section
    const responses = {};
    const resultArray = Array.isArray(result) ? result : [result];

    resultArray.forEach((value, index) => {
      const { section, question } = questionMap[index];
      if (!responses[section]) {
        responses[section] = {};
      }
      responses[section][question] = value;
    });

    return responses;
  }

  // --------------------------------------------------------------------------
  // Prompt user for a note selection
  //
  // @param {string} question - The question to ask
  // @returns {Promise<Object|null>} - Selected note handle, or null if cancelled
  // --------------------------------------------------------------------------
  async promptNote(question) {
    return await this.promptSingle(question, "note");
  }

  // --------------------------------------------------------------------------
  // Prompt user to select from options
  //
  // @param {string} question - The question to ask
  // @param {Array} options - Array of {label, value} objects
  // @returns {Promise<*|null>} - Selected value, or null if cancelled
  // --------------------------------------------------------------------------
  async promptSelect(question, options) {
    return await this.promptSingle(question, "select", { options });
  }

  // --------------------------------------------------------------------------
  // Prompt user with a single question
  //
  // @param {string} question - The question to ask
  // @param {string} type - Input type: "string", "text", "select", "checkbox", "note", "tags", "date"
  // @param {Object} options - Additional options (like select options, placeholder, value)
  // @returns {Promise<*|null>} - User's response, or null if cancelled
  // --------------------------------------------------------------------------
  async promptSingle(question, type = "string", options = {}) {
    const input = this._questionToInput({ question, type, ...options });

    const result = await this.app.prompt(question, { inputs: [input] });

    if (result === null) {
      return null;
    }

    return this._normalizeResponse(
      Array.isArray(result) ? result[0] : result,
      type
    );
  }

  // --------------------------------------------------------------------------
  // Prompt user for tag selection
  //
  // @param {string} question - The question to ask
  // @param {number} limit - Maximum number of tags to select (default: 1)
  // @returns {Promise<string|null>} - Selected tag(s), or null if cancelled
  // --------------------------------------------------------------------------
  async promptTags(question, limit = 1) {
    return await this.promptSingle(question, "tags", { limit });
  }

  // --------------------------------------------------------------------------
  // Prompt user for multi-line text
  //
  // @param {string} question - The question to ask
  // @param {string} defaultValue - Default text value (default: "")
  // @returns {Promise<string|null>} - User's text input, or null if cancelled
  // --------------------------------------------------------------------------
  async promptText(question, defaultValue = "") {
    return await this.promptSingle(question, "text", { value: defaultValue });
  }

  // --------------------------------------------------------------------------
  // Show an alert with action buttons
  //
  // @param {string} message - Alert message
  // @param {Array} actions - Array of action objects
  // @param {string} actions[].label - Display label for the action
  // @param {*} actions[].value - Value returned when action is selected
  // @param {string} actions[].icon - Optional icon for the action
  // @returns {Promise<*>} - Selected action value or index
  // --------------------------------------------------------------------------
  async showAlert(message, actions = []) {
    const options = {};

    if (actions.length > 0) {
      options.actions = actions.map(a => ({
        label: a.label,
        value: a.value,
        icon: a.icon
      }));
    }

    return await this.app.alert(message, options);
  }

  // --------------------------------------------------------------------------
  // Local helpers
  // --------------------------------------------------------------------------

  // --------------------------------------------------------------------------
  // Normalize input type to valid app.prompt types
  //
  // @param {string} type - The input type string
  // @returns {string} - Normalized type for app.prompt
  // --------------------------------------------------------------------------
  _normalizeInputType(type) {
    const typeMap = {
      "string": "string",
      "text": "text",
      "textarea": "text",
      "multiline": "text",
      "select": "select",
      "dropdown": "select",
      "radio": "radio",
      "checkbox": "checkbox",
      "boolean": "checkbox",
      "note": "note",
      "tags": "tags",
      "tag": "tags",
      "date": "date",
      "secure": "secureText",
      "password": "secureText"
    };

    return typeMap[type?.toLowerCase()] || "string";
  }

  // --------------------------------------------------------------------------
  // Normalize options for select/radio inputs
  //
  // @param {Array} options - Array of options (strings or objects)
  // @returns {Array} - Array of normalized {label, value} objects
  // --------------------------------------------------------------------------
  _normalizeOptions(options) {
    if (!options || !Array.isArray(options)) {
      return [];
    }

    return options.map(opt => {
      if (typeof opt === "string") {
        return { label: opt, value: opt };
      }
      return {
        label: opt.label || opt.text || String(opt.value),
        value: opt.value !== undefined ? opt.value : opt.label || opt.text
      };
    });
  }

  // --------------------------------------------------------------------------
  // Normalize a user response based on input type
  //
  // @param {*} response - The raw response from app.prompt
  // @param {string} type - The input type
  // @returns {*} - Normalized response value
  // --------------------------------------------------------------------------
  _normalizeResponse(response, type) {
    if (response === null || response === undefined) {
      return null;
    }

    switch (this._normalizeInputType(type)) {
      case "checkbox":
        return Boolean(response);

      case "date":
        // Returns unix timestamp
        return typeof response === "number" ? response : null;

      case "note":
        // Returns noteHandle
        return response;

      case "tags":
        // May return comma-separated string for multiple tags
        return response;

      default:
        return String(response);
    }
  }

  // --------------------------------------------------------------------------
  // Convert a question object to an app.prompt input object
  //
  // @param {Object} question - The question object
  // @param {string} question.question - The question text (used as label)
  // @param {string} question.label - Alternative label
  // @param {string} question.type - Input type
  // @param {Array} question.options - Options for select/radio types
  // @param {number} question.limit - Limit for tags type
  // @param {string} question.placeholder - Placeholder text
  // @param {*} question.value - Default value
  // @returns {Object} - Input object for app.prompt
  // --------------------------------------------------------------------------
  _questionToInput(question) {
    const input = {
      label: question.question || question.label,
      type: this._normalizeInputType(question.type)
    };

    // Add type-specific properties
    switch (input.type) {
      case "select":
      case "radio":
        input.options = this._normalizeOptions(question.options);
        break;

      case "tags":
        if (question.limit) {
          input.limit = question.limit;
        }
        break;

      case "string":
      case "text":
      case "secureText":
        if (question.placeholder) {
          input.placeholder = question.placeholder;
        }
        if (question.value !== undefined) {
          input.value = question.value;
        }
        break;
    }

    return input;
  }
}

export default PhasePromptUser;
