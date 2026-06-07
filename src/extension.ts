import * as vscode from 'vscode';

class NotelyProvider implements vscode.TreeDataProvider<NoteItem> {

    getTreeItem(element: NoteItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: NoteItem): Thenable<NoteItem[]> {

        if (!element) {
            return Promise.resolve([
                new NoteItem('Linux', vscode.TreeItemCollapsibleState.Collapsed),
                new NoteItem('NextJS', vscode.TreeItemCollapsibleState.Collapsed),
                new NoteItem('Docker', vscode.TreeItemCollapsibleState.Collapsed)
            ]);
        }

        return Promise.resolve([
            new NoteItem('Example Note')
        ]);
    }
}

class NoteItem extends vscode.TreeItem {
    constructor(
        label: string,
        collapsibleState?: vscode.TreeItemCollapsibleState
    ) {
        super(label, collapsibleState);
    }
}

export function activate(context: vscode.ExtensionContext) {

    const provider = new NotelyProvider();

    vscode.window.registerTreeDataProvider(
        'notelyView',
        provider
    );

    const addFolder = vscode.commands.registerCommand(
        'notely.addFolder',
        async () => {

            const folderName = await vscode.window.showInputBox({
                prompt: 'Folder name'
            });

            if (folderName) {
                vscode.window.showInformationMessage(
                    `Folder: ${folderName}`
                );
            }
        }
    );

    const addNote = vscode.commands.registerCommand(
        'notely.addNote',
        async () => {

            const noteName = await vscode.window.showInputBox({
                prompt: 'Note name'
            });

            if (noteName) {
                vscode.window.showInformationMessage(
                    `Note: ${noteName}`
                );
            }
        }
    );

    context.subscriptions.push(addFolder);
    context.subscriptions.push(addNote);
}

export function deactivate() {}