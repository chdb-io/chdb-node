const { query, Session } = require(".");

var result;

// Test standalone query
result = query("SELECT version(), 'Hello chDB', chdb()", "CSV");
console.log("Standalone Query Result:", result);

// Test session query
// Create a new session instance
const session = new Session("./chdb-node-tmp");
result = session.query("SELECT 123", "CSV")
console.log("Session Query Result:", result);
result = session.query("CREATE DATABASE IF NOT EXISTS testdb;" +
    "CREATE TABLE IF NOT EXISTS testdb.testtable (id UInt32) ENGINE = MergeTree() ORDER BY id;");

session.query("USE testdb; INSERT INTO testtable VALUES (1), (2), (3);")

result = session.query("SELECT * FROM testtable;")
console.log("Session Query Result:", result);


// Clean up the session
session.cleanup();
