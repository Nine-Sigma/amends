/**
 * Phase-1 abridged shape of the §5.1 case_file. Everything here crosses the
 * ingest trust boundary (§8.1): values are untrusted data, never instructions.
 *
 * Tolerant reader: each interface carries an index signature because §5.1
 * fields Phase 1 does not model (related_occurrences, release.deployed_at,
 * release.diff_from_last_good, the interior of group.fingerprints) must be
 * preserved verbatim — never stripped, never rejected.
 */

export interface CaseFileGroup {
  /** §5.5 provisional/canonical/source_aliases structure; interior deliberately unmodeled in Phase 1. */
  fingerprints: Record<string, unknown>;
  occurrence_count: number;
  first_seen: string;
  last_seen: string;
  affected_revisions: string[];
  /** Open registry; conventional values: production, staging, preview, development. */
  environments: string[];
  [key: string]: unknown;
}

/**
 * Discriminated union on `status` — the one closed pair in the shape (§5.4).
 * `method` is an open registry; conventional values across PRD §5.1 and §11:
 * env_git_sha, tag_rule, mapping_file, provider_release, manual.
 * (The product PRD lists a different subset in each section — flagged upstream.)
 */
export type ReleaseResolution =
  | { status: 'resolved'; method: string; [key: string]: unknown }
  | { status: 'unresolved'; [key: string]: unknown };

export interface CaseFileRelease {
  declared: string;
  /** Resolved repo revision; null exactly when resolution.status is 'unresolved' (§5.4). */
  revision: string | null;
  resolution: ReleaseResolution;
  [key: string]: unknown;
}

export interface WorkItem {
  /** Open registry; conventional value: github_issue (§3.2). */
  kind: string;
  id: string;
  url: string;
  [key: string]: unknown;
}

export interface CaseFile {
  schema_version: string;
  group: CaseFileGroup;
  /** One capture_event occurrence selected by the compiler; opaque to Phase-1 parsing. */
  representative_occurrence: Record<string, unknown>;
  release: CaseFileRelease;
  work_item: WorkItem;
  /** Compiler-resolved repo paths to product intent files (§5.3). */
  intent_refs: string[];
  /** Evidence-gate hints (test command, artifact type candidates); absent in thin case files. */
  validation?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface ParseError {
  /** Dot-separated JSON path from the document root; '$' is the root itself. */
  path: string;
  reason: string;
}

export type ParseResult =
  | { ok: true; caseFile: CaseFile }
  | { ok: false; errors: ParseError[] };
