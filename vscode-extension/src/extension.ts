import * as path from "path";
import * as fs from "fs";
import * as vscode from "vscode";
import axios, { AxiosRequestConfig } from "axios";

import * as hce from "./hce";

function mapFromObject<K, V>(obj: { [k: string]: V }): Map<K, V> {
  let keyValuePairs = Object.keys(obj).map(k => [k, obj[k]]);
  // @ts-ignore: only accepts `ReadOnlyArray<K,V>`
  return new Map(keyValuePairs);
}

type AbsoluteFilePath = string;

type DefinitionSiteUri = string;

type ReferenceWithPackageId = {
  packageIdString: string;
  idSrcSpan: hce.IdentifierSrcSpan;
};

type PackageInfo = {
  packageId: hce.PackageId;
  packageFolder: AbsoluteFilePath;
};

/**
 * Modified version of the `wordPattern` found in
 * https://github.com/JustusAdam/language-haskell, to match Haskell Code
 * Explorer's "occurences"
 * - Added matching `.` characters as part of a word, so that for example
 *   `T.pack` is matched as a single word (instead of 2 words `T` and `pack`)
 * - Dropped the part matching numerical primitives (ex: `1.23E-4`), to
 *   simplifiy and because it is less useful in the context of Haskell Code
 *   Explorer
 *
 * Note: This does not match operators like `<$>`, `>>=`, `(+)`, etc.
 */
const WORD_PATTERN = /[\w'_][\w'_.\d]*/;

const DEFAULT_HCE_HOST = "http://localhost:8080";

const STATIC_URL_PREFIX = "files";
const API_URL_PREFIX = "api";
const HCE_INDEX_DIRECTORY = ".haskell-code-explorer";

type GlobalState = {
  haskellModules: Map<AbsoluteFilePath, hce.ModuleInfo>;
  definitionSites: Map<DefinitionSiteUri, hce.DefinitionSite>;
  references: Map<hce.ExternalId, ReferenceWithPackageId[]>;
  haskellPackages: PackageInfo[];
};

const globalState: GlobalState = {
  haskellModules: new Map(),
  definitionSites: new Map(),
  references: new Map(),
  haskellPackages: []
};

const HASKELL_MODE: vscode.DocumentSelector = {
  scheme: "file",
  language: "haskell"
};

function haskellModuleUrl(
  packageInfo: PackageInfo,
  document: vscode.TextDocument
): string {
  return (
    getHceHost() +
    "/" +
    STATIC_URL_PREFIX +
    "/" +
    packageIdToString(packageInfo.packageId) +
    "/" +
    HCE_INDEX_DIRECTORY +
    "/" +
    // Note: we encodeURI twice because the filename is already URI-encoded
    encodeURIComponent(
      encodeURIComponent(
        path.relative(packageInfo.packageFolder, document.uri.path)
      )
    ) +
    ".json"
  );
}

function definitionSiteUrl(locationInfo: hce.LocationInfo): string {
  const definitionSiteUri = getDefinitionSiteUri(locationInfo);
  return (
    getHceHost() + "/" + API_URL_PREFIX + "/definitionSite/" + definitionSiteUri
  );
}

// "." and ".." is a special case because of the Path Segment Normalization:
// https://tools.ietf.org/html/rfc3986#section-6.2.2.3
// The segments “..” and “.” can be removed from a URL by a browser.
// https://stackoverflow.com/questions/3856693/a-url-resource-that-is-a-dot-2e
function fixUrlDots(str: string): string {
  if (str === ".") {
    return "%20%2E";
  } else if (str === "..") {
    return "%20%2E%2E";
  } else {
    return str.replace(/\./g, "%2E");
  }
}

function globalReferencesUrl(externalId: string): string {
  return (
    getHceHost() +
    "/" +
    API_URL_PREFIX +
    "/globalReferences/" +
    encodeURIComponent(externalId)
  );
}

function referencesUrl(packageId: string, externalId: string): string {
  return (
    getHceHost() +
    "/" +
    API_URL_PREFIX +
    "/references/" +
    packageId +
    "/" +
    encodeURIComponent(externalId) +
    "?per_page=500" // some big enough number to get all references in package
  );
}

