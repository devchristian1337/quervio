// The package ships no types; only what src/lib/format-sql.ts uses.
declare module "poor-mans-t-sql-formatter" {
  export interface FormatOptions {
    indent?: string;
    uppercaseKeywords?: boolean;
    keywordStandardization?: boolean;
    trailingCommas?: boolean;
    spaceAfterExpandedComma?: boolean;
    expandInLists?: boolean;
    breakJoinOnSections?: boolean;
    maxLineWidth?: number;
    statementBreaks?: number;
    clauseBreaks?: number;
  }
  export function formatSql(sql: string, options?: FormatOptions): { text: string; errorFound: boolean };
}
