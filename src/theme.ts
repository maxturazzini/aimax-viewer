// Theme tokens for the viewer's own chrome: toolbars, menus, popups, the
// annotation window and the Claude Bridge dropdown. Every webview gets the
// active VS Code theme as `--vscode-*` CSS variables on <html>, and VS Code
// rewrites them live when the theme changes, so the chrome follows the theme
// with no listener and no reload. The fallbacks are the old fixed dark palette:
// if a variable is missing (an old VS Code, a theme that leaves a colour
// undefined) the chrome degrades to what it looked like before.
//
// The prefix is `--axv-` on purpose. In the Home Panel the chrome shares one
// document with the artifact AND with the injected annotation client, which
// already owns `--aimax-*` on :root. A distinct prefix keeps the three apart.
//
// Mode hues (annotate, edit, draw, save) come from `--vscode-charts-*`: VS Code
// calibrates those per theme, so they stay readable on light backgrounds where
// the old #00d4ff cyan was not (about 1.8:1 on white).
//
// Not covered here: the overlays drawn *inside* the artifact iframe by
// annotation-client.ts (badges, outlines, comment bubble). That document is
// served over HTTP and never receives the `--vscode-*` variables.
export const THEME_CSS = `
        :root {
            /* Surfaces and text */
            --axv-bg: var(--vscode-editor-background, #1e1e1e);
            --axv-fg: var(--vscode-foreground, #cccccc);
            --axv-fg-muted: var(--vscode-descriptionForeground, #9d9d9d);
            --axv-icon: var(--vscode-icon-foreground, #c5c5c5);
            --axv-border: var(--vscode-contrastBorder, var(--vscode-panel-border, rgba(128, 128, 128, 0.35)));
            --axv-focus: var(--vscode-focusBorder, #007fd4);
            --axv-link: var(--vscode-textLink-foreground, #3794ff);
            --axv-hover-bg: var(--vscode-toolbar-hoverBackground, rgba(90, 93, 94, 0.31));
            --axv-list-hover-bg: var(--vscode-list-hoverBackground, #2a2d2e);
            --axv-error: var(--vscode-errorForeground, #f48771);

            /* Toolbar: continues the active editor tab */
            --axv-toolbar-bg: var(--vscode-tab-activeBackground, var(--vscode-editor-background, #1e1e1e));
            --axv-toolbar-line: var(--vscode-focusBorder, #007fd4);

            /* Fields */
            --axv-input-bg: var(--vscode-input-background, #3c3c3c);
            --axv-input-fg: var(--vscode-input-foreground, #cccccc);
            --axv-input-border: var(--vscode-input-border, var(--axv-border));
            --axv-dropdown-bg: var(--vscode-dropdown-background, #3c3c3c);
            --axv-dropdown-fg: var(--vscode-dropdown-foreground, #cccccc);
            --axv-dropdown-border: var(--vscode-dropdown-border, var(--axv-border));
            --axv-dropdown-list-bg: var(--vscode-dropdown-listBackground, var(--axv-dropdown-bg));

            /* Menus */
            --axv-menu-bg: var(--vscode-menu-background, var(--axv-dropdown-bg));
            --axv-menu-fg: var(--vscode-menu-foreground, var(--axv-dropdown-fg));
            --axv-menu-border: var(--vscode-menu-border, var(--axv-border));
            --axv-menu-sel-bg: var(--vscode-menu-selectionBackground, var(--vscode-list-activeSelectionBackground, #04395e));
            --axv-menu-sel-fg: var(--vscode-menu-selectionForeground, var(--vscode-list-activeSelectionForeground, #ffffff));
            --axv-menu-sep: var(--vscode-menu-separatorBackground, var(--axv-border));

            /* Popups and panels */
            --axv-widget-bg: var(--vscode-editorWidget-background, #252526);
            --axv-widget-fg: var(--vscode-editorWidget-foreground, var(--axv-fg));
            --axv-widget-border: var(--vscode-editorWidget-border, var(--axv-border));
            --axv-tooltip-bg: var(--vscode-editorHoverWidget-background, var(--axv-widget-bg));
            --axv-tooltip-fg: var(--vscode-editorHoverWidget-foreground, var(--axv-widget-fg));
            --axv-tooltip-border: var(--vscode-editorHoverWidget-border, var(--axv-widget-border));
            --axv-header-bg: var(--vscode-sideBarSectionHeader-background, rgba(128, 128, 128, 0.2));
            --axv-code-bg: var(--vscode-textCodeBlock-background, rgba(10, 10, 10, 0.4));
            --axv-shadow: var(--vscode-widget-shadow, rgba(0, 0, 0, 0.36));

            /* Buttons */
            --axv-button-bg: var(--vscode-button-background, #0e639c);
            --axv-button-fg: var(--vscode-button-foreground, #ffffff);

            /* Mode hues: they carry meaning, so they stay coloured */
            --axv-annot: var(--vscode-charts-blue, #3794ff);
            --axv-edit: var(--vscode-charts-orange, #d18616);
            --axv-draw: var(--vscode-charts-purple, #b180d7);
            --axv-save: var(--vscode-charts-green, #89d185);
            --axv-notes: var(--vscode-charts-yellow, #cca700);
            /* Ink for a number sitting on the annotate hue */
            --axv-on-annot: var(--axv-bg);
        }
        /* Toolbar icons that announce a mode keep its hue even at rest */
        .axv-ic-annot { color: var(--axv-annot); }
        .axv-ic-edit { color: var(--axv-edit); }
`;