async function fetch<T>(
  url: string,
  config?: AxiosRequestConfig
): Promise<T | undefined> {
  console.log(`[Fetch] ${url}`);

  try {
    const response = await axios.get(url, config);
    if (!response.data) {
      return;
    }

    return response.data;
  } catch (err) {
    if (err.code === "ECONNREFUSED") {
      console.warn(`[WARN] haskell-code-server not running at ${getHceHost()}`);
      return;
    }

    if (err.response && err.response.status === 404) {
      console.log(`404 Not Found: ${url}`);
      return;
    }

    console.error(`Failed to fetch ${url}`);
    console.error(err);
  }
}

async function fetchHaskellModule(
  packageInfo: PackageInfo,
  document: vscode.TextDocument
): Promise<hce.ModuleInfo | undefined> {
  const url = haskellModuleUrl(packageInfo, document);
  const data: hce.HaskellModuleResponse | undefined = await fetch(url, {
    headers: {
      "Accept-Encoding": "gzip"
    }
  });
  if (!data) {
    return;
  }

  const moduleInfo: hce.ModuleInfo = {
    identifiers: mapFromObject(data.identifiers),
    occurrences: mapFromObject(data.occurrences)
  };
  globalState.haskellModules.set(document.uri.path, moduleInfo);
  return moduleInfo;
}

async function fetchDefinitionSite(
  locationInfo: hce.LocationInfo
): Promise<hce.DefinitionSite | null | undefined> {
  const definitionSiteUri = getDefinitionSiteUri(locationInfo);
  // We should only be fetching definition sites for approximate locations, so
  // this is not suppose to happen
  if (!definitionSiteUri) {
    return;
  }

  const url = definitionSiteUrl(locationInfo);
  const definitionSite: hce.DefinitionSite | undefined = await fetch(url);
  if (!definitionSite) {
    return;
  }

  globalState.definitionSites.set(definitionSiteUri, definitionSite);
  return definitionSite;
}

async function fetchAllReferences(
  externalId: hce.ExternalId
): Promise<ReferenceWithPackageId[] | null | undefined> {
  const globalUrl = globalReferencesUrl(externalId);

  const globalReferences: hce.GlobalReferences[] | undefined = await fetch(
    globalUrl
  );
  if (!globalReferences) {
    return;
  }

  const result: ReferenceWithPackageId[][] = await Promise.all(
    globalReferences.map(globalReference =>
      fetchReferencesInPackage(globalReference.packageId, externalId)
    )
  );

  let references: ReferenceWithPackageId[] = [];
  result.forEach(item => {
    references = references.concat(item);
  });

  globalState.references.set(externalId, references);
  return references;
}

async function fetchReferencesInPackage(
  packageIdString: string,
  externalId: string
): Promise<ReferenceWithPackageId[]> {
  const url = referencesUrl(packageIdString, externalId);
  const sourceFiles: hce.SourceFile[] | undefined = await fetch(url);
  if (!sourceFiles) {
    return [];
  }

  let references: ReferenceWithPackageId[] = [];
  sourceFiles.forEach(sourceFile => {
    // Keep track of packageId for each reference
    const enhancedReferences: ReferenceWithPackageId[] = sourceFile.references.map(
      x => ({
        packageIdString: packageIdString,
        idSrcSpan: x.idSrcSpan
      })
    );
    references = references.concat(enhancedReferences);
  });

  return references;
}

function getDefinitionSiteUri(
  locationInfo: hce.LocationInfo
): DefinitionSiteUri | undefined {
  if (locationInfo.tag !== "ApproximateLocation") {
    return;
  }

  const name =
    locationInfo.entity === "Mod" ? locationInfo.moduleName : locationInfo.name;
  return (
    packageIdToString(locationInfo.packageId) +
    "/" +
    locationInfo.componentId +
    "/" +
    locationInfo.moduleName +
    "/" +
    locationInfo.entity +
    "/" +
    fixUrlDots(name)
  );
}

