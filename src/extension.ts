import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import TurndownService from 'turndown';
// We use require since turndown-plugin-gfm only distributes standard CJS/globals properly
const turndownPluginGfm = require('turndown-plugin-gfm');

class NoteItem extends vscode.TreeItem {
    children: NoteItem[] = [];
    content: string = ''; // Add content to store the markdown text

    constructor(
        public label: string,
        public isFolder: boolean,
        public readonly command?: vscode.Command
    ) {
        super(
            label,
            isFolder
                ? vscode.TreeItemCollapsibleState.Collapsed
                : vscode.TreeItemCollapsibleState.None
        );

        this.iconPath = new vscode.ThemeIcon(
            isFolder ? 'folder' : 'file',
            new vscode.ThemeColor(
                isFolder ? 'charts.blue' : 'charts.green'
            )
        );

        this.contextValue = isFolder ? 'folder' : 'note';
    }
}

class NotelyProvider implements vscode.TreeDataProvider<NoteItem> {

    private _onDidChangeTreeData = new vscode.EventEmitter<undefined | NoteItem>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    public items: NoteItem[] = [];

    constructor(private context: vscode.ExtensionContext) {
        this.load();
    }

    private load() {
        const data = this.context.globalState.get<any[]>('notelyData', []);
        this.items = this.deserialize(data);
    }

    public save() {
        const data = this.serialize(this.items);
        this.context.globalState.update('notelyData', data);
    }

    private serialize(items: NoteItem[]): any[] {
        return items.map(item => ({
            label: item.label,
            isFolder: item.isFolder,
            content: item.content,
            children: this.serialize(item.children || [])
        }));
    }

    private deserialize(data: any[]): NoteItem[] {
        if (!data) {
            return [];
        }
        return data.map(d => {
            let command: vscode.Command | undefined;
            if (!d.isFolder) {
                command = {
                    command: 'notely.open',
                    title: 'Open Note',
                    arguments: []
                };
            }
            const item = new NoteItem(d.label, d.isFolder, command);
            if (command) {
                // Must refer back to the created item instance
                command.arguments = [item];
            }
            item.content = d.content || '';
            item.children = this.deserialize(d.children || []);
            return item;
        });
    }

    refresh() {
        this.save();
        this._onDidChangeTreeData.fire(undefined);
    }

    getTreeItem(element: NoteItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: NoteItem): Thenable<NoteItem[]> {

        if (!element) {
            return Promise.resolve(this.items);
        }

        return Promise.resolve(element.children);
    }

    addFolder(name: string) {
        this.items.push(new NoteItem(name, true));
        this.refresh();
    }

    addNote(name: string, parent?: NoteItem) {

        const note = new NoteItem(name, false, {
             command: 'notely.open',
             title: 'Open Note',
             arguments: [name] // Temporarily pass name, will update below
        });
        
        // Update its command argument to refer to itself once it's created.
        note.command!.arguments = [note];

        if (parent && parent.isFolder) {
            parent.children.push(note);
        } else {
            this.items.push(note);
        }

        this.refresh();
    }

    rename(item: NoteItem, newName: string) {
        item.label = newName;
        this.refresh();
    }

    delete(item: NoteItem) {
        const remove = (arr: NoteItem[]) => {
            const index = arr.indexOf(item);
            if (index !== -1) {
                arr.splice(index, 1);
                return true;
            }

            for (const child of arr) {
                if (child.children && remove(child.children)) {
                    return true;
                }
            }

            return false;
        };

        remove(this.items);
        this.refresh();
    }
}

class NotePanel {
    public static currentPanels: Map<NoteItem, NotePanel> = new Map();

    public readonly panel: vscode.WebviewPanel;
    private readonly item: NoteItem;
    private _disposables: vscode.Disposable[] = [];

    public static createOrShow(item: NoteItem, provider: NotelyProvider) {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        const existingPanel = NotePanel.currentPanels.get(item);

        if (existingPanel) {
            existingPanel.panel.reveal(column);
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'notelyEditor',
            `📝 ${item.label}`,
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true
            }
        );

