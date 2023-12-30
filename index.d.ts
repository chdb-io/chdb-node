/**
 * Executes a query using the chdb addon.
 * 
 * @param query The query string to execute.
 * @param format The format for the query result, default is "CSV".
 * @returns The query result as a string.
 */
export function query(query: string, format?: string): string;

/**
 * Session class for managing queries and temporary paths.
 */
export class Session {
  /**
   * The path used for the session. This could be a temporary path or a provided path.
   */
  path: string;

  /**
   * Indicates whether the path is a temporary directory or not.
   */
  isTemp: boolean;

  /**
   * Creates a new session. If no path is provided, a temporary directory is created.
   * 
   * @param path Optional path for the session. If not provided, a temporary directory is used.
   */
  constructor(path?: string);

  /**
   * Executes a session-bound query.
   * 
   * @param query The query string to execute.
   * @param format The format for the query result, default is "CSV".
   * @returns The query result as a string.
   */
  query(query: string, format?: string): string;

  /**
   * Cleans up the session, deleting the temporary directory if one was created.
   */
  cleanup(): void;
}