class HceHoverProvider implements vscode.HoverProvider {
  public provideHover(
    document: vscode.TextDocument,
    position: vscode.Position
  ): vscode.ProviderResult<vscode.Hover> {
    const wordRange = getWordRangeAtPosition(document, position);
    if (!wordRange) {
      logHover(document, position, wordRange, "Could not get word range");
      return;
    }

    // Not that we expect an identifier to span multiple lines,
    // but you never know
    if (wordRange.start.line !== wordRange.end.line) {
      logHover(
        document,
        position,
        wordRange,
        "Identifier spans multiple lines"
      );
      return;
    }

    const moduleInfo = globalState.haskellModules.get(document.uri.path);
    if (!moduleInfo) {
      fetchModuleInfo(document);
      logHover(document, position, wordRange, "Module info not available");
      return;
    }

    const occurrenceId = wordRangeToOccurrenceId(wordRange);
    const occurrence = moduleInfo.occurrences.get(occurrenceId);
    if (!occurrence) {
      logHover(document, position, wordRange, "Could not find occurence");
      return;
    }

    if (occurrence.sort.tag === "ModuleId") {
      const hoverInfo = getModuleHoverInfo(occurrence.sort.contents);
      if (!hoverInfo) {
        logHover(document, position, wordRange, "No info for module");
        return;
      }

      return {
        contents: [{ language: "haskell", value: hoverInfo }],
        range: wordRange
      };
    }

    const internalId = occurrence.internalId;
    if (!internalId) {
      logHover(document, position, wordRange, "No internalId");
      return;
    }

    const identifier = moduleInfo.identifiers.get(internalId);
    // Not expected to happen, but just in case
    if (!identifier) {
      logHover(document, position, wordRange, "Could not find identifier");
      return;
    }

    const contents: vscode.MarkedString[] = [
      {
        language: "haskell",
        value: getExpressionType(identifier, identifier.idType)
      }
    ];

    if (occurrence.idOccType) {
      contents.push(
        new vscode.MarkdownString(
          "Instantiated type:\n\n" +
            "```haskell\n" +
            getExpressionType(identifier, occurrence.idOccType) +
            "\n```"
        )
      );
    }

    const locationInfo = identifier.locationInfo;
    if (locationInfo.tag === "ApproximateLocation") {
      contents.push(
        new vscode.MarkdownString(
          "Defined in package `" +
            locationInfo.packageId.name +
            "` module `" +
            locationInfo.moduleName +
            "`"
        )
      );
    } else if (locationInfo.tag === "ExactLocation") {
      contents.push(
        new vscode.MarkdownString(
          "Defined in `" +
            locationInfo.modulePath +
            "` line `" +
            locationInfo.startLine +
            "` column `" +
            locationInfo.startColumn +
            "`"
        )
      );
    }

    return {
      contents: contents,
      range: wordRange
    };
  }
}

function logHover(
  document: vscode.TextDocument,
  position: vscode.Position,
  maybeWordRange: vscode.Range | undefined,
  message: string
) {
  console.log(
    "[Hover]",
    message,
    getRelativeFilePath(document),
    maybeWordRange ? document.getText(maybeWordRange) : "<NA>",
    position.line,
    position.character
  );
}

function getModuleHoverInfo(location: hce.LocationInfo): string | undefined {
  if (location.tag === "UnknownLocation") {
    return;
  }

  return [
    location.tag === "ExactLocation"
      ? "{- " + location.modulePath + " -}\n"
      : "",
    "module ",
    location.moduleName
  ].join("");
}

class HceDefinitionProvider implements vscode.DefinitionProvider {
  public async provideDefinition(
    document: vscode.TextDocument,
    position: vscode.Position
  ): Promise<vscode.Location | null | undefined> {
    const wordRange = getWordRangeAtPosition(document, position);
    if (!wordRange) {
      logDefinition(document, position, wordRange, "Could not get word range");
      return;
    }

    // Not that we expect an identifier to span multiple lines,
    // but you never know
    if (wordRange.start.line !== wordRange.end.line) {
      logDefinition(
        document,
        position,
        wordRange,
        "Identifier spans multiple lines"
      );
      return;
    }

    const moduleInfo = globalState.haskellModules.get(document.uri.path);
    if (!moduleInfo) {
      fetchModuleInfo(document);
      logDefinition(document, position, wordRange, "No info for module");
      return;
    }

    const occurrenceId = wordRangeToOccurrenceId(wordRange);
    const occurrence = moduleInfo.occurrences.get(occurrenceId);
    if (!occurrence) {
      logDefinition(document, position, wordRange, "Could not find occurence");
      return;
    }

    if (occurrence.sort.tag === "ModuleId") {
      return provideDefinitionFromLocationInfo(
        document,
        position,
        wordRange,
        occurrence.sort.contents
      );
    }

    const internalId = occurrence.internalId;
    if (!internalId) {
      logDefinition(document, position, wordRange, "No internalId");
      return;
    }

    const identifier = moduleInfo.identifiers.get(internalId);
    // Not expected to happen, but just in case
    if (!identifier) {
      logDefinition(document, position, wordRange, "Could not find identifier");
      return;
    }

    if (occurrence.isBinder) {
      logDefinition(document, position, wordRange, "Occurence is binder");
      return;
    }

    return provideDefinitionFromLocationInfo(
      document,
      position,
      wordRange,
      identifier.locationInfo
    );
  }
}

