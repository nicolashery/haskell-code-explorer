# Haskell Code Explorer VSCode Extension

This is a [Visual Studio Code](https://code.visualstudio.com/) extension that leverages the index created by `haskell-code-indexer` and the HTTP API of `haskell-code-server`, to provide some code-intelligence features in VSCode.

**Important**:

- This is not meant to be a fully-fledged IDE for Haskell in VSCode. Like the Haskell Code Explorer web app, it is more of a tool to explore a Haskell codebase using VSCode. It will not pick up edits you make to Haskell files, you will need to manually re-index and restart the server.
- This does not provide all of the features of the Haskell Code Explorer web app. It does support some useful ones (see below), and is a nice alternative if you prefer to use VSCode instead of the web app.

**Status**: Experimental.

## Features

- **Types on hover**
- **Got to definition** (works cross-packages)
- **Find references** (works cross-packages)

## Installation

Clone this repository and follow the instructions in the top-level README to build `haskell-code-indexer` and `haskell-code-server`.

Make sure you have [Node.js](https://nodejs.org/) installed, then install the [vsce](https://code.visualstudio.com/api/working-with-extensions/publishing-extension#vsce) tool:

```
npm install -g vsce
```

Then, from this `vscode-extension/` directory, run:

```
npm install
vsce package
```

This will create a `haskell-code-explorer-0.0.1.vsix` file, which you can add to VSCode with:

```
code --install-extension haskell-code-explorer-0.0.1.vsix
```

If you need to re-package after making or pulling some changes, make sure to clean up the previous `.vsix` file before:

```
rm haskell-code-explorer-0.0.1.vsix
vsce package
```

## Usage

Index one or more package (make sure your packages are built first, as explained in the top-level README):

```
haskell-code-indexer --package <package1_path>
haskell-code-indexer --package <package2_path>
[...]
```

This will create a `.haskell-code-explorer/` directory in each package path. The extension activates when it sees such a directory in your VSCode workspace tree.

Launch the the server, loading the packages you indexed:

```
haskell-code-server --package <package1_path> --package <package2_path>
```

Open VSCode:

```
code .
```

You should now be able the use the [Features](#features) listed earlier.

## Extension Settings

This extension has the following settings:

- `haskellCodeExplorer.host`: point to a different Haskell Code Explorer server host (default `http://localhost:8080`)

## Workflow

As mentioned above, this extension is mostly useful as a "read-only" tool, to explore an existing Haskell codebase.

If you make changes to some Haskell files, you will quickly notice that for those files, types stop showing on hover, jumping to definition doesn't work anymore, etc. This is simply because the index is outdated compared to what is in the editor.

After changes to the source code, you can refresh the index by following this workflow:

- Kill the Haskell Code Explorer server (`Ctrl+C`)
- Re-build the package that changed (for example using `stack build` or `cabal new-build`)
- Re-index the package with `haskell-code-indexer`
- Re-launch the server with `haskell-code-server`
- Close and re-open VSCode to clear the extension cache

## Developing

To make changes to the extension itself, make sure you open VSCode inside this `vscode-extension/` directory:

```
code vscode-extension/
```

Then hit `F5` (or `Debug > Start Debugging`). In the new window that appears, open any Haskell project that you've indexed with Haskell Code Explorer.
