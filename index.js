const chdb = require("node-gyp-build")(__dirname);

function db(format, path) {
  this.format = format || "JSONCompact";
  this.path = path || ".";

  // add properties to this
  this.query = (query, format) => chdb.Execute(query, format || this.format);
  this.session = (query, format, path) => chdb.Session(query, format || this.format, path || this.path);

  return this;
}

module.exports = { chdb, db };
