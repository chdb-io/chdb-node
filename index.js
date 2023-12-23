const chdb = require("node-gyp-build")(__dirname);

function db(format, path) {
  this.format = format || "JSONCompact";
  this.path = path || ".";

  // add properties to this
  this.query = function (query, format) {
    return chdb.Execute(query, format || this.format);
  }.bind(this);

  this.session = function (query, format, path) {
    return chdb.Session(query, format || this.format, path || this.path);
  }.bind(this);

  return this;
}

module.exports = { chdb, db };
