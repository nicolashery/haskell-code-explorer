/*
 * This module contains TypeScript definitions for the parts of the Haskell Code
 * Explorer (HCE) server API that this extension uses. We don't try to be
 * exhaustive and translate only the what we need.
 */

export type ModuleInfo = {
  /** Information about each identifier in the module */
  identifiers: Map<InternalId, IntentifierInfo>;

  /** All occurrences of each identifier in the module */
  occurrences: Map<OccurenceId, IdentifierOccurrence>;
};

/**
 * Each Haskell identifier has an 'InternalId' that is unique within a single module
 */
export type InternalId = string;

export type ExternalId = string;

/**
 * An ID for an occurence, unique to a Haskell module, of the form
 * `lineNumber-startColumn-endColum`
 */
export type OccurenceId = string;

export type HaskellModulePath = string;

export type HaskellModuleName = string;

export type ComponentId = string;

/**
 * String representation of a version number (in this case for a Haskell
 * package), as described:
 * http://hackage.haskell.org/package/base/docs/Data-Version.html
 * Example: "0.1.0.0"
 */
export type Version = string;

export type HTML = string;

export type OccName = string;

/**
 * Haskell identifier (value or type)
 */
export type IntentifierInfo = {
  sort: NameSort;
  occName: OccName;
  demangledOccName: string;
  locationInfo: LocationInfo;
  idType: Type;
  externalId?: ExternalId;
};

export type NameSort = "External" | "Internal";

export type Type = {
  components: TypeComponent[];

  /** Components of a type with all type synonyms expanded */
  componentsExpanded?: TypeComponent[];
};

export type TypeComponent =
  | { tag: "Text"; contents: string }
  | { tag: "TyCon"; internalId: InternalId; name: string };

/**
 * Occurrence of an identifier in a source code
 */
export type IdentifierOccurrence = {
  internalId?: InternalId;
  isBinder: boolean;
  idOccType?: Type;
  sort: IdentifierOccurrenceSort;
};

export type IdentifierOccurrenceSort =
  | { tag: "ValueId" }
  | { tag: "TypeId" }
  | { tag: "ModuleId"; contents: LocationInfo };

export type LocationInfo =
  | {
      tag: "ExactLocation";
      packageId: PackageId;
      modulePath: HaskellModulePath;
      moduleName: HaskellModuleName;
      startLine: number;
      endLine: number;
      startColumn: number;
      endColumn: number;
    }
  | {
      tag: "ApproximateLocation";
      packageId: PackageId;
      moduleName: HaskellModuleName;
      entity: LocatableEntity;
      name: string;
      haddockAnchorId?: string;
      componentId: ComponentId;
    }
  | { tag: "UnknownLocation" };

export type PackageId = {
  name: string;
  version: Version;
};

export type DefinitionSite = {
  location: LocationInfo;
  doc?: HTML;
};

export type LocatableEntity = "Typ" | "Val" | "Inst" | "Mod";

export type HaskellModuleResponse = {
  identifiers: {
    [k: string]: IntentifierInfo;
  };
  occurrences: {
    [k: string]: IdentifierOccurrence;
  };
};

export type GlobalReferences = { count: number; packageId: string };

export type SourceFile = {
  name: string;
  references: ReferenceWithSource[];
};

export type ReferenceWithSource = {
  sourceCodeHtml: string;
  idSrcSpan: IdentifierSrcSpan;
};

export type IdentifierSrcSpan = {
  modulePath: HaskellModulePath;
  line: number;
  startColumn: number;
  endColumn: number;
};