async function provideDefinitionFromLocationInfo(
  document: vscode.TextDocument,
  position: vscode.Position,
  wordRange: vscode.Range,
  locationInfo: hce.LocationInfo
): Promise<vscode.Location | null | undefined> {
  if (locationInfo.tag === "ExactLocation") {
    return haskellLocationtoVscodeLocation(locationInfo);
  }

  const definitionSiteUri = getDefinitionSiteUri(locationInfo);
  // We already handled the case of "ExactLocation", so this can only happen if we have an "UnknownLocation"
  if (!definitionSiteUri) {
    logDefinition(
      document,
      position,
      wordRange,
      "Could not get URI for location info"
    );
    return;
  }

  const cachedDefinitionSite = globalState.definitionSites.get(
    definitionSiteUri
  );
  if (cachedDefinitionSite) {
    if (cachedDefinitionSite.location.tag === "ExactLocation") {
      return haskellLocationtoVscodeLocation(cachedDefinitionSite.location);
    }

    logDefinition(
      document,
      position,
      wordRange,
      "Cached item is not exact location"
    );
    return;
  }

  const definitionSite = await fetchDefinitionSite(locationInfo);

  if (!definitionSite) {
    logDefinition(
      document,
      position,
      wordRange,
      "Could not fetch definition site"
    );
    return;
  }

  if (definitionSite.location.tag === "ExactLocation") {
    return haskellLocationtoVscodeLocation(definitionSite.location);
  }

  logDefinition(
    document,
    position,
    wordRange,
    "Location is not exact location"
  );
  return;
}

function logDefinition(
  document: vscode.TextDocument,
  position: vscode.Position,
  maybeWordRange: vscode.Range | undefined,
  message: string
) {
  console.log(
    "[Definition]",
    message,
    getRelativeFilePath(document),
    maybeWordRange ? document.getText(maybeWordRange) : "<NA>",
    position.line,
    position.character
  );
}

class HceReferenceProvider implements vscode.ReferenceProvider {
  public async provideReferences(
    document: vscode.TextDocument,
    position: vscode.Position
  ): Promise<vscode.Location[] | null | undefined> {
    const wordRange = getWordRangeAtPosition(document, position);
    if (!wordRange) {
      logReference(document, position, wordRange, "Could not get word range");
      return;
    }

    // Not that we expect an identifier to span multiple lines,
    // but you never know
    if (wordRange.start.line !== wordRange.end.line) {
      logReference(
        document,
        position,
        wordRange,
        "Identifier spans multiple lines"
      );
      return;
    }

    const moduleInfo = globalState.haskellModules.get(document.uri.path);
    if (!moduleInfo) {
      fetchModuleInfo(document);
      logReference(document, position, wordRange, "No module info");
      return;
    }

    const occurrenceId = wordRangeToOccurrenceId(wordRange);
    const occurrence = moduleInfo.occurrences.get(occurrenceId);
    if (!occurrence) {
      logReference(document, position, wordRange, "Could not find occurence");
      return;
    }

    const internalId = occurrence.internalId;
    if (!internalId) {
      logReference(document, position, wordRange, "No internalId");
      return;
    }

    const identifier = moduleInfo.identifiers.get(internalId);
    // Not expected to happen, but just in case
    if (!identifier) {
      logReference(document, position, wordRange, "Could not find identifier");
      return;
    }

    const externalId = identifier.externalId;
    if (!externalId) {
      logReference(document, position, wordRange, "No externalId");
      return;
    }

    const cachedReferences = globalState.references.get(externalId);
    if (cachedReferences) {
      return haskellReferencesToVscodeLocations(cachedReferences);
    }

    const references = await fetchAllReferences(externalId);

    if (!references) {
      logReference(document, position, wordRange, "Could not fetch references");
      return;
    }

    return haskellReferencesToVscodeLocations(references);
  }
}

