/**
 * AgentJiraWriter - Handles "Write a Jira" action
 *
 * Creates a clickable link to create a Jira issue using the URL format:
 * https://[YOUR-DOMAIN].atlassian.net/secure/CreateIssueDetails!init.jspa?pid=[PROJECT_ID]&issuetype=[ISSUE_TYPE_ID]&summary=[SUMMARY]&description=[DESCRIPTION]
 *
 * Configuration is stored in a "Task agent Jira configuration" note with JSON objects
 * under headings for Domains, Projects, and Issue Type IDs.
 */

import { PhasePromptUser } from './phase-prompt-user.js';

export class AgentJiraWriter {
  static CONFIG_NOTE_NAME = 'Task agent Jira configuration';
  static CONFIG_NOTE_TAG = 'task-agent/config';

  constructor(app, progressNote) {
    this.app = app;
    this.progressNote = progressNote;
    this.promptUser = new PhasePromptUser(app);
    this.config = null;
  }

  /**
   * Execute the Jira writing action
   * @param {Object} params - Jira parameters
   * @param {string} params.summary - Ticket summary
   * @param {string} params.descriptionOutline - Key points for description
   * @param {string} params.domain - Optional pre-selected domain
   * @param {string} params.project - Optional pre-selected project
   * @param {string} params.issueType - Optional pre-selected issue type
   * @returns {Promise<Object>} - Result with Jira URL
   */
  async execute(params) {
    const { summary, descriptionOutline } = params;

    const results = {
      jiraURL: null,
      summary: '',
      llmCallsMade: 0,
      configUpdated: false
    };

    // Load or create config
    await this._loadConfig();

    // Build description from outline
    const description = this._buildDescription(descriptionOutline);

    // Prompt user for Jira details
    const jiraDetails = await this._promptForJiraDetails({
      summary,
      description,
      domain: params.domain,
      project: params.project,
      issueType: params.issueType
    });

    if (!jiraDetails) {
      results.summary = 'Jira creation cancelled by user';
      return results;
    }

    // Update config if new values were provided
    if (jiraDetails.configUpdates) {
      await this._updateConfig(jiraDetails.configUpdates);
      results.configUpdated = true;
    }

    // Build the Jira URL
    const jiraURL = this._buildJiraURL(jiraDetails);
    results.jiraURL = jiraURL;

    // Document in progress note
    await this._documentJira(jiraDetails, jiraURL);

    results.summary = `Created Jira link for "${jiraDetails.summary}"`;

    return results;
  }

  /**
   * Load Jira configuration from the config note
   */
  async _loadConfig() {
    // Try to find existing config note
    const configNote = await this.app.findNote({
      name: AgentJiraWriter.CONFIG_NOTE_NAME
    });

    if (configNote) {
      const content = await this.app.getNoteContent({ uuid: configNote.uuid });
      this.config = this._parseConfigNote(content);
      this.config.noteUUID = configNote.uuid;
    } else {
      // Create default config
      this.config = {
        domains: {},
        projects: {},
        issueTypes: {},
        noteUUID: null
      };
    }
  }

  /**
   * Parse the config note content
   */
  _parseConfigNote(content) {
    const config = {
      domains: {},
      projects: {},
      issueTypes: {}
    };

    // Extract each section's JSON
    const sections = {
      'Domains': 'domains',
      'Projects': 'projects',
      'Issue Type IDs': 'issueTypes'
    };

    for (const [heading, key] of Object.entries(sections)) {
      const pattern = new RegExp(
        `#\\s*${heading}[\\s\\S]*?(?=\\n#|$)`,
        'i'
      );
      const match = content.match(pattern);

      if (match) {
        // Find JSON object in section
        const jsonMatch = match[0].match(/\{[\s\S]*?\}/);
        if (jsonMatch) {
          try {
            config[key] = JSON.parse(jsonMatch[0]);
          } catch (e) {
            console.warn(`Failed to parse ${heading} config:`, e);
          }
        }
      }
    }

    return config;
  }

  /**
   * Build description text from outline
   */
  _buildDescription(outline) {
    if (typeof outline === 'string') {
      return outline;
    }

    if (Array.isArray(outline)) {
      return outline.map(point => `* ${point}`).join('\n');
    }

    return '';
  }

