import * as vscode from 'vscode';
import * as path from 'path';
import { SkillsTreeProvider, SkillTreeItem } from './skillsTreeProvider';
import { SkillDetailPanel, CreateSkillWizard, CustomizeSkillPanel } from './skillWebview';
import { ChatViewProvider } from './chatViewProvider';
import { DiscussViewProvider } from './discussViewProvider';
import { QGenieDiffProvider } from './diffProvider';
import { ApiKeyPanel, InsightsPanel } from './settingsWebview';
import { IndexController } from './codebaseIndexer/IndexController';
import {
  Skill,
  SkillComponents,
  createSkill,
  updateSkill,
  deleteSkill,
  buildSkillInvocationAsync,
  SKILLS_DIR,
} from './skillManager';

export function activate(context: vscode.ExtensionContext): void {
  // Fully-local, AI-free codebase indexer (status-bar button + commands).
  const indexController = new IndexController(context);
  indexController.register();

  const treeProvider = new SkillsTreeProvider();
  const treeView = vscode.window.createTreeView('qgenieSkillsTree', {
    treeDataProvider: treeProvider,
    showCollapseAll: true,
  });
  context.subscriptions.push(treeView);

  const diffProvider = new QGenieDiffProvider();
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(QGenieDiffProvider.scheme, diffProvider)
  );
  context.subscriptions.push(diffProvider);

  const chatProvider = new ChatViewProvider(context.extensionUri, diffProvider, context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      ChatViewProvider.viewType,
      chatProvider,
      { webviewOptions: { retainContextWhenHidden: true } }
    )
  );

  // Wire the in-chat [INDEX] button: chat provider can call into the
  // controller, and the controller pushes status/progress events back
  // out to the webview so the button repaints itself live.
  chatProvider.setIndexController(indexController);
  indexController.onStatusChanged = () => chatProvider.refreshIndexStatus();
  indexController.onProgress = (percent: number) => chatProvider.reportIndexProgress(percent);

  // Register the multi-agent "Discuss" tab. Without this, package.json declares
  // the view but no provider ever runs → the tab spins forever on "loading".
  const discussProvider = new DiscussViewProvider(context.extensionUri);
  // When the Discuss team agrees on a plan, hand it to the chat agent to execute.
  discussProvider.onExecutePlan = (task, plan) => chatProvider.executeDiscussionPlan(task, plan);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      DiscussViewProvider.viewType,
      discussProvider,
      { webviewOptions: { retainContextWhenHidden: true } }
    )
  );

  const skillCallbacks = {
    onUse: (s: Skill, task: string) => handleInvokeSkill(s, task),
    onCustomize: (s: Skill) => vscode.commands.executeCommand('qgenieSkills.customizeSkill', s),
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('qgenieSkills.refresh', () => {
      treeProvider.refresh();
      vscode.window.setStatusBarMessage("NEXUS: Skills refreshed", 2000);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      'qgenieSkills.openSkill',
      (item: SkillTreeItem | Skill) => {
        const skill = item instanceof SkillTreeItem ? item.skill : item;
        SkillDetailPanel.show(skill, skillCallbacks);
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      'qgenieSkills.useSkill',
      async (item: SkillTreeItem | Skill) => {
        const skill = item instanceof SkillTreeItem ? item.skill : item;
        const task = await vscode.window.showInputBox({
          prompt: `Task for skill "${skill.displayName || skill.name}"`,
          placeHolder: 'e.g. Review the CMD_DB driver port from QTEE to OP-TEE...',
          ignoreFocusOut: true,
        });
        if (task === undefined) { return; }
        handleInvokeSkill(skill, task);
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('qgenieSkills.createSkill', () => {
      CreateSkillWizard.show(
        (
          name: string,
          description: string,
          displayName: string,
          shortDescription: string,
          components: SkillComponents
        ) => {
          try {
            const skillDir = createSkill(name, description, displayName, shortDescription, components);
            treeProvider.refresh();
            vscode.window
              .showInformationMessage(
                `✅ Skill "${name}" created!`,
                'View Skill',
                'Open SKILL.md'
              )
              .then((choice) => {
                if (choice === 'Open SKILL.md') {
                  vscode.workspace
                    .openTextDocument(path.join(skillDir, 'SKILL.md'))
                    .then((doc) => vscode.window.showTextDocument(doc));
                } else if (choice === 'View Skill') {
                  const s = treeProvider.getAllSkills().find((x) => x.name === name);
                  if (s) {
                    SkillDetailPanel.show(s, skillCallbacks);
                  }
                }
              });
          } catch (err: unknown) {
            vscode.window.showErrorMessage(`Failed to create skill: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      );
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      'qgenieSkills.customizeSkill',
      (item: SkillTreeItem | Skill) => {
        const skill = item instanceof SkillTreeItem ? item.skill : item;
        if (skill.isSystem) {
          vscode.window.showWarningMessage('System skills cannot be customized.');
          return;
        }
        CustomizeSkillPanel.show(
          skill,
          (s, description, displayName, shortDescription, components) => {
            try {
              updateSkill(s, description, displayName, shortDescription, components);
              treeProvider.refresh();
              vscode.window.showInformationMessage(`✅ Skill "${s.name}" updated.`);
            } catch (err: unknown) {
              vscode.window.showErrorMessage(`Failed to update skill: ${err instanceof Error ? err.message : String(err)}`);
            }
          }
        );
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      'qgenieSkills.deleteSkill',
      async (item: SkillTreeItem) => {
        const skill = item.skill;
        if (skill.isSystem) {
          vscode.window.showWarningMessage('System skills cannot be deleted.');
          return;
        }
        const confirm = await vscode.window.showWarningMessage(
          `Delete skill "${skill.displayName || skill.name}"? This cannot be undone.`,
          { modal: true },
          'Delete'
        );
        if (confirm === 'Delete') {
          try {
            deleteSkill(skill);
            treeProvider.refresh();
            vscode.window.showInformationMessage(`Skill "${skill.name}" deleted.`);
          } catch (err: unknown) {
            vscode.window.showErrorMessage(`Failed to delete: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('qgenieSkills.openChat', () => {
      vscode.commands.executeCommand('nexusChatView.focus');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('qgenieSkills.updateApiKey', () => {
      ApiKeyPanel.show();
    })
  );

  // Insights panel reads LOCAL stats from history store + tree provider;
  // QGenie gateway has no public quota endpoint.
  context.subscriptions.push(
    vscode.commands.registerCommand('qgenieSkills.openInsights', () => {
      InsightsPanel.show(chatProvider.historyStore, treeProvider);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      'qgenieSkills.chatWithSkill',
      (item: SkillTreeItem | Skill) => {
        const skill = item instanceof SkillTreeItem ? item.skill : item;
        chatProvider.loadSkillContext(skill);
        chatProvider.focus();
        vscode.commands.executeCommand('nexusChatView.focus');
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('qgenieSkills.showPanel', async () => {
      const allSkills = treeProvider.getAllSkills();
      if (allSkills.length === 0) {
        const choice = await vscode.window.showInformationMessage(
          'No skills found. Create your first skill?',
          'Create Skill'
        );
        if (choice === 'Create Skill') {
          vscode.commands.executeCommand('qgenieSkills.createSkill');
        }
        return;
      }
      const items = allSkills.map((s) => ({
        label: `$(symbol-misc) ${s.displayName || s.name}`,
        description: s.isSystem ? '⚙️ system' : '🧠 my skill',
        detail: s.shortDescription || s.description.substring(0, 100),
        skill: s,
      }));
      const selected = await vscode.window.showQuickPick(items, {
        placeHolder: 'Select a skill to view or use',
        matchOnDescription: true,
        matchOnDetail: true,
      });
      if (selected) {
        SkillDetailPanel.show(selected.skill, skillCallbacks);
      }
    })
  );

  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.command = 'qgenieSkills.showPanel';
  statusBar.tooltip = "NEXUS — click to browse";
  context.subscriptions.push(statusBar);

  const updateStatusBar = () => {
    statusBar.text = `$(symbol-misc) Skills: ${treeProvider.getUserSkills().length}`;
    statusBar.show();
  };
  updateStatusBar();
  treeProvider.onDidChangeTreeData(() => updateStatusBar());

  // ─── Debounced file-watcher refresh ─────────────────────────────────────────
  let refreshTimer: NodeJS.Timeout | undefined;
  const debouncedRefresh = () => {
    if (refreshTimer) {
      clearTimeout(refreshTimer);
    }
    refreshTimer = setTimeout(() => {
      refreshTimer = undefined;
      treeProvider.refresh();
    }, 300);
  };

  const watcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(vscode.Uri.file(SKILLS_DIR), '**/SKILL.md')
  );
  watcher.onDidCreate(debouncedRefresh);
  watcher.onDidDelete(debouncedRefresh);
  watcher.onDidChange(debouncedRefresh);
  context.subscriptions.push(watcher);

  // Dispose the pending timer when the extension deactivates
  context.subscriptions.push({ dispose: () => { if (refreshTimer) { clearTimeout(refreshTimer); } } });
}

async function handleInvokeSkill(skill: Skill, task: string): Promise<void> {
  const invocation = await buildSkillInvocationAsync(skill, task);

  await vscode.env.clipboard.writeText(invocation);

  await vscode.commands.executeCommand('qgenie-agent.plusButtonClicked').then(
    undefined,
    () => {
      vscode.commands.executeCommand('workbench.view.extension.qgenie-agent').then(
        undefined,
        () => { /* silently ignore */ }
      );
    }
  );

  await vscode.commands.executeCommand('qgenie-agent.focusChatInput').then(
    undefined,
    () => { /* silently ignore */ }
  );

  const choice = await vscode.window.showInformationMessage(
    `✅ Skill "${skill.displayName || skill.name}" invocation copied! Press Ctrl+V to paste into NEXUS.`,
    'Paste & Go'
  );

  if (choice === 'Paste & Go') {
    await vscode.commands.executeCommand('editor.action.clipboardPasteAction').then(
      undefined,
      () => { /* silently ignore */ }
    );
  }
}

export function deactivate(): void {}