function logReference(
  document: vscode.TextDocument,
  position: vscode.Position,
  maybeWordRange: vscode.Range | undefined,
  message: string
) {
  console.log(
    "[Reference]",
    message,
    getRelativeFilePath(document),
    maybeWordRange ? document.getText(maybeWordRange) : "<NA>",
    position.line,
    position.character
  );
}

function getWordRangeAtPosition(
  document: vscode.TextDocument,
  position: vscode.Position
): vscode.Range | undefined {
  return document.getWordRangeAtPosition(position, WORD_PATTERN);
}

function packageIdToString(packageId: hce.PackageId): string {
  return packageId.name + "-" + packageId.version;
}

function haskellLocationtoVscodeLocation(
  locationInfo: hce.LocationInfo
): vscode.Location | null {
  if (locationInfo.tag !== "ExactLocation") {
    return null;
  }

  const packageFolderPath = packageIdToFolderPath(
    packageIdToString(locationInfo.packageId)
  );
  if (!packageFolderPath) {
    return null;
  }

  const filePath = packageFolderPath + "/" + locationInfo.modulePath;
  const uri = vscode.Uri.file(filePath);
  // Note that VSCode lines/columns are 0-based, and Haskell Code Explorer start at 1
  const range = new vscode.Range(
    locationInfo.startLine - 1,
    locationInfo.startColumn - 1,
    locationInfo.endLine - 1,
    locationInfo.endColumn - 1
  );

  return new vscode.Location(uri, range);
}

function haskellReferencesToVscodeLocations(
  references: ReferenceWithPackageId[]
): vscode.Location[] {
  const result: vscode.Location[] = [];
  references.forEach(reference => {
    const location = haskellReferenceToVscodeLocation(reference);
    if (!location) {
      return;
    }

    result.push(location);
  });

  return result;
}

function haskellReferenceToVscodeLocation(
  reference: ReferenceWithPackageId
): vscode.Location | null {
  const packageFolderPath = packageIdToFolderPath(reference.packageIdString);
  if (!packageFolderPath) {
    return null;
  }

  const filePath = packageFolderPath + "/" + reference.idSrcSpan.modulePath;
  const uri = vscode.Uri.file(filePath);
  // Note that VSCode lines/columns are 0-based, and Haskell Code Explorer start at 1
  const range = new vscode.Range(
    reference.idSrcSpan.line - 1,
    reference.idSrcSpan.startColumn - 1,
    reference.idSrcSpan.line - 1,
    reference.idSrcSpan.endColumn - 1
  );

  return new vscode.Location(uri, range);
}

function packageIdToFolderPath(
  packageIdString: string
): AbsoluteFilePath | undefined {
  const packageInfo = globalState.haskellPackages.find(
    p => packageIdToString(p.packageId) === packageIdString
  );
  if (!packageInfo) {
    return;
  }

  return packageInfo.packageFolder;
}

function getTypeSignature(type: hce.Type): string {
  return type.components
    .map(typeComponent => {
      if (typeComponent.tag === "Text") {
        return typeComponent.contents;
      } else {
        return typeComponent.name;
      }
    })
    .join("");
}

function getExpressionType(
  identifier: hce.IntentifierInfo,
  type: hce.Type
): string {
  const name = identifier.demangledOccName
    ? identifier.demangledOccName
    : identifier.occName;
  const signature = getTypeSignature(type);
  return `${name} :: ${signature}`;
}

function wordRangeToOccurrenceId(wordRange: vscode.Range): hce.OccurenceId {
  // Note that VSCode lines/columns are 0-based, and Haskell Code Explorer start at 1
  return [
    wordRange.start.line + 1,
    wordRange.start.character + 1,
    wordRange.end.character + 1
  ].join("-");
}

