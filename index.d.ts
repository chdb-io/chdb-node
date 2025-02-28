import { LocalChDB } from ".";

/**
 * Executes a query using the chdb addon.
 * 
 * @param query The query string to execute.
 * @param format The format for the query result, default is "CSV".
 * @returns The query result as a string.
 */
export function query(query: string, format?: string): string;


export function queryBuffer(query: string, format?: string): Buffer;

export class LocalResultV2Wrapper {
  /**
   * Retrieves the buffer containing the result data.
   * @returns A `Buffer` containing the query result.
   */
  getBuffer(): Buffer;

  /**
   * Retrieves the length of the buffer.
   * @returns The length of the buffer as a `number`.
   */
  getLength(): number;

  /**
   * Retrieves the elapsed time for the query execution.
   * @returns The elapsed time in seconds as a `number`.
   */
  getElapsed(): number;

  /**
   * Retrieves the number of rows read during the query execution.
   * @returns The number of rows read as a `number`.
   */
  getRowsRead(): number;

  /**
   * Retrieves the number of bytes read during the query execution.
   * @returns The number of bytes read as a `number`.
   */
  getBytesRead(): number;

  /**
   * Retrieves the error message, if any.
   * @returns The error message as a `string`, or `null` if no error occurred.
   */
  getErrorMessage(): string | null;
}


export class LocalChDB {
  conn: any;
  /**
 * The path used for the session. This could be a temporary path or a provided path.
 */
  path: string;

  /**
   * Indicates whether the path is a temporary directory or not.
   */
  isTemp: boolean;
  constructor(path?: string);
  query(query: string|Buffer, format?: string): LocalResultV2Wrapper;

}

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
  queryBuffer(query: string, format?: string): Buffer;

  /**
   * Cleans up the session, deleting the temporary directory if one was created.
   */
  cleanup(): void;
}