  /**
   * Prompt user for Jira details with form
   */
  async _promptForJiraDetails(params) {
    const { summary, description, domain, project, issueType } = params;

    const inputs = [];
    const configUpdates = {};

    // Domain selection/input
    const domainNames = Object.keys(this.config.domains);
    if (domainNames.length > 0) {
      inputs.push({
        label: 'Jira Domain',
        type: 'select',
        options: [
          ...domainNames.map(name => ({ label: name, value: this.config.domains[name] })),
          { label: '+ Add new domain', value: '__new__' }
        ],
        value: domain || (domainNames.length > 0 ? this.config.domains[domainNames[0]] : null)
      });
    } else {
      inputs.push({
        label: 'Jira Domain (e.g., "yourcompany" for yourcompany.atlassian.net)',
        type: 'string',
        value: domain || '',
        placeholder: 'yourcompany'
      });
    }

    // Project selection/input
    const projectNames = Object.keys(this.config.projects);
    if (projectNames.length > 0) {
      inputs.push({
        label: 'Project',
        type: 'select',
        options: [
          ...projectNames.map(name => ({ label: name, value: this.config.projects[name] })),
          { label: '+ Add new project', value: '__new__' }
        ],
        value: project || (projectNames.length > 0 ? this.config.projects[projectNames[0]] : null)
      });
    } else {
      inputs.push({
        label: 'Project ID (numeric)',
        type: 'string',
        value: project || '',
        placeholder: '10001'
      });
    }

    // Issue type selection/input
    const issueTypeNames = Object.keys(this.config.issueTypes);
    if (issueTypeNames.length > 0) {
      inputs.push({
        label: 'Issue Type',
        type: 'select',
        options: [
          ...issueTypeNames.map(name => ({ label: name, value: this.config.issueTypes[name] })),
          { label: '+ Add new issue type', value: '__new__' }
        ],
        value: issueType || (issueTypeNames.length > 0 ? this.config.issueTypes[issueTypeNames[0]] : null)
      });
    } else {
      inputs.push({
        label: 'Issue Type ID (e.g., 10001 for Task, 10002 for Bug)',
        type: 'string',
        value: issueType || '',
        placeholder: '10001'
      });
    }

    // Summary and description (user can edit)
    inputs.push({
      label: 'Summary (title)',
      type: 'string',
      value: summary || '',
      placeholder: 'Issue summary'
    });

    inputs.push({
      label: 'Description (markdown)',
      type: 'text',
      value: description || '',
      placeholder: 'Issue description...'
    });

    // Show prompt
    const result = await this.app.prompt('Configure Jira Issue:', { inputs });

    if (!result) {
      return null;
    }

    // Parse results
    let [domainResult, projectResult, issueTypeResult, summaryResult, descriptionResult] = result;

    // Handle "new" selections
    if (domainResult === '__new__') {
      const newDomain = await this._promptForNewConfig('domain', 'Domain slug (e.g., "company" for company.atlassian.net)');
      if (!newDomain) return null;
      domainResult = newDomain.value;
      configUpdates.domains = { [newDomain.name]: newDomain.value };
    }

    if (projectResult === '__new__') {
      const newProject = await this._promptForNewConfig('project', 'Project ID (numeric)');
      if (!newProject) return null;
      projectResult = newProject.value;
      configUpdates.projects = { [newProject.name]: newProject.value };
    }

    if (issueTypeResult === '__new__') {
      const newIssueType = await this._promptForNewConfig('issue type', 'Issue Type ID (numeric)');
      if (!newIssueType) return null;
      issueTypeResult = newIssueType.value;
      configUpdates.issueTypes = { [newIssueType.name]: newIssueType.value };
    }

    return {
      domain: domainResult,
      projectId: projectResult,
      issueTypeId: issueTypeResult,
      summary: summaryResult,
      description: descriptionResult,
      configUpdates: Object.keys(configUpdates).length > 0 ? configUpdates : null
    };
  }

