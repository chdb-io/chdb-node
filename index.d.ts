declare interface ChdbModule {
  Execute(query: string, format: string): string;
  Session(query: string, format: string, path: string): string;
}

declare const chdb: ChdbModule;

declare interface DB {
  format: string;
  path: string;
  query(query: string, format?: string): string;
  session(query: string, format?: string, path?: string): string;
}

declare interface DBFactory {
  (format?: string, path?: string): DB;
  new (format?: string, path?: string): DB;
}

declare const db: DBFactory;

export { chdb, db };