        const newPanel = new NotePanel(panel, item, provider);
        NotePanel.currentPanels.set(item, newPanel);
    }

    private constructor(panel: vscode.WebviewPanel, item: NoteItem, provider: NotelyProvider) {
        this.panel = panel;
        this.item = item;

        this.update();

        this.panel.onDidDispose(() => this.dispose(), null, this._disposables);

        // Receive messages from the webview
        this.panel.webview.onDidReceiveMessage(
            message => {
                switch (message.command) {
                    case 'updateContent':
                        this.item.content = message.text;
                        provider.save(); // Keep persistence on changes
                        return;
                }
            },
            null,
            this._disposables
        );
    }

    private update() {
        this.panel.webview.html = this.getHtmlForWebview();
    }

    public dispose() {
        NotePanel.currentPanels.delete(this.item);
        this.panel.dispose();

        while (this._disposables.length) {
            const x = this._disposables.pop();
            if (x) {
                x.dispose();
            }
        }
    }

    private getHtmlForWebview() {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Note Editor</title>
    <!-- Include Quill and Table Plugins -->
    <link href="https://cdn.quilljs.com/1.3.6/quill.snow.css" rel="stylesheet">
    <link href="https://unpkg.com/quill-table-ui@1.0.5/dist/index.css" rel="stylesheet">
    <style>
        :root {
            --bg-color: var(--vscode-editor-background);
            --fg-color: var(--vscode-editor-foreground);
            --border-color: var(--vscode-widget-border);
            --hover-color: var(--vscode-toolbar-hoverBackground);
        }
        body { 
            padding: 0; 
            margin: 0; 
            display: flex; 
            flex-direction: column; 
            height: 100vh; 
            background-color: var(--vscode-editorGroup-background); 
            color: var(--fg-color); 
            font-family: var(--vscode-font-family);
        }
        #header-bar {
            background-color: var(--vscode-editorWidget-background);
            border-bottom: 1px solid var(--border-color);
            box-shadow: 0 4px 6px rgba(0,0,0,0.1);
            z-index: 10;
            padding: 8px 20px;
            position: sticky;
            top: 0;
            display: flex;
            flex-direction: column;
            gap: 10px;
        }
        #toolbar { 
            width: 100%;
            margin: 0;
            border: none !important; 
            background-color: transparent;
            display: flex;
            flex-wrap: wrap;
            justify-content: flex-start;
            gap: 15px;
        }
        .toolbar-group {
            display: flex;
            align-items: center;
            background: var(--vscode-editor-background);
            border: 1px solid var(--border-color);
            border-radius: 4px;
            padding: 2px;
        }
        #editor-wrapper {
            flex: 1;
            overflow-y: auto;
            padding: 0;
            display: flex;
            justify-content: stretch;
        }
        #editor-container {
            width: 100%;
            max-width: none;
            background: transparent;
            color: var(--fg-color);
            border: none;
            display: flex;
            flex-direction: column;
        }
        
        .ql-toolbar .ql-stroke { stroke: var(--fg-color) !important; }
        .ql-toolbar .ql-fill { fill: var(--fg-color) !important; }
        .ql-toolbar .ql-picker { color: var(--fg-color) !important; }
        .ql-toolbar.ql-snow .ql-picker-options { background-color: var(--vscode-editorWidget-background); border-color: var(--border-color); }
        .ql-toolbar.ql-snow .ql-picker-item:hover { background-color: var(--hover-color); }
        
        #editor { 
            flex: 1; 
            border: none !important; 
            font-size: 14pt; 
            line-height: 1.6;
            padding: 20px 40px;
        }
        .ql-editor {
            min-height: 100%;
        }
        .ql-editor h1, .ql-editor h2, .ql-editor h3, .ql-editor p {
             margin-bottom: 0.5em;
        }
        
        /* Table UI overrides to match dark mode context if needed */
        .ql-table-ui { box-shadow: 0 4px 10px rgba(0,0,0,0.2) !important; background: var(--vscode-editorWidget-background); border: 1px solid var(--border-color); color: var(--fg-color); }
        .ql-table-ui-item { color: var(--fg-color) !important; }
        .ql-table-ui-item:hover { background-color: var(--hover-color) !important; }

        table { border-collapse: collapse; width: 100%; margin-bottom: 1em; border: 1px solid #ccc; }
        td, th { border: 1px solid #ccc; padding: 8px; }
    </style>
</head>
<body>
    <div id="header-bar">
        <div id="toolbar">
            <span class="ql-formats toolbar-group" title="Font Style & Size">
                <select class="ql-font" title="Font"></select>
                <select class="ql-size" title="Size"></select>
            </span>
            <span class="ql-formats toolbar-group" title="Headings">
                <select class="ql-header" title="Heading Level">
                    <option value="1">Heading 1</option>
                    <option value="2">Heading 2</option>
                    <option value="3">Heading 3</option>
                    <option selected>Normal</option>
                </select>
            </span>
            <span class="ql-formats toolbar-group" title="Text Formatting">
                <button class="ql-bold" title="Bold"></button>
                <button class="ql-italic" title="Italic"></button>
                <button class="ql-underline" title="Underline"></button>
                <button class="ql-strike" title="Strikethrough"></button>
            </span>
            <span class="ql-formats toolbar-group" title="Colors">
                <select class="ql-color" title="Text Color"></select>
                <select class="ql-background" title="Highlight Color"></select>
            </span>
            <span class="ql-formats toolbar-group" title="Blocks">
                <button class="ql-blockquote" title="Quote"></button>
                <button class="ql-code-block" title="Code Block"></button>
            </span>
            <span class="ql-formats toolbar-group" title="Lists & Indentation">
                <button class="ql-list" value="ordered" title="Numbered List"></button>
                <button class="ql-list" value="bullet" title="Bullet List"></button>
                <button class="ql-indent" value="-1" title="Decrease Indent"></button>
                <button class="ql-indent" value="+1" title="Increase Indent"></button>
            </span>
            <span class="ql-formats toolbar-group" title="Alignment">
                <select class="ql-align" title="Text Alignment"></select>
            </span>
            <span class="ql-formats toolbar-group" title="Media & Extras">
                <button class="ql-link" title="Insert Link"></button>
                <button class="ql-image" title="Insert Image"></button>
                <button id="custom-table" title="Insert Table">
                    <svg viewBox="0 0 18 18"><rect x="3" y="3" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"/><line x1="3" y1="9" x2="15" y2="9" stroke="currentColor" stroke-width="2"/><line x1="9" y1="3" x2="9" y2="15" stroke="currentColor" stroke-width="2"/></svg>
                </button>
            </span>
            <span class="ql-formats toolbar-group" title="Clear Formatting">
                <button class="ql-clean" title="Clear Format"></button>
            </span>
        </div>
    </div>
    
    <div id="editor-wrapper">
        <div id="editor-container">
            <div id="editor"></div>
        </div>
    </div>

    <script src="https://cdn.quilljs.com/1.3.6/quill.js"></script>
    <script src="https://unpkg.com/quill-table-ui@1.0.5/dist/umd/index.js"></script>
    <script>
        const vscode = acquireVsCodeApi();
        
        Quill.register({
            'modules/tableUI': quillTableUI.default
        }, true);

        const quill = new Quill('#editor', {
            theme: 'snow',
            modules: {
                toolbar: {
                    container: '#toolbar',
                    handlers: {
                        'link': function(value) {
                            if (value) {
                                const href = prompt('Enter the URL (e.g. https://google.com):');
                                this.quill.format('link', href);
                            } else {
                                this.quill.format('link', false);
                            }
                        }
                    }
                },
                table: true,
                tableUI: true
            },
            placeholder: ''
        });

        // Initialize table module manually for custom button interaction
        const table = quill.getModule('table');

        // Custom table insert functionality using Quill's internal API
        document.querySelector('#custom-table').addEventListener('click', function() {
            table.insertTable(3, 3);
        });

        // Initialize with existing content
        const initialContent = \`${this.item.content || ''}\`;
        quill.clipboard.dangerouslyPasteHTML(initialContent);

        // Notify VS Code when content changes
        quill.on('text-change', () => {
            const html = quill.root.innerHTML;
            vscode.postMessage({
                command: 'updateContent',
                text: html
            });
        });
    </script>
</body>
</html>`;
    }
}