  /**
   * Prompt user for a new config value
   */
  async _promptForNewConfig(type, valueLabel) {
    const result = await this.app.prompt(`Add new ${type}:`, {
      inputs: [
        {
          label: `Name (for future reference)`,
          type: 'string',
          placeholder: `My ${type}`
        },
        {
          label: valueLabel,
          type: 'string',
          placeholder: ''
        }
      ]
    });

    if (!result || !result[0] || !result[1]) {
      return null;
    }

    return {
      name: result[0],
      value: result[1]
    };
  }

  /**
   * Update the config note with new values
   */
  async _updateConfig(updates) {
    // Merge updates into current config
    if (updates.domains) {
      Object.assign(this.config.domains, updates.domains);
    }
    if (updates.projects) {
      Object.assign(this.config.projects, updates.projects);
    }
    if (updates.issueTypes) {
      Object.assign(this.config.issueTypes, updates.issueTypes);
    }

    // Build config note content
    const content = this._buildConfigNoteContent();

    if (this.config.noteUUID) {
      // Update existing note
      await this.app.replaceNoteContent({ uuid: this.config.noteUUID }, content);
    } else {
      // Create new config note
      const noteUUID = await this.app.createNote(
        AgentJiraWriter.CONFIG_NOTE_NAME,
        [AgentJiraWriter.CONFIG_NOTE_TAG]
      );
      await this.app.insertNoteContent({ uuid: noteUUID }, content);
      this.config.noteUUID = noteUUID;
    }
  }

  /**
   * Build the config note content
   */
  _buildConfigNoteContent() {
    let content = `# Task Agent Jira Configuration\n\n`;
    content += `This note stores your Jira configuration for the TaskAgent plugin.\n\n`;
    content += `---\n\n`;

    content += `# Domains\n\n`;
    content += `\`\`\`json\n${JSON.stringify(this.config.domains, null, 2)}\n\`\`\`\n\n`;

    content += `# Projects\n\n`;
    content += `\`\`\`json\n${JSON.stringify(this.config.projects, null, 2)}\n\`\`\`\n\n`;

    content += `# Issue Type IDs\n\n`;
    content += `\`\`\`json\n${JSON.stringify(this.config.issueTypes, null, 2)}\n\`\`\`\n\n`;

    content += `---\n\n`;
    content += `*Common Issue Type IDs:*\n`;
    content += `- Story: 10001\n`;
    content += `- Task: 10002\n`;
    content += `- Bug: 10004\n`;
    content += `- Epic: 10000\n`;
    content += `\n*Note: Actual IDs vary by Jira instance*\n`;

    return content;
  }

  /**
   * Build the Jira creation URL
   */
  _buildJiraURL(details) {
    const { domain, projectId, issueTypeId, summary, description } = details;

    const baseURL = `https://${domain}.atlassian.net/secure/CreateIssueDetails!init.jspa`;

    const params = new URLSearchParams({
      pid: projectId,
      issuetype: issueTypeId,
      summary: summary
    });

    if (description) {
      params.append('description', description);
    }

    return `${baseURL}?${params.toString()}`;
  }

  /**
   * Document the Jira creation in progress note
   */
  async _documentJira(details, jiraURL) {
    let content = `\n### Jira Issue Prepared\n\n`;

    content += `**Summary:** ${details.summary}\n\n`;
    content += `**Project ID:** ${details.projectId}\n`;
    content += `**Issue Type ID:** ${details.issueTypeId}\n\n`;

    if (details.description) {
      const preview = details.description.substring(0, 150);
      content += `**Description Preview:**\n> ${preview.replace(/\n/g, '\n> ')}${details.description.length > 150 ? '...' : ''}\n\n`;
    }

    // Create clickable link
    content += `🎫 **[Click here to create Jira issue](${jiraURL})**\n\n`;

    await this.progressNote.appendUnderHeading('Action Items', content, 1);
  }

  /**
   * Quick method to build a Jira URL
   */
  static quickCreate(domain, projectId, issueTypeId, summary, description = '') {
    const baseURL = `https://${domain}.atlassian.net/secure/CreateIssueDetails!init.jspa`;

    const params = new URLSearchParams({
      pid: projectId,
      issuetype: issueTypeId,
      summary: summary
    });

    if (description) {
      params.append('description', description);
    }

    return `${baseURL}?${params.toString()}`;
  }
}

export default AgentJiraWriter;
