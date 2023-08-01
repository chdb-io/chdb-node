const addon = require('.');
const db = new addon.db('CSV')
var result;

// Test query
result = db.query("SELECT version()");
console.log(result)

// Test session
db.session("CREATE FUNCTION IF NOT EXISTS hello AS () -> 'chDB'");
result = db.session("SELECT hello()", "TabSeparated");
console.log(result)
