import * as vscode from 'vscode';
import { Skill, loadSkills, loadSystemSkills, loadSkillsAsync, loadSystemSkillsAsync } from './skillManager';

/** Helper to create a non-collapsible info/placeholder TreeItem */
function makeInfoItem(label: string, icon?: string): vscode.TreeItem {
  const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
  if (icon) {
    item.iconPath = new vscode.ThemeIcon(icon);
  }
  return item;
}

export class SkillTreeItem extends vscode.TreeItem {
  constructor(
    public readonly skill: Skill,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState
  ) {
    super(skill.displayName || skill.name, collapsibleState);

    this.tooltip = skill.description
      ? skill.description.substring(0, 200)
      : skill.name;
    this.description = skill.shortDescription
      ? skill.shortDescription.substring(0, 60)
      : '';
    this.contextValue = 'skill';
    this.iconPath = skill.isSystem
      ? new vscode.ThemeIcon('library', new vscode.ThemeColor('charts.blue'))
      : new vscode.ThemeIcon('symbol-misc', new vscode.ThemeColor('charts.green'));

    this.command = {
      command: 'qgenieSkills.openSkill',
      title: 'Open Skill',
      arguments: [this],
    };
  }
}

export class SkillGroupItem extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly groupType: 'user' | 'system',
    public readonly collapsibleState: vscode.TreeItemCollapsibleState
  ) {
    super(label, collapsibleState);
    this.contextValue = 'group';
    this.iconPath =
      groupType === 'user'
        ? new vscode.ThemeIcon('account', new vscode.ThemeColor('charts.green'))
        : new vscode.ThemeIcon('gear', new vscode.ThemeColor('charts.blue'));
  }
}

export class SkillsTreeProvider
  implements vscode.TreeDataProvider<SkillTreeItem | SkillGroupItem>
{
  private _onDidChangeTreeData = new vscode.EventEmitter<
    SkillTreeItem | SkillGroupItem | undefined | null | void
  >();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private userSkills: Skill[] = [];
  private systemSkills: Skill[] = [];
  private _loading = false;

  constructor() {
    this.refresh();
  }

  /**
   * Synchronous refresh (legacy) — kept for backward compat.
   * Triggers an async reload internally and fires tree change when done.
   */
  refresh(): void {
    this.refreshAsync();
  }

  /**
   * Async refresh that uses non-blocking I/O for skill loading.
   */
  async refreshAsync(): Promise<void> {
    this._loading = true;
    this._onDidChangeTreeData.fire();
    try {
      const [user, system] = await Promise.all([
        loadSkillsAsync(),
        loadSystemSkillsAsync(),
      ]);
      this.userSkills = user;
      this.systemSkills = system;
    } catch {
      // Fallback to deprecated sync loaders on error (e.g., if fs/promises unavailable)
      this.userSkills = loadSkills();
      this.systemSkills = loadSystemSkills();
    }
    this._loading = false;
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: SkillTreeItem | SkillGroupItem): vscode.TreeItem {
    return element;
  }

  getChildren(
    element?: SkillTreeItem | SkillGroupItem
  ): (SkillTreeItem | SkillGroupItem)[] {
    if (!element) {
      // Show loading indicator while async refresh is in progress
      if (this._loading) {
        return [makeInfoItem('Loading skills…', 'loading~spin') as SkillGroupItem];
      }
      const items: (SkillTreeItem | SkillGroupItem)[] = [];
      if (this.userSkills.length > 0) {
        items.push(
          new SkillGroupItem(
            `My Skills (${this.userSkills.length})`,
            'user',
            vscode.TreeItemCollapsibleState.Expanded
          )
        );
      }
      if (this.systemSkills.length > 0) {
        items.push(
          new SkillGroupItem(
            `System Skills (${this.systemSkills.length})`,
            'system',
            vscode.TreeItemCollapsibleState.Collapsed
          )
        );
      }
      if (items.length === 0) {
        // No skills yet — show placeholder
        return [makeInfoItem('No skills found. Click + to create one.', 'info') as SkillGroupItem];
      }
      return items;
    }

    if (element instanceof SkillGroupItem) {
      const skills =
        element.groupType === 'user' ? this.userSkills : this.systemSkills;
      return skills.map(
        (s) => new SkillTreeItem(s, vscode.TreeItemCollapsibleState.None)
      );
    }

    return [];
  }

  getUserSkills(): Skill[] {
    return this.userSkills;
  }

  getSystemSkills(): Skill[] {
    return this.systemSkills;
  }

  getAllSkills(): Skill[] {
    return [...this.userSkills, ...this.systemSkills];
  }
}