export function activate(context: vscode.ExtensionContext) {

    const provider = new NotelyProvider(context);

    vscode.window.registerTreeDataProvider('notelyView', provider);

    // Track active documents and items to update content
    const docToItemMap = new Map<vscode.TextDocument, NoteItem>();
    const itemToDocMap = new Map<NoteItem, vscode.TextDocument>();

    // ========== ADD FOLDER ==========
    context.subscriptions.push(
        vscode.commands.registerCommand('notely.addFolder', async () => {
            const name = await vscode.window.showInputBox({ prompt: 'Folder name' });
            if (name) {
                provider.addFolder(name);
            }
        })
    );

    // ========== ADD NOTE ==========
    context.subscriptions.push(
        vscode.commands.registerCommand('notely.addNote', async (item: NoteItem) => {
            const name = await vscode.window.showInputBox({ prompt: 'Note name' });
            if (name) {
                provider.addNote(name, item);
            }
        })
    );

    // ========== RENAME ==========
    context.subscriptions.push(
        vscode.commands.registerCommand('notely.rename', async (item: NoteItem) => {
            const name = await vscode.window.showInputBox({
                prompt: 'Rename',
                value: item.label
            });

            if (name) {
                provider.rename(item, name);
            }
        })
    );

    // ========== DELETE ==========
    context.subscriptions.push(
        vscode.commands.registerCommand('notely.delete', async (item: NoteItem) => {
            const confirm = await vscode.window.showWarningMessage(`Are you sure you want to delete ${item.label}?`, 'Yes', 'No');
            if (confirm === 'Yes') {
                provider.delete(item);
            }
        })
    );

    // ========== OPEN NOTE ==========
    context.subscriptions.push(
        vscode.commands.registerCommand('notely.open', async (item: NoteItem) => {
            if (item.isFolder) {
                return;
            }
            
            NotePanel.createOrShow(item, provider);
        })
    );

    // Save document contents to the tree item when they change (only relevant if sticking with plaintext)
    vscode.workspace.onDidChangeTextDocument(event => {
        const item = docToItemMap.get(event.document);
        if (item) {
            item.content = event.document.getText();
        }
    }, null, context.subscriptions);

    // Clean up mapping when a document is closed
    vscode.workspace.onDidCloseTextDocument(doc => {
        const item = docToItemMap.get(doc);
        if (item) {
            itemToDocMap.delete(item);
        }
        docToItemMap.delete(doc);
    }, null, context.subscriptions);

    const handleExport = async (item: NoteItem, format: string, isRoot: boolean) => {
        const rawContent = item.content || '';
        const workspaceFolders = vscode.workspace.workspaceFolders;
        const rootPath = workspaceFolders ? workspaceFolders[0].uri.fsPath : '';
        
        let finalContent = rawContent;
        if (format === '.md') {
            const turndownService = new TurndownService();
            turndownService.use(turndownPluginGfm.gfm);
            finalContent = turndownService.turndown(rawContent);
        } else if (format === '.doc') {
            finalContent = `
<html xmlns:o='urn:schemas-microsoft-com:office:office' xmlns:w='urn:schemas-microsoft-com:office:word' xmlns='http://www.w3.org/TR/REC-html40'>
<head>
<meta charset='utf-8'>
<title>${item.label}</title>
<style>
    body { font-family: Calibri, sans-serif; font-size: 12pt; }
    table { border-collapse: collapse; width: 100%; margin-top: 10px; margin-bottom: 10px; }
    th, td { border: 1px solid #999; padding: 5px; }
</style>
</head>
<body>
${rawContent}
</body>
</html>`;
        } else if (format === '.txt') {
            finalContent = rawContent.replace(/<[^>]+>/g, '\n').replace(/\n+/g, '\n').trim();
        }

        let finalUri: vscode.Uri | undefined;

        if (isRoot && rootPath) {
            const filePath = path.join(rootPath, item.label + format);
            finalUri = vscode.Uri.file(filePath);
        } else {
            finalUri = await vscode.window.showSaveDialog({
                defaultUri: vscode.Uri.file(path.join(rootPath || '', item.label + format)),
                filters: {
                    'Documents': [format.replace('.', '')],
                    'All Files': ['*']
                }
            });
        }

        if (finalUri) {
            fs.writeFile(finalUri.fsPath, finalContent, (err) => {
                if (err) {
                    vscode.window.showErrorMessage('Failed to export note');
                } else {
                    vscode.window.showInformationMessage(`Note exported to ${finalUri!.fsPath}`);
                }
            });
        }
    };

    // ========== EXPORT COMMANDS ==========
    context.subscriptions.push(
        vscode.commands.registerCommand('notely.export.md', (item: NoteItem) => {
            if (item && !item.isFolder) {
                handleExport(item, '.md', true);
            }
        })
    );
    
    context.subscriptions.push(
        vscode.commands.registerCommand('notely.export.doc', (item: NoteItem) => {
            if (item && !item.isFolder) {
                handleExport(item, '.doc', true);
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('notely.export.custom', async (item: NoteItem) => {
            if (!item || item.isFolder) {
                return;
            }
            
            const formatSelected = await vscode.window.showQuickPick([
                { label: 'Markdown (.md)', extension: '.md' },
                { label: 'Word Document (.doc)', extension: '.doc' },
                { label: 'Text Document (.txt)', extension: '.txt' }
            ], { placeHolder: 'Select export format' });

            if (formatSelected) {
                handleExport(item, formatSelected.extension, false);
            }
        })
    );
}