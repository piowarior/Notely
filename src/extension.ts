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
        panel.onDidChangeViewState(e => {
            if (e.webviewPanel.visible) {
                e.webviewPanel.webview.postMessage({
                    command: 'restoreFocus'
                });
            }
        });
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
        
        /* Active states for tools */
        button.ql-active, .ql-picker-label.ql-active {
            background-color: var(--vscode-button-background) !important;
            border-radius: 4px;
            color: var(--vscode-button-foreground) !important;
        }
        button.ql-active .ql-stroke, .ql-picker-label.ql-active .ql-stroke { stroke: var(--vscode-button-foreground) !important; }
        button.ql-active .ql-fill, .ql-picker-label.ql-active .ql-fill { fill: var(--vscode-button-foreground) !important; }
        
        #editor { 
            flex: 1; 
            border: none !important; 
            font-size: 14pt; 
            line-height: 1.15;
            padding: 20px 40px;
        }
        .ql-editor {
            min-height: 100%;
        }
        .ql-editor h1, .ql-editor h2, .ql-editor h3, .ql-editor p {
             margin-top: 2px;
             margin-bottom: 3px;
        }
        
        
        /* Table layout and cell wrapping styles */
        .ql-editor table { 
            border-collapse: collapse; 
            width: 100%; 
            margin: 1em 0; 
            border: 1px solid #ffffff !important; 
            table-layout: fixed; 
        }
        .ql-editor td, .ql-editor th { 
            border: 1px solid #ffffff !important; 
            padding: 8px 12px; 
            min-width: 40px; 
            word-break: break-word; 
            overflow-wrap: break-word; 
            white-space: normal; 
        }
        table { 
            border-collapse: collapse; 
            width: 100%; 
            margin: 1em 0; 
            border: 1px solid #ffffff !important; 
            table-layout: fixed; 
        }
        td, th { 
            border: 1px solid #ffffff !important; 
            padding: 8px 12px; 
            word-break: break-word; 
            overflow-wrap: break-word; 
            white-space: normal; 
        }

        /* Line spacing picker styling */
        .ql-snow.ql-toolbar .ql-picker.ql-lineheight {
            width: 100px;
        }
        .ql-snow.ql-toolbar .ql-picker.ql-lineheight .ql-picker-label::before {
            content: 'Spacing' !important;
        }
        .ql-snow.ql-toolbar .ql-picker.ql-lineheight .ql-picker-label[data-value="1"]::before { content: '1.0' !important; }
        .ql-snow.ql-toolbar .ql-picker.ql-lineheight .ql-picker-label[data-value="1.15"]::before { content: '1.15' !important; }
        .ql-snow.ql-toolbar .ql-picker.ql-lineheight .ql-picker-label[data-value="1.2"]::before { content: '1.2' !important; }
        .ql-snow.ql-toolbar .ql-picker.ql-lineheight .ql-picker-label[data-value="1.5"]::before { content: '1.5' !important; }
        .ql-snow.ql-toolbar .ql-picker.ql-lineheight .ql-picker-label[data-value="2"]::before { content: '2.0' !important; }
        .ql-snow.ql-toolbar .ql-picker.ql-lineheight .ql-picker-label[data-value="2.5"]::before { content: '2.5' !important; }
        .ql-snow.ql-toolbar .ql-picker.ql-lineheight .ql-picker-label[data-value="3"]::before { content: '3.0' !important; }

        .ql-snow.ql-toolbar .ql-picker.ql-lineheight .ql-picker-item::before {
            content: attr(data-value) !important;
        }
        .ql-snow.ql-toolbar .ql-picker.ql-lineheight .ql-picker-item[data-value="1"]::before { content: '1.0' !important; }
        .ql-snow.ql-toolbar .ql-picker.ql-lineheight .ql-picker-item[data-value="1.15"]::before { content: '1.15' !important; }
        .ql-snow.ql-toolbar .ql-picker.ql-lineheight .ql-picker-item[data-value="1.2"]::before { content: '1.2' !important; }
        .ql-snow.ql-toolbar .ql-picker.ql-lineheight .ql-picker-item[data-value="1.5"]::before { content: '1.5' !important; }
        .ql-snow.ql-toolbar .ql-picker.ql-lineheight .ql-picker-item[data-value="2"]::before { content: '2.0' !important; }
        .ql-snow.ql-toolbar .ql-picker.ql-lineheight .ql-picker-item[data-value="2.5"]::before { content: '2.5' !important; }
        .ql-snow.ql-toolbar .ql-picker.ql-lineheight .ql-picker-item[data-value="3"]::before { content: '3.0' !important; }

        /* Custom Table Dropdown Grid UI */
        .custom-dropdown-container { relative; display: inline-block; }
        #table-dropdown { 
            position: absolute; 
            top: 100%; 
            left: 0; 
            background: var(--vscode-editorWidget-background); 
            border: 1px solid var(--border-color); 
            padding: 10px; 
            box-shadow: 0 4px 10px rgba(0,0,0,0.3); 
            z-index: 1000; 
            width: 170px; 
        }
        .hidden { display: none !important; }
        .table-grid { display: grid; grid-template-columns: repeat(10, 14px); gap: 2px; }
        .grid-cell { width: 14px; height: 14px; border: 1px solid var(--border-color); cursor: pointer; }
        .grid-cell.selected { background-color: var(--vscode-button-background); border-color: var(--vscode-button-hoverBackground); }
        #table-grid-label { text-align: center; margin-top: 8px; font-weight: bold; font-size: 13px; }
        
        .table-inputs { 
            display: flex; 
            align-items: center; 
            justify-content: space-between; 
            margin-top: 10px; 
            padding-top: 10px; 
            border-top: 1px solid var(--border-color); 
            gap: 6px; 
        }
        .table-inputs input { 
            width: 45px; 
            background: var(--vscode-input-background); 
            color: var(--vscode-input-foreground); 
            border: 1px solid var(--vscode-input-border, var(--border-color)); 
            border-radius: 3px; 
            padding: 4px; 
            font-size: 12px; 
            text-align: center; 
        }
        .table-inputs span { 
            font-size: 12px; 
            color: var(--fg-color); 
        }
        .table-inputs button { 
            flex: 1; 
            background: var(--vscode-button-background); 
            color: var(--vscode-button-foreground); 
            border: none; 
            padding: 4px 8px; 
            border-radius: 3px; 
            cursor: pointer; 
            font-size: 12px; 
            font-weight: bold; 
        }
        .table-inputs button:hover { 
            background: var(--vscode-button-hoverBackground); 
        }

        /* Inline Table Action buttons */
        #table-actions button {
            font-size: 11px;
            width: auto;
            padding: 2px 6px;
            color: var(--fg-color);
            background: transparent;
            border: 1px solid var(--border-color);
            border-radius: 3px;
        }
        #table-actions button:hover {
            background: var(--hover-color);
        }

        /* Context Menu Removed */
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
            <span class="ql-formats toolbar-group" title="Paragraph Layout & Spacing">
                <select class="ql-align" title="Text Alignment"></select>
                <select class="ql-lineheight" title="Line Spacing">
                    <option value="1">1.0</option>
                    <option value="1.15" selected>1.15</option>
                    <option value="1.2">1.2</option>
                    <option value="1.5">1.5</option>
                    <option value="2">2.0</option>
                    <option value="2.5">2.5</option>
                    <option value="3">3.0</option>
                </select>
                <button class="ql-list" value="ordered" title="Numbered List"></button>
                <button class="ql-list" value="bullet" title="Bullet List"></button>
                <button class="ql-indent" value="-1" title="Decrease Indent"></button>
                <button class="ql-indent" value="+1" title="Increase Indent"></button>
            </span>
            <span class="ql-formats toolbar-group" title="Blocks">
                <button class="ql-blockquote" title="Quote"></button>
                <button class="ql-code-block" title="Code Block"></button>
            </span>
            <span class="ql-formats toolbar-group" title="Media & Extras">
                <button class="ql-link" title="Insert Link"></button>
                <button class="ql-image" title="Insert Image"></button>
                
                <!-- Custom Table Dropdown -->
                <div class="custom-dropdown-container">
                    <button id="custom-table" title="Insert Table">
                        <svg viewBox="0 0 18 18"><rect x="3" y="3" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"/><line x1="3" y1="9" x2="15" y2="9" stroke="currentColor" stroke-width="2"/><line x1="9" y1="3" x2="9" y2="15" stroke="currentColor" stroke-width="2"/></svg>
                    </button>
                    <div id="table-dropdown" class="hidden">
                        <div id="table-grid" class="table-grid"></div>
                        <div id="table-grid-label">0 x 0</div>
                        <div class="table-inputs">
                            <input type="number" id="table-input-rows" placeholder="Row" min="1" max="50" value="3">
                            <span>x</span>
                            <input type="number" id="table-input-cols" placeholder="Col" min="1" max="50" value="3">
                            <button id="table-input-btn">Insert</button>
                        </div>
                    </div>
                </div>
            </span>

            <span class="ql-formats toolbar-group" title="Table Actions" id="table-actions" style="display: none;">
                <button id="add-row" title="Add Row Below">Row+</button>
                <button id="add-col" title="Add Col Right">Col+</button>
                <button id="del-row" title="Delete Row">Row-</button>
                <button id="del-col" title="Delete Col">Col-</button>
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
    <script>
        const vscode = acquireVsCodeApi();
        
        // Register Line Spacing Attribute
        var Parchment = Quill.import('parchment');
        var LineHeightStyle = new Parchment.Attributor.Style('lineheight', 'line-height', {
            scope: Parchment.Scope.BLOCK,
            whitelist: ['1', '1.15', '1.2', '1.5', '2', '2.5', '3']
        });
        Quill.register({'formats/lineheight': LineHeightStyle}, true);

        // Register Table Blot as a BlockEmbed
        var BlockEmbed = Quill.import('blots/block/embed');
        var Delta = Quill.import('delta');

        class TableEmbed extends BlockEmbed {
            static create(value) {
                var node = super.create();
                node.innerHTML = value;
                node.setAttribute('contenteditable', 'true');
                node.setAttribute('data-table-embed', 'true');
                return node;
            }
            static value(node) {
                return node.innerHTML;
            }
        }
        TableEmbed.blotName = 'table-embed';
        TableEmbed.tagName = 'div';
        TableEmbed.className = 'ql-table-embed';
        Quill.register(TableEmbed, true);

        var quill = new Quill('#editor', {
            theme: 'snow',
            modules: {

                history: {
                    delay: 0,
                    maxStack: 2000,
                    userOnly: true
                },

                toolbar: {
                    container: '#toolbar',
                    handlers: {
                        'link': function(value) {
                            if (value) {
                                var href = prompt('Enter the URL (e.g. https://google.com):');
                                if (href) {
                                    this.quill.format('link', href);
                                }
                            } else {
                                this.quill.format('link', false);
                            }
                        },

                        'lineheight': function(value) {
                            this.quill.format('lineheight', value);
                        }
                    }
                }
            },
            placeholder: ''
        });

        var lastTableHtml = null;
        var activeTableBlot = null;

        // Helper: pause Quill's observer, run fn, resume observer, save content.
        // This prevents Quill from seeing table DOM changes (so it won't revert them)
        // and does NOT corrupt Quill's undo/redo history.
        var _observerConfig = { attributes: true, characterData: true, childList: true, subtree: true };
        function withTableGuard(fn) {
            var sel = window.getSelection();
            var embedNode = null;
            if (sel && sel.anchorNode) {
                var node = sel.anchorNode;
                while (node && node !== quill.root) {
                    if (node.classList && node.classList.contains('ql-table-embed')) {
                        embedNode = node;
                        break;
                    }
                    node = node.parentNode;
                }
            }

            var oldHtml = embedNode ? embedNode.innerHTML : null;
            var blot = embedNode ? Quill.find(embedNode) : null;

            quill.scroll.observer.disconnect();
            fn();
            quill.scroll.observer.observe(quill.scroll.domNode, _observerConfig);

            if (embedNode && blot) {
                var newHtml = embedNode.innerHTML;
                if (newHtml !== oldHtml) {
                    var index = quill.getIndex(blot);
                    var Delta = Quill.import('delta');
                    var redoDelta = new Delta().retain(index).delete(1).insert({ 'table-embed': newHtml });
                    var undoDelta = new Delta().retain(index).delete(1).insert({ 'table-embed': oldHtml });

                    quill.history.undoStack.push({
                        redoDelta: redoDelta,
                        undoDelta: undoDelta
                    });
                    quill.history.redoStack = [];
                    quill.editor.delta = quill.editor.delta.compose(redoDelta);
                    
                    lastTableHtml = newHtml;
                    activeTableBlot = blot;
                }
            }
            notifySave();
        }

        // Intercept formatting when the selection is inside a table embed
        var originalFormat = quill.format;
        quill.format = function(name, value, source) {
            var sel = window.getSelection();
            if (sel && sel.anchorNode) {
                var node = sel.anchorNode;
                var insideTable = false;
                while (node && node !== quill.root) {
                    if (node.classList && node.classList.contains('ql-table-embed')) {
                        insideTable = true;
                        break;
                    }
                    node = node.parentNode;
                }
                if (insideTable) {
                    withTableGuard(function() {
                        if (name === 'bold') {
                            document.execCommand('bold', false, null);
                        } else if (name === 'italic') {
                            document.execCommand('italic', false, null);
                        } else if (name === 'underline') {
                            document.execCommand('underline', false, null);
                        } else if (name === 'strike') {
                            document.execCommand('strikeThrough', false, null);
                        } else if (name === 'color') {
                            document.execCommand('foreColor', false, value);
                        } else if (name === 'background') {
                            document.execCommand('backColor', false, value);
                        } else if (name === 'align') {
                            var cell = getCell();
                            if (cell) {
                                cell.style.textAlign = value || '';
                            }
                        } else if (name === 'lineheight') {
                            var cell = getCell();
                            if (cell) {
                                cell.style.lineHeight = value || '';
                            }
                        } else if (name === 'header') {
                            var tag = value ? 'H' + value : 'span';
                            document.execCommand('formatBlock', false, tag);
                        } else if (name === 'list') {
                            if (value === 'ordered') {
                                document.execCommand('insertOrderedList', false, null);
                            } else if (value === 'bullet') {
                                document.execCommand('insertUnorderedList', false, null);
                            }
                        } else if (name === 'link') {
                            if (value) {
                                document.execCommand('createLink', false, value);
                            } else {
                                document.execCommand('unlink', false, null);
                            }
                        }
                    });
                    return;
                }
            }
            return originalFormat.apply(this, arguments);
        };

        // NOTE: We no longer override scroll.update to filter table mutations.
        // Instead we use withTableGuard() which disconnects/reconnects the observer
        // around table DOM changes. This keeps Quill's undo/redo history clean.

        // Add Clipboard Matcher for table-embed (for copy-paste of our own embedded tables)
        quill.clipboard.addMatcher('div.ql-table-embed', function(node, delta) {
            return new Delta().insert({ 'table-embed': node.innerHTML });
        });

        quill.clipboard.addMatcher('TABLE', function(node, delta) {
            return new Delta().insert({
                'table-embed': node.outerHTML
            });
        });

        function syncTableChange() {
            var sel = window.getSelection();
            if (!sel || !sel.anchorNode) return;
            var node = sel.anchorNode;
            var embedNode = null;
            while (node && node !== quill.root) {
                if (node.classList && node.classList.contains('ql-table-embed')) {
                    embedNode = node;
                    break;
                }
                node = node.parentNode;
            }
            if (!embedNode) {
                lastTableHtml = null;
                activeTableBlot = null;
                return;
            }

            var blot = Quill.find(embedNode);
            if (!blot) return;

            var newHtml = embedNode.innerHTML;
            if (lastTableHtml === null || activeTableBlot !== blot) {
                lastTableHtml = newHtml;
                activeTableBlot = blot;
                return;
            }

            if (newHtml !== lastTableHtml) {
                var index = quill.getIndex(blot);
                var Delta = Quill.import('delta');
                var redoDelta = new Delta().retain(index).delete(1).insert({ 'table-embed': newHtml });
                var undoDelta = new Delta().retain(index).delete(1).insert({ 'table-embed': lastTableHtml });

                quill.history.undoStack.push({
                    redoDelta: redoDelta,
                    undoDelta: undoDelta
                });
                quill.history.redoStack = [];
                quill.editor.delta = quill.editor.delta.compose(redoDelta);

                lastTableHtml = newHtml;
                activeTableBlot = blot;
                notifySave();
            }
        }

        function initializeTableState() {
            var sel = window.getSelection();
            if (!sel || !sel.anchorNode) return;
            var node = sel.anchorNode;
            var embedNode = null;
            while (node && node !== quill.root) {
                if (node.classList && node.classList.contains('ql-table-embed')) {
                    embedNode = node;
                    break;
                }
                node = node.parentNode;
            }
            if (embedNode) {
                var blot = Quill.find(embedNode);
                if (blot) {
                    activeTableBlot = blot;
                    lastTableHtml = embedNode.innerHTML;
                }
            } else {
                activeTableBlot = null;
                lastTableHtml = null;
            }
        }

        quill.root.addEventListener('click', initializeTableState);
        quill.root.addEventListener('keyup', initializeTableState);

        // Listen for user typing / editing inside table cells and save content
        quill.root.addEventListener('input', function(e) {
            var node = e.target;
            var insideTable = false;
            while (node && node !== quill.root) {
                if (node.classList && node.classList.contains('ql-table-embed')) {
                    insideTable = true;
                    break;
                }
                node = node.parentNode;
            }
            if (insideTable) {
                syncTableChange();
            }
        });

        // Resolve format from toolbar clicks
        function getToolbarFormat(target) {
            var btn = target.closest('button[class*="ql-"]');
            if (btn) {
                var formatClass = Array.from(btn.classList).find(c => c.startsWith('ql-') && c !== 'ql-active');
                if (formatClass) {
                    var formatName = formatClass.replace('ql-', '');
                    var value = btn.getAttribute('value') || true;
                    return { name: formatName, value: value, element: btn };
                }
            }
            var item = target.closest('.ql-picker-item');
            if (item) {
                var picker = item.closest('.ql-picker');
                if (picker) {
                    var formatClass = Array.from(picker.classList).find(c => c.startsWith('ql-') && c !== 'ql-picker');
                    if (formatClass) {
                        var formatName = formatClass.replace('ql-', '');
                        var value = item.getAttribute('data-value') || '';
                        return { name: formatName, value: value, element: item };
                    }
                }
            }
            return null;
        }

        // Capturing listener on toolbar to apply formatting to table selections before Quill handles it
        document.getElementById('toolbar').addEventListener('mousedown', function(e) {
            var isPicker = e.target.closest('.ql-picker');
            var info = getToolbarFormat(e.target);
            if (!info && !isPicker) return;

            var sel = window.getSelection();
            if (sel && sel.anchorNode) {
                var node = sel.anchorNode;
                var insideTable = false;
                while (node && node !== quill.root) {
                    if (node.classList && node.classList.contains('ql-table-embed')) {
                        insideTable = true;
                        break;
                    }
                    node = node.parentNode;
                }

                if (insideTable) {
                    // Prevent focus loss when clicking toolbar buttons or picker dropdowns
                    e.preventDefault();
                }
            }
        }, true);

        function insertTableHTML(rows, cols) {
            quill.focus();
            var range = quill.getSelection(true);
            var index = range ? range.index : quill.getLength();

            var tableHtml = '<table><tbody>';
            for (var r = 0; r < rows; r++) { 
                tableHtml += '<tr>'; 
                for (var c = 0; c < cols; c++) { 
                    tableHtml += '<td><br></td>'; 
                } 
                tableHtml += '</tr>'; 
            }
            tableHtml += '</tbody></table>';

            quill.insertEmbed(index, 'table-embed', tableHtml, Quill.sources.USER);
            quill.setSelection(index + 1, Quill.sources.USER);
            // Trigger save
            quill.root.dispatchEvent(new Event('input', { bubbles: true }));
        }

        // Fix: let native browser handle Backspace/Delete/typing inside table cells
        // (Quill's BlockEmbed intercepts keyboard events, so we bypass it when in a table)
        quill.root.addEventListener('keydown', function(e) {
            var sel = window.getSelection();
            if (!sel || !sel.anchorNode) return;

            var node = sel.anchorNode;

            while (node && node !== quill.root) {
                if (
                    node.classList &&
                    node.classList.contains('ql-table-embed')
                ) {

                    // izinkan undo / redo
                    if (
                        e.ctrlKey &&
                        (
                            e.key.toLowerCase() === 'z' ||
                            e.key.toLowerCase() === 'y'
                        )
                    ) {
                        return;
                    }

                    e.stopPropagation();
                    return;
                }

                node = node.parentNode;
            }
        }, true); // capture phase so we run before Quill's own listeners

        function saveTableSelection() {
            var sel = window.getSelection();
            if (!sel || !sel.anchorNode) return null;
            var node = sel.anchorNode;
            
            var cell = null;
            var embedNode = null;
            while (node && node !== quill.root) {
                if (node.nodeName === 'TD' || node.nodeName === 'TH') {
                    cell = node;
                }
                if (node.classList && node.classList.contains('ql-table-embed')) {
                    embedNode = node;
                    break;
                }
                node = node.parentNode;
            }
            if (!cell || !embedNode) return null;

            var row = cell.parentNode;
            var rowIndex = Array.prototype.indexOf.call(row.parentNode.children, row);
            var colIndex = Array.prototype.indexOf.call(row.children, cell);

            var blot = Quill.find(embedNode);
            var embedIndex = blot ? quill.getIndex(blot) : -1;

            var offset = 0;
            var range = sel.getRangeAt(0);
            var preRange = range.cloneRange();
            preRange.selectNodeContents(cell);
            preRange.setEnd(range.endContainer, range.endOffset);
            offset = preRange.toString().length;

            return {
                embedIndex: embedIndex,
                rowIndex: rowIndex,
                colIndex: colIndex,
                offset: offset
            };
        }

        function restoreTableSelection(state) {
            if (!state || state.embedIndex === -1) return;

            var blot = quill.scroll.find(state.embedIndex);
            if (!blot || !blot.domNode) {
                var embeds = quill.root.querySelectorAll('.ql-table-embed');
                if (embeds.length > 0) {
                    blot = Quill.find(embeds[0]);
                }
            }

            if (!blot || !blot.domNode) return;
            var table = blot.domNode.querySelector('table');
            if (!table) return;

            var tbody = table.querySelector('tbody') || table;
            var row = tbody.children[state.rowIndex];
            if (!row) return;
            var cell = row.children[state.colIndex];
            if (!cell) return;

            cell.focus();

            var sel = window.getSelection();
            if (sel) {
                var range = document.createRange();
                var found = false;
                var currentOffset = 0;

                function traverse(node) {
                    if (found) return;
                    if (node.nodeType === Node.TEXT_NODE) {
                        if (currentOffset + node.length >= state.offset) {
                            range.setStart(node, state.offset - currentOffset);
                            range.setEnd(node, state.offset - currentOffset);
                            found = true;
                        } else {
                            currentOffset += node.length;
                        }
                    } else {
                        for (var i = 0; i < node.childNodes.length; i++) {
                            traverse(node.childNodes[i]);
                            if (found) return;
                        }
                    }
                }

                traverse(cell);

                if (!found) {
                    range.selectNodeContents(cell);
                    range.collapse(false);
                }

                sel.removeAllRanges();
                sel.addRange(range);
            }
        }

        var originalUndo = quill.history.undo.bind(quill.history);
        quill.history.undo = function() {
            var state = saveTableSelection();
            originalUndo();
            setTimeout(function() {
                restoreTableSelection(state);
            }, 0);
        };

        var originalRedo = quill.history.redo.bind(quill.history);
        quill.history.redo = function() {
            var state = saveTableSelection();
            originalRedo();
            setTimeout(function() {
                restoreTableSelection(state);
            }, 0);
        };

        // Intercept Ctrl+Z and Ctrl+Y globally to handle them exclusively via Quill history,
        // preventing conflicts with native browser undo/redo outside of table embeds.
        document.addEventListener('keydown', function(e) {
            var active = document.activeElement;
            var insideInput = active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA') && !quill.root.contains(active);
            if (insideInput) {
                return; // Let native undo/redo work for normal input fields outside the editor
            }

            if (e.ctrlKey && e.key.toLowerCase() === 'z') {
                e.preventDefault();
                e.stopPropagation();
                quill.history.undo();
            }
            if (e.ctrlKey && e.key.toLowerCase() === 'y') {
                e.preventDefault();
                e.stopPropagation();
                quill.history.redo();
            }
        }, true); // Use capture phase to prevent browser default behavior early

        // Sanitize colors and backgrounds from pasted HTML to adapt to theme
        function sanitizePastedHtml(doc) {
            var elements = doc.querySelectorAll('[style]');
            elements.forEach(function(el) {
                var style = el.getAttribute('style');
                if (!style) return;
                // Remove black/dark text color
                style = style.replace(/color\s*:\s*(rgb\(0,\s*0,\s*0\)|black|#000000|#000|#1f2328|#24292f|#333333|#333|#1a1a1a)/gi, '');
                // Remove white/light background color
                style = style.replace(/background-color\s*:\s*(rgb\(255,\s*255,\s*255\)|white|#ffffff|#fff)/gi, '');
                if (style.trim() === '') {
                    el.removeAttribute('style');
                } else {
                    el.setAttribute('style', style);
                }
            });
        }

        // Paste interceptor: ONLY handles pasting inside table cells.
        // All other paste (from AI, from files, plain text) is left to Quill's native handler.
        quill.root.addEventListener('paste', function(e) {
            try {
                var sel = window.getSelection();
                if (!sel || !sel.anchorNode) return;

                // Check if cursor is inside a table
                var node = sel.anchorNode;
                var insideTable = false;
                while (node && node !== quill.root) {
                    if (node.classList && node.classList.contains('ql-table-embed')) {
                        insideTable = true;
                        break;
                    }
                    node = node.parentNode;
                }

                // Only intercept when inside a table cell
                if (!insideTable) return;

                var clipboardData = e.clipboardData || window.clipboardData;
                if (!clipboardData) return;

                var html = clipboardData.getData('text/html');
                var text = clipboardData.getData('text/plain');

                e.preventDefault();
                e.stopPropagation();
                withTableGuard(function() {
                    if (html) {
                        console.log('PASTE HTML:', html);

                        var parser = new DOMParser();
                        var doc = parser.parseFromString(html, 'text/html');

                        console.log('BODY HTML:', doc.body.innerHTML);

                        sanitizePastedHtml(doc);

                        document.execCommand(
                            'insertHTML',
                            false,
                            doc.body.innerHTML
                        );
                    } else if (text) {
                        document.execCommand('insertText', false, text);
                    }
                });
            } catch(err) {
                // If anything goes wrong, don't block Quill's native handler
                console.error('Notely paste handler error:', err);
            }
        }, true);


        function getCell() {
            var sel = window.getSelection();
            if (!sel || !sel.anchorNode) return null;
            var n = sel.anchorNode;
            while (n && n !== quill.root) { if (n.nodeName === 'TD' || n.nodeName === 'TH') return n; n = n.parentNode; }
            return null;
        }

        // ======== Custom Table Grid Logic ========
        var grid = document.getElementById('table-grid');
        for (var r = 0; r < 10; r++) {
            for (var c = 0; c < 10; c++) {
                var cell = document.createElement('div');
                cell.className = 'grid-cell';
                cell.setAttribute('data-row', String(r + 1));
                cell.setAttribute('data-col', String(c + 1));
                grid.appendChild(cell);
                cell.addEventListener('mouseover', function(e) {
                    var row = parseInt(e.target.getAttribute('data-row'));
                    var col = parseInt(e.target.getAttribute('data-col'));
                    document.getElementById('table-grid-label').innerText = col + ' x ' + row;
                    var cells = document.querySelectorAll('.grid-cell');
                    for (var i = 0; i < cells.length; i++) {
                        var r2 = parseInt(cells[i].getAttribute('data-row'));
                        var c2 = parseInt(cells[i].getAttribute('data-col'));
                        if (r2 <= row && c2 <= col) { cells[i].classList.add('selected'); }
                        else { cells[i].classList.remove('selected'); }
                    }
                });
                cell.addEventListener('click', function(e) {
                    var row = parseInt(e.target.getAttribute('data-row'));
                    var col = parseInt(e.target.getAttribute('data-col'));
                    insertTableHTML(row, col);
                    document.getElementById('table-dropdown').classList.add('hidden');
                });
            }
        }

        document.getElementById('custom-table').addEventListener('click', function(e) {
            document.getElementById('table-dropdown').classList.toggle('hidden');
            e.stopPropagation();
        });

        document.addEventListener('click', function(e) {
            if (!e.target.closest('.custom-dropdown-container')) {
                document.getElementById('table-dropdown').classList.add('hidden');
            }
        });

        document.getElementById('table-input-btn').addEventListener('click', function(e) {
            var rows = parseInt(document.getElementById('table-input-rows').value);
            var cols = parseInt(document.getElementById('table-input-cols').value);
            if (!isNaN(rows) && !isNaN(cols) && rows > 0 && cols > 0) {
                insertTableHTML(rows, cols);
            }
            document.getElementById('table-dropdown').classList.add('hidden');
            e.stopPropagation();
        });

        // ======== Table Row/Col Add/Delete ========
        document.getElementById('add-row').addEventListener('click', function() {
            var td = getCell(); if (!td) return;
            var row = td.closest('tr'); if (!row) return;
            withTableGuard(function() {
                var nr = row.cloneNode(true);
                var tds = nr.querySelectorAll('td,th'); for(var i=0;i<tds.length;i++) tds[i].innerHTML='<br>';
                row.parentNode.insertBefore(nr, row.nextSibling);
            });
        });
        document.getElementById('add-col').addEventListener('click', function() {
            var td = getCell(); if (!td) return;
            var row = td.closest('tr'); if (!row) return;
            var ci = Array.prototype.indexOf.call(row.children, td);
            var tbl = td.closest('table'); if (!tbl) return;
            withTableGuard(function() {
                var rows = tbl.querySelectorAll('tr');
                for(var i=0;i<rows.length;i++){var ref=rows[i].children[ci];var nc=document.createElement('td');nc.innerHTML='<br>';if(ref&&ref.nextSibling)rows[i].insertBefore(nc,ref.nextSibling);else rows[i].appendChild(nc);}
            });
        });
        document.getElementById('del-row').addEventListener('click', function() {
            var td = getCell(); if (!td) return;
            var row = td.closest('tr'); if (!row) return;
            var tbl = row.closest('table');
            var embed = row.closest('.ql-table-embed');
            withTableGuard(function() {
                row.parentNode.removeChild(row);
                if (tbl && tbl.querySelectorAll('tr').length === 0) {
                    if (embed) embed.parentNode.removeChild(embed);
                    else tbl.parentNode.removeChild(tbl);
                }
            });
        });
        document.getElementById('del-col').addEventListener('click', function() {
            var td = getCell(); if (!td) return;
            var row = td.closest('tr'); if (!row) return;
            var ci = Array.prototype.indexOf.call(row.children, td);
            var tbl = td.closest('table'); if (!tbl) return;
            var embed = td.closest('.ql-table-embed');
            withTableGuard(function() {
                var rows = tbl.querySelectorAll('tr');
                for(var i=0;i<rows.length;i++){var t=rows[i].children[ci];if(t)rows[i].removeChild(t);}
                if(tbl.querySelector('tr')&&tbl.querySelector('tr').children.length===0) {
                    if (embed) embed.parentNode.removeChild(embed);
                    else tbl.parentNode.removeChild(tbl);
                }
            });
        });

        function updateTableActionsVisibility() {
            var inTable = false;
            var sel = window.getSelection();
            if (sel && sel.anchorNode) {
                var node = sel.anchorNode;
                while (node && node !== quill.root) {
                    if (node.nodeName === 'TABLE' || node.nodeName === 'TD' || node.nodeName === 'TH') { inTable = true; break; }
                    node = node.parentNode;
                }
            }
            document.getElementById('table-actions').style.display = inTable ? 'flex' : 'none';
        }

        quill.on('selection-change', updateTableActionsVisibility);
        quill.root.addEventListener('click', updateTableActionsVisibility);
        quill.root.addEventListener('keyup', updateTableActionsVisibility);

        // Initialize with existing content
        const initialContent = \`${this.item.content || ''}\`;
        quill.clipboard.dangerouslyPasteHTML(initialContent);

        // Restore focus ketika kembali ke tab webview
        function isEditorFocused() {
            return document.activeElement && 
                   (document.activeElement === quill.root || quill.root.contains(document.activeElement));
        }

        window.addEventListener('focus', () => {
            if (isEditorFocused()) {
                return;
            }
            setTimeout(() => {
                if (isEditorFocused()) {
                    return;
                }
                quill.focus();
            }, 10);
        });

        document.addEventListener('visibilitychange', () => {
            if (!document.hidden) {
                if (isEditorFocused()) {
                    return;
                }
                setTimeout(() => {
                    if (isEditorFocused()) {
                        return;
                    }
                    quill.focus();
                }, 10);
            }
        });
        
        window.addEventListener('message', event => {
            const message = event.data;

            if (message.command === 'restoreFocus') {
                if (isEditorFocused()) {
                    return;
                }
                const range = quill.getSelection();

                setTimeout(() => {
                    if (isEditorFocused()) {
                        return;
                    }
                    quill.focus();

                    if (range) {
                        quill.setSelection(range.index, range.length);
                    } else {
                        quill.setSelection(quill.getLength(), 0);
                    }
                }, 50);
            }
        });

        // Notify VS Code when content changes
        function notifySave() {
            var html = quill.root.innerHTML;
            vscode.postMessage({
                command: 'updateContent',
                text: html
            });
        }
        let saveTimer;

        quill.on('text-change', function() {
            clearTimeout(saveTimer);

            saveTimer = setTimeout(() => {
                notifySave();
            }, 300);
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

    const handleExport = async (item: NoteItem, format: string) => {
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

        const targetSelected = await vscode.window.showQuickPick([
            { label: 'Export to current Project Root', isRoot: true },
            { label: 'Choose custom location...', isRoot: false }
        ], { placeHolder: `Select export location for ${format}` });

        if (!targetSelected) {
            return;
        }

        let finalUri: vscode.Uri | undefined;

        if (targetSelected.isRoot && rootPath) {
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
                handleExport(item, '.md');
            }
        })
    );
    
    context.subscriptions.push(
        vscode.commands.registerCommand('notely.export.doc', (item: NoteItem) => {
            if (item && !item.isFolder) {
                handleExport(item, '.doc');
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('notely.export.txt', (item: NoteItem) => {
            if (item && !item.isFolder) {
                handleExport(item, '.txt');
            }
        })
    );

    // ========== IMPORT NOTE ==========
    context.subscriptions.push(
        vscode.commands.registerCommand('notely.import', async (item: NoteItem) => {
            const fileUri = await vscode.window.showOpenDialog({
                canSelectMany: false,
                filters: {
                    'Documents': ['md', 'doc', 'txt'],
                    'All Files': ['*']
                }
            });

            if (fileUri && fileUri[0]) {
                const content = fs.readFileSync(fileUri[0].fsPath, 'utf8');

                // Determine file type based on extension
                const ext = path.extname(fileUri[0].fsPath).toLowerCase();
                let parsedContent = content;

                if (ext === '.md') {
                    // Markdown - use as is
                    parsedContent = content;
                } else if (ext === '.doc') {
                    // Word Document - convert from HTML
                    const turndownService = new TurndownService();
                    turndownService.use(turndownPluginGfm.gfm);
                    parsedContent = turndownService.turndown(content);
                } else if (ext === '.txt') {
                    // Text file - convert HTML tags to new lines
                    parsedContent = content.replace(/<[^>]+>/g, '\n').replace(/\n+/g, '\n').trim();
                }

                // Create a new note with the imported content
                provider.addNote(path.basename(fileUri[0].fsPath, ext), item);
                const newItem = provider.items[provider.items.length - 1];
                newItem.content = parsedContent;
                provider.save();
            }
        })
    );
}