function isHaskellFile(document: vscode.TextDocument): boolean {
  if (document.uri.scheme === "file" && document.languageId === "haskell") {
    return true;
  }

  return false;
}

function getRelativeFilePath(
  document: vscode.TextDocument
): string | undefined {
  const folder = vscode.workspace.getWorkspaceFolder(document.uri);
  if (!folder) {
    return;
  }

  return document.uri.path.slice(folder.uri.path.length + 1);
}

function maybeFetchModuleInfo(document: vscode.TextDocument): void {
  if (!isHaskellFile(document)) {
    return;
  }

  if (globalState.haskellModules.has(document.uri.path)) {
    return;
  }

  fetchModuleInfo(document);
}

function fetchModuleInfo(document: vscode.TextDocument): void {
  const packageInfo = lookupPackageInfo(document);
  if (!packageInfo) {
    console.log(`Could not find Haskell package for ${document.uri.path}`);
    return;
  }

  fetchHaskellModule(packageInfo, document);
}

function lookupPackageInfo(
  document: vscode.TextDocument
): PackageInfo | undefined {
  const results = globalState.haskellPackages
    .map(p => ({
      packageInfo: p,
      // Compute what one would need to give Unix `cd` command to go from package base folder to Haskell module file
      relativePath: path.relative(p.packageFolder, document.uri.path)
    }))
    .filter(x => {
      // If need to go up one or more level to get to Haskell module, then not a parent folder
      return x.relativePath.indexOf("../") === -1;
    })
    .sort((a, b) => {
      // Closest package folder will be the one with the least path change required to get to Haskell module
      return a.relativePath.length - b.relativePath.length;
    });

  if (results.length > 0) {
    return results[0].packageInfo;
  }
}

function readPackageIdFromCabalFile(
  cabalFile: AbsoluteFilePath
): hce.PackageId | undefined {
  const contents = fs.readFileSync(cabalFile, "utf8");
  const packageId = getPackageIdFromCabalContents(contents);
  return packageId;
}

function getPackageIdFromCabalContents(
  cabalContents: string
): hce.PackageId | undefined {
  let name: string | undefined;
  let version: string | undefined;
  const lines = cabalContents.split(/\r?\n/);

  lines.forEach(line => {
    const matchName = line.match(/^name:\s+(.+)/);
    if (matchName && matchName.length >= 2) {
      name = matchName[1];
      return;
    }

    const matchVersion = line.match(/^version:\s+(.+)/);
    if (matchVersion && matchVersion.length >= 2) {
      version = matchVersion[1];
      return;
    }
  });

  if (name && version) {
    return {
      name: name,
      version: version
    };
  }
}

function loadPackagesInfo() {
  vscode.workspace.findFiles("**/*.cabal").then(uris => {
    uris = uris.filter(x => x.scheme === "file");
    const cabalFiles = uris.map(x => x.path);

    const packages: PackageInfo[] = [];
    cabalFiles.forEach(cabalFile => {
      const packageId = readPackageIdFromCabalFile(cabalFile);
      if (!packageId) {
        return;
      }

      packages.push({
        packageId: packageId,
        packageFolder: path.dirname(cabalFile)
      });
    });

    globalState.haskellPackages = packages;
  });
}

function getHceHost(): string {
  return (
    vscode.workspace.getConfiguration("haskellCodeExplorer").get("host") ||
    DEFAULT_HCE_HOST
  );
}

export function activate(context: vscode.ExtensionContext) {
  console.log('Extension "haskell-code-explorer" activated');

  context.subscriptions.push(
    vscode.languages.registerHoverProvider(HASKELL_MODE, new HceHoverProvider())
  );

  context.subscriptions.push(
    vscode.languages.registerDefinitionProvider(
      HASKELL_MODE,
      new HceDefinitionProvider()
    )
  );

  context.subscriptions.push(
    vscode.languages.registerReferenceProvider(
      HASKELL_MODE,
      new HceReferenceProvider()
    )
  );

  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument(maybeFetchModuleInfo)
  );

  // Get a head start by fetching module info for any Haskell files opened and
  // visible
  vscode.window.visibleTextEditors.forEach(editor =>
    maybeFetchModuleInfo(editor.document)
  );

  loadPackagesInfo();
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(loadPackagesInfo)
  );
}

export function deactivate() {}